import BpmnModdle, { type ParseResult } from 'bpmn-moddle';
import type {
  BpmnValidationIssue,
  ValidationLevel,
  ValidationResult
} from '../types/index.js';

type SemanticElement = {
  element: any;
  ownerId: string;
  scopeId: string;
};

type FlowContainer = SemanticElement & {
  flowNodes: any[];
  sequenceFlows: any[];
  associations: any[];
};

type CollaborationContext = SemanticElement & {
  representedProcesses: Set<string>;
  associations: any[];
};

const VALIDATION_LEVELS = new Set<ValidationLevel>(['syntax', 'semantic', 'full']);

const EVENT_DEFINITION_RULES: Record<string, Set<string>> = {
  'bpmn:StartEvent': new Set([
    'bpmn:MessageEventDefinition',
    'bpmn:TimerEventDefinition',
    'bpmn:ConditionalEventDefinition',
    'bpmn:SignalEventDefinition',
    'bpmn:ErrorEventDefinition',
    'bpmn:EscalationEventDefinition',
    'bpmn:CompensateEventDefinition',
    'bpmn:MultipleEventDefinition',
    'bpmn:ParallelMultipleEventDefinition'
  ]),
  'bpmn:EndEvent': new Set([
    'bpmn:MessageEventDefinition',
    'bpmn:ErrorEventDefinition',
    'bpmn:EscalationEventDefinition',
    'bpmn:CancelEventDefinition',
    'bpmn:CompensateEventDefinition',
    'bpmn:SignalEventDefinition',
    'bpmn:TerminateEventDefinition',
    'bpmn:MultipleEventDefinition'
  ]),
  'bpmn:IntermediateCatchEvent': new Set([
    'bpmn:MessageEventDefinition',
    'bpmn:TimerEventDefinition',
    'bpmn:ConditionalEventDefinition',
    'bpmn:LinkEventDefinition',
    'bpmn:SignalEventDefinition',
    'bpmn:MultipleEventDefinition',
    'bpmn:ParallelMultipleEventDefinition'
  ]),
  'bpmn:IntermediateThrowEvent': new Set([
    'bpmn:MessageEventDefinition',
    'bpmn:EscalationEventDefinition',
    'bpmn:LinkEventDefinition',
    'bpmn:CompensateEventDefinition',
    'bpmn:SignalEventDefinition',
    'bpmn:MultipleEventDefinition'
  ]),
  'bpmn:BoundaryEvent': new Set([
    'bpmn:MessageEventDefinition',
    'bpmn:TimerEventDefinition',
    'bpmn:ConditionalEventDefinition',
    'bpmn:SignalEventDefinition',
    'bpmn:ErrorEventDefinition',
    'bpmn:EscalationEventDefinition',
    'bpmn:CancelEventDefinition',
    'bpmn:CompensateEventDefinition',
    'bpmn:MultipleEventDefinition',
    'bpmn:ParallelMultipleEventDefinition'
  ])
};

/**
 * Validates BPMN XML in three cumulative levels:
 * syntax parses XML and resolves references; semantic adds BPMN ownership and
 * element rules; full adds non-fatal executable-process profile guidance.
 */
export class BpmnValidator {
  private readonly moddle = new BpmnModdle();

  async validate(xml: string, level: ValidationLevel = 'full'): Promise<ValidationResult> {
    if (!VALIDATION_LEVELS.has(level)) {
      throw new Error(`Unsupported validation level: ${String(level)}`);
    }

    const issues: BpmnValidationIssue[] = [];
    let parseResult: ParseResult;
    try {
      parseResult = await this.moddle.fromXML(xml);
    } catch (error) {
      this.addIssue(issues, {
        code: 'BPMN_PARSE_ERROR',
        severity: 'error',
        message: 'BPMN XML could not be parsed'
      });
      return this.result(level, issues);
    }

    const unresolvedReferenceIds = new Set<string>();
    for (const reference of parseResult.references) {
      if (!Object.prototype.hasOwnProperty.call(parseResult.elementsById, reference.id)) {
        unresolvedReferenceIds.add(reference.id);
        this.addIssue(issues, {
          code: 'BPMN_UNRESOLVED_REFERENCE',
          severity: 'error',
          message: `Reference ${reference.id} cannot be resolved`,
          elementId: reference.element?.id
        });
      }
    }

    for (const warning of parseResult.warnings) {
      if (Array.from(unresolvedReferenceIds).some(id => warning.message.includes(`<${id}>`))) {
        continue;
      }
      this.addIssue(issues, {
        code: /unparsable content/i.test(warning.message)
          ? 'BPMN_UNPARSABLE_CONTENT'
          : 'BPMN_PARSE_WARNING',
        severity: /unparsable content/i.test(warning.message) ? 'error' : 'warning',
        message: warning.message.split('\n')[0]
      });
    }

    if (level === 'syntax' || issues.some(issue => issue.severity === 'error')) {
      return this.result(level, issues);
    }

    const definitions = parseResult.rootElement;
    if (!definitions || definitions.$type !== 'bpmn:Definitions') {
      this.addIssue(issues, {
        code: 'BPMN_INVALID_DEFINITIONS',
        severity: 'error',
        message: 'The document root must be bpmn:Definitions',
        elementId: definitions?.id
      });
      return this.result(level, issues);
    }

    const semanticById = new Map<string, SemanticElement>();
    const containers: FlowContainer[] = [];
    const collaborationContexts: CollaborationContext[] = [];
    const processes = (definitions.rootElements || []).filter(
      (root: any) => root.$type === 'bpmn:Process'
    );
    const collaborations = (definitions.rootElements || []).filter(
      (root: any) => root.$type === 'bpmn:Collaboration'
    );
    const processIds = new Set<string>(processes.map((process: any) => process.id));

    for (const process of processes) {
      this.indexFlowContainer(process, process.id, process.id, semanticById, containers);
    }
    for (const collaboration of collaborations) {
      const collaborationContext: CollaborationContext = {
        element: collaboration,
        ownerId: collaboration.id,
        scopeId: collaboration.id,
        representedProcesses: new Set<string>(),
        associations: []
      };
      collaborationContexts.push(collaborationContext);
      semanticById.set(collaboration.id, collaborationContext);
      for (const participant of collaboration.participants || []) {
        if (typeof participant.processRef?.id === 'string') {
          collaborationContext.representedProcesses.add(participant.processRef.id);
        }
        semanticById.set(participant.id, {
          element: participant,
          ownerId: collaboration.id,
          scopeId: collaboration.id
        });
      }
      for (const artifact of collaboration.artifacts || []) {
        if (artifact.$type === 'bpmn:Association') {
          collaborationContext.associations.push(artifact);
        }
        semanticById.set(artifact.id, {
          element: artifact,
          ownerId: collaboration.id,
          scopeId: collaboration.id
        });
      }
    }

    this.validateParticipants(collaborations, processIds, issues);
    this.validateSequenceFlows(containers, semanticById, issues);
    this.validateMessageFlows(collaborationContexts, semanticById, issues);
    this.validateAssociations(containers, collaborationContexts, semanticById, issues);
    this.validateEvents(containers, semanticById, issues);
    this.validateSubprocesses(containers, issues);
    this.validateLanes(containers, semanticById, issues);

    if (level === 'full') {
      this.validateExecutableProfile(processes, containers, issues);
    }

    return this.result(level, issues);
  }

  private indexFlowContainer(
    container: any,
    ownerId: string,
    scopeId: string,
    semanticById: Map<string, SemanticElement>,
    containers: FlowContainer[]
  ): void {
    const indexed: FlowContainer = {
      element: container,
      ownerId,
      scopeId,
      flowNodes: [],
      sequenceFlows: [],
      associations: []
    };
    containers.push(indexed);
    semanticById.set(container.id, { element: container, ownerId, scopeId });

    for (const item of container.flowElements || []) {
      semanticById.set(item.id, { element: item, ownerId, scopeId });
      if (item.$type === 'bpmn:SequenceFlow') {
        indexed.sequenceFlows.push(item);
      } else if (this.isInstance(item, 'bpmn:FlowNode')) {
        indexed.flowNodes.push(item);
        if (this.isInstance(item, 'bpmn:SubProcess')) {
          this.indexFlowContainer(item, ownerId, item.id, semanticById, containers);
        }
      }
    }
    for (const artifact of container.artifacts || []) {
      if (artifact.$type === 'bpmn:Association') {
        indexed.associations.push(artifact);
      }
      semanticById.set(artifact.id, { element: artifact, ownerId, scopeId });
    }
  }

  private validateParticipants(
    collaborations: any[],
    processIds: Set<string>,
    issues: BpmnValidationIssue[]
  ): void {
    for (const collaboration of collaborations) {
      const claimedProcesses = new Set<string>();
      for (const participant of collaboration.participants || []) {
        const processRef = participant.processRef?.id;
        if (!processRef) continue;
        if (!processIds.has(processRef)) {
          this.addIssue(issues, {
            code: 'BPMN_INVALID_PARTICIPANT_PROCESS_REF',
            severity: 'error',
            message: `Participant references missing process ${processRef}`,
            elementId: participant.id
          });
        } else if (claimedProcesses.has(processRef)) {
          this.addIssue(issues, {
            code: 'BPMN_DUPLICATE_PARTICIPANT_PROCESS',
            severity: 'error',
            message: `Process ${processRef} is represented more than once in the collaboration`,
            elementId: participant.id
          });
        }
        claimedProcesses.add(processRef);
      }
    }
  }

  private validateSequenceFlows(
    containers: FlowContainer[],
    semanticById: Map<string, SemanticElement>,
    issues: BpmnValidationIssue[]
  ): void {
    for (const container of containers) {
      for (const flow of container.sequenceFlows) {
        const source = semanticById.get(flow.sourceRef?.id);
        const target = semanticById.get(flow.targetRef?.id);
        if (!source || !target || !this.isInstance(source.element, 'bpmn:FlowNode')
          || !this.isInstance(target.element, 'bpmn:FlowNode')) {
          this.addIssue(issues, {
            code: 'BPMN_INVALID_SEQUENCE_FLOW_ENDPOINT',
            severity: 'error',
            message: 'Sequence flow endpoints must be BPMN flow nodes',
            elementId: flow.id
          });
          continue;
        }
        if (source.ownerId !== target.ownerId || source.ownerId !== container.ownerId) {
          this.addIssue(issues, {
            code: 'BPMN_CROSS_PROCESS_SEQUENCE_FLOW',
            severity: 'error',
            message: 'Sequence flow cannot cross process ownership boundaries',
            elementId: flow.id
          });
        }
        if (source.scopeId !== target.scopeId || source.scopeId !== container.scopeId) {
          this.addIssue(issues, {
            code: 'BPMN_CROSS_SCOPE_SEQUENCE_FLOW',
            severity: 'error',
            message: 'Sequence flow cannot cross process or subprocess scope boundaries',
            elementId: flow.id
          });
        }
      }
    }
  }

  private validateMessageFlows(
    collaborations: CollaborationContext[],
    semanticById: Map<string, SemanticElement>,
    issues: BpmnValidationIssue[]
  ): void {
    for (const collaboration of collaborations) {
      for (const flow of collaboration.element.messageFlows || []) {
        const source = semanticById.get(flow.sourceRef?.id);
        const target = semanticById.get(flow.targetRef?.id);
        if (!source || !target || !this.isInteractionNode(source.element)
          || !this.isInteractionNode(target.element)) {
          this.addIssue(issues, {
            code: 'BPMN_INVALID_MESSAGE_FLOW_ENDPOINT',
            severity: 'error',
            message: 'Message flow endpoints must be participants or flow nodes',
            elementId: flow.id
          });
          continue;
        }

        const sourceProcess = source.element.$type === 'bpmn:Participant'
          ? source.element.processRef?.id || source.element.id
          : source.ownerId;
        const targetProcess = target.element.$type === 'bpmn:Participant'
          ? target.element.processRef?.id || target.element.id
          : target.ownerId;
        if (sourceProcess === targetProcess) {
          this.addIssue(issues, {
            code: 'BPMN_SAME_PROCESS_MESSAGE_FLOW',
            severity: 'error',
            message: 'Message flow endpoints must belong to different participants',
            elementId: flow.id
          });
        }
        if (!this.belongsToCollaboration(source, collaboration)
          || !this.belongsToCollaboration(target, collaboration)) {
          this.addIssue(issues, {
            code: 'BPMN_MESSAGE_FLOW_OUTSIDE_COLLABORATION',
            severity: 'error',
            message: 'Message flow endpoints must belong to this collaboration',
            elementId: flow.id
          });
        }
      }
    }
  }

  private validateAssociations(
    containers: FlowContainer[],
    collaborations: CollaborationContext[],
    semanticById: Map<string, SemanticElement>,
    issues: BpmnValidationIssue[]
  ): void {
    for (const container of containers) {
      for (const association of container.associations) {
        const source = semanticById.get(association.sourceRef?.id);
        const target = semanticById.get(association.targetRef?.id);
        if (!source || !target || source.ownerId !== container.ownerId
          || target.ownerId !== container.ownerId) {
          this.addIssue(issues, {
            code: 'BPMN_ASSOCIATION_OUTSIDE_OWNER',
            severity: 'error',
            message: 'Association endpoints must belong to the containing process',
            elementId: association.id
          });
        }
      }
    }
    for (const collaboration of collaborations) {
      for (const association of collaboration.associations) {
        const source = semanticById.get(association.sourceRef?.id);
        const target = semanticById.get(association.targetRef?.id);
        if (!source || !target || !this.belongsToCollaboration(source, collaboration)
          || !this.belongsToCollaboration(target, collaboration)) {
          this.addIssue(issues, {
            code: 'BPMN_ASSOCIATION_OUTSIDE_OWNER',
            severity: 'error',
            message: 'Association endpoints must belong to the containing collaboration',
            elementId: association.id
          });
        }
      }
    }
  }

  private validateEvents(
    containers: FlowContainer[],
    semanticById: Map<string, SemanticElement>,
    issues: BpmnValidationIssue[]
  ): void {
    const incoming = new Map<string, any[]>();
    const outgoing = new Map<string, any[]>();
    for (const container of containers) {
      for (const flow of container.sequenceFlows) {
        this.append(outgoing, flow.sourceRef?.id, flow);
        this.append(incoming, flow.targetRef?.id, flow);
      }
    }

    for (const container of containers) {
      for (const event of container.flowNodes.filter(node => this.isInstance(node, 'bpmn:Event'))) {
        const definitions = event.eventDefinitions || [];
        const allowedDefinitions = EVENT_DEFINITION_RULES[event.$type];
        if (definitions.length > 1 || (allowedDefinitions
          && definitions.some((definition: any) => !allowedDefinitions.has(definition.$type)))) {
          this.addIssue(issues, {
            code: 'BPMN_INVALID_EVENT_DEFINITION',
            severity: 'error',
            message: `${event.$type} has an invalid event definition combination`,
            elementId: event.id
          });
        }
        if (event.$type === 'bpmn:StartEvent' && !this.hasValidStartEventContext(event, container)) {
          this.addIssue(issues, {
            code: 'BPMN_INVALID_EVENT_DEFINITION',
            severity: 'error',
            message: `${event.$type} has an invalid event definition combination`,
            elementId: event.id
          });
        }
        if (event.$type === 'bpmn:StartEvent' && (incoming.get(event.id)?.length || 0) > 0) {
          this.addIssue(issues, {
            code: 'BPMN_START_EVENT_HAS_INCOMING_FLOW',
            severity: 'error',
            message: 'Start events cannot have incoming sequence flows',
            elementId: event.id
          });
        }
        if (event.$type === 'bpmn:EndEvent' && (outgoing.get(event.id)?.length || 0) > 0) {
          this.addIssue(issues, {
            code: 'BPMN_END_EVENT_HAS_OUTGOING_FLOW',
            severity: 'error',
            message: 'End events cannot have outgoing sequence flows',
            elementId: event.id
          });
        }
        if (event.$type === 'bpmn:BoundaryEvent') {
          const attached = semanticById.get(event.attachedToRef?.id);
          if (!attached || !this.isInstance(attached.element, 'bpmn:Activity')
            || !container.flowNodes.includes(attached.element)) {
            this.addIssue(issues, {
              code: 'BPMN_INVALID_BOUNDARY_ATTACHMENT',
              severity: 'error',
              message: 'Boundary event must attach to an activity in the same scope',
              elementId: event.id
            });
          }
          const definitionType = event.eventDefinitions?.[0]?.$type;
          if (definitionType === 'bpmn:CancelEventDefinition'
            && attached?.element.$type !== 'bpmn:Transaction') {
            this.addIssue(issues, {
              code: 'BPMN_INVALID_BOUNDARY_ATTACHMENT',
              severity: 'error',
              message: 'A cancel boundary event must attach to a transaction',
              elementId: event.id
            });
          }
          if (definitionType === 'bpmn:CompensateEventDefinition'
            && event.cancelActivity !== false) {
            this.addIssue(issues, {
              code: 'BPMN_INVALID_BOUNDARY_INTERRUPTION',
              severity: 'error',
              message: 'A compensation boundary event must be non-interrupting',
              elementId: event.id
            });
          }
          if (definitionType === 'bpmn:CancelEventDefinition'
            && event.cancelActivity === false) {
            this.addIssue(issues, {
              code: 'BPMN_INVALID_BOUNDARY_INTERRUPTION',
              severity: 'error',
              message: 'A cancel boundary event must be interrupting',
              elementId: event.id
            });
          }
          if ((incoming.get(event.id)?.length || 0) > 0) {
            this.addIssue(issues, {
              code: 'BPMN_BOUNDARY_EVENT_HAS_INCOMING_FLOW',
              severity: 'error',
              message: 'Boundary events cannot have incoming sequence flows',
              elementId: event.id
            });
          }
        }
      }
    }
  }

  private validateSubprocesses(containers: FlowContainer[], issues: BpmnValidationIssue[]): void {
    for (const container of containers) {
      const subprocess = container.element;
      if (subprocess.$type !== 'bpmn:SubProcess' || subprocess.triggeredByEvent !== true) continue;
      const parent = containers.find(candidate => candidate.scopeId !== container.scopeId
        && candidate.flowNodes.includes(subprocess));
      const hasBoundaryFlow = parent?.sequenceFlows.some(
        flow => flow.sourceRef?.id === subprocess.id || flow.targetRef?.id === subprocess.id
      );
      if (hasBoundaryFlow) {
        this.addIssue(issues, {
          code: 'BPMN_EVENT_SUBPROCESS_HAS_SEQUENCE_FLOW',
          severity: 'error',
          message: 'Event subprocesses cannot have incoming or outgoing sequence flows',
          elementId: subprocess.id
        });
      }
      const starts = container.flowNodes.filter(node => node.$type === 'bpmn:StartEvent');
      if (starts.length === 0 || starts.some(start => (start.eventDefinitions || []).length === 0)) {
        this.addIssue(issues, {
          code: 'BPMN_INVALID_EVENT_SUBPROCESS_START',
          severity: 'error',
          message: 'Event subprocesses require an event-defined start event',
          elementId: subprocess.id
        });
      }
    }
  }

  private validateLanes(
    containers: FlowContainer[],
    semanticById: Map<string, SemanticElement>,
    issues: BpmnValidationIssue[]
  ): void {
    for (const container of containers) {
      for (const laneSet of container.element.laneSets || []) {
        this.validateLaneSet(laneSet, container, semanticById, issues);
      }
    }
  }

  private validateLaneSet(
    laneSet: any,
    container: FlowContainer,
    semanticById: Map<string, SemanticElement>,
    issues: BpmnValidationIssue[]
  ): void {
    const assigned = new Set<string>();
    for (const lane of laneSet.lanes || []) {
      for (const reference of lane.flowNodeRef || []) {
        const indexed = semanticById.get(reference.id);
        if (!indexed || indexed.ownerId !== container.ownerId || indexed.scopeId !== container.scopeId
          || !container.flowNodes.includes(indexed.element)) {
          this.addIssue(issues, {
            code: 'BPMN_INVALID_LANE_REFERENCE',
            severity: 'error',
            message: 'Lane may reference only flow nodes in its containing scope',
            elementId: lane.id
          });
        } else if (assigned.has(reference.id)) {
          this.addIssue(issues, {
            code: 'BPMN_DUPLICATE_LANE_ASSIGNMENT',
            severity: 'error',
            message: `Flow node ${reference.id} is assigned to multiple lanes`,
            elementId: lane.id
          });
        }
        assigned.add(reference.id);
      }
      if (lane.childLaneSet) {
        this.validateLaneSet(lane.childLaneSet, container, semanticById, issues);
      }
    }
  }

  private validateExecutableProfile(
    processes: any[],
    containers: FlowContainer[],
    issues: BpmnValidationIssue[]
  ): void {
    const executableOwners = new Set(
      processes.filter(process => process.isExecutable === true).map(process => process.id)
    );
    for (const container of containers.filter(item => executableOwners.has(item.ownerId))) {
      const incoming = new Set(container.sequenceFlows.map(flow => flow.targetRef?.id));
      const outgoing = new Set(container.sequenceFlows.map(flow => flow.sourceRef?.id));
      const starts = container.flowNodes.filter(node => node.$type === 'bpmn:StartEvent');
      const ends = container.flowNodes.filter(node => node.$type === 'bpmn:EndEvent');
      if (starts.length === 0) {
        this.addIssue(issues, {
          code: 'BPMN_PROFILE_MISSING_START_EVENT',
          severity: 'warning',
          message: 'Executable flow scope should have a start event',
          elementId: container.element.id
        });
      }
      if (ends.length === 0) {
        this.addIssue(issues, {
          code: 'BPMN_PROFILE_MISSING_END_EVENT',
          severity: 'warning',
          message: 'Executable flow scope should have an end event',
          elementId: container.element.id
        });
      }
      for (const node of container.flowNodes) {
        if (!incoming.has(node.id)
          && !['bpmn:StartEvent', 'bpmn:BoundaryEvent'].includes(node.$type)) {
          this.addIssue(issues, {
            code: 'BPMN_PROFILE_MISSING_INCOMING_FLOW',
            severity: 'warning',
            message: 'Flow node should have an incoming sequence flow',
            elementId: node.id
          });
        }
        if (!outgoing.has(node.id) && node.$type !== 'bpmn:EndEvent') {
          this.addIssue(issues, {
            code: 'BPMN_PROFILE_MISSING_OUTGOING_FLOW',
            severity: 'warning',
            message: 'Flow node should have an outgoing sequence flow',
            elementId: node.id
          });
        }
      }
    }
  }

  private isInstance(element: any, type: string): boolean {
    return typeof element?.$instanceOf === 'function' && element.$instanceOf(type);
  }

  private isInteractionNode(element: any): boolean {
    return element?.$type === 'bpmn:Participant' || this.isInstance(element, 'bpmn:FlowNode');
  }

  private belongsToCollaboration(
    indexed: SemanticElement,
    collaboration: CollaborationContext
  ): boolean {
    return indexed.element.$type === 'bpmn:Participant'
      ? indexed.ownerId === collaboration.ownerId
      : indexed.ownerId === collaboration.ownerId
        || collaboration.representedProcesses.has(indexed.ownerId);
  }

  private hasValidStartEventContext(event: any, container: FlowContainer): boolean {
    const definitionTypes = new Set<string>(
      (event.eventDefinitions || []).map((definition: any) => definition.$type)
    );
    if (container.element.$type === 'bpmn:Process') {
      return !['bpmn:ErrorEventDefinition', 'bpmn:EscalationEventDefinition',
        'bpmn:CompensateEventDefinition'].some(type => definitionTypes.has(type));
    }
    if (container.element.triggeredByEvent === true) {
      return definitionTypes.size > 0;
    }
    return definitionTypes.size === 0;
  }

  private append(map: Map<string, any[]>, id: unknown, value: any): void {
    if (typeof id !== 'string') return;
    const values = map.get(id) || [];
    values.push(value);
    map.set(id, values);
  }

  private addIssue(issues: BpmnValidationIssue[], issue: BpmnValidationIssue): void {
    const key = `${issue.code}:${issue.elementId || ''}:${issue.message}`;
    if (!issues.some(existing => `${existing.code}:${existing.elementId || ''}:${existing.message}` === key)) {
      issues.push(issue);
    }
  }

  private result(level: ValidationLevel, issues: BpmnValidationIssue[]): ValidationResult {
    const ordered = [...issues].sort((left, right) =>
      left.code.localeCompare(right.code)
      || (left.elementId || '').localeCompare(right.elementId || '')
      || left.message.localeCompare(right.message)
    );
    const errors = ordered.filter(
      (issue): issue is BpmnValidationIssue & { severity: 'error' } => issue.severity === 'error'
    );
    const warnings = ordered.filter(
      (issue): issue is BpmnValidationIssue & { severity: 'warning' } => issue.severity === 'warning'
    );
    const valid = errors.length === 0;
    return {
      level,
      valid,
      issues: ordered,
      errors,
      warnings,
      summary: `Validation ${valid ? 'passed' : 'failed'}: ${errors.length} errors, ${warnings.length} warnings`
    };
  }
}
