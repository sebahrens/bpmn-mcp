import BpmnModdle from 'bpmn-moddle';
import camundaDescriptor from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };
import type { BpmnImportLimits } from '../config/index.js';
import {
  BPMN_ARTIFACT_TYPES,
  BPMN_CONNECTION_TYPES,
  BPMN_FLOW_NODE_TYPES,
  BpmnArtifactElement,
  BpmnArtifactType,
  BpmnConnectionType,
  BpmnDataObject,
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnDocumentElement,
  BpmnElementType,
  BpmnExtensionProfile,
  BpmnFlowNodeElement,
  BpmnFlowNodeType,
  BpmnLane,
  BpmnLoopExpression,
  BpmnMultiInstanceLoopCharacteristics,
  BpmnParticipantElement,
  EventDefinitionPayload,
  EventDefinitionReference,
  EventDefinitionType,
  Position,
  ProcessContext,
  Size
} from '../types/index.js';
import {
  assertBpmnId,
  assertBpmnXmlIdentifiers,
  bpmnModdleIdPath,
  invalidBpmnIdMessage,
  isBpmnId,
  isBpmnQName,
  parseBpmnXml
} from '../utils/BpmnId.js';

export { isBpmnId, isBpmnQName };

const TARGET_NAMESPACE = 'http://bpmn.io/schema/bpmn';
const CAMUNDA_7_NAMESPACE = 'http://camunda.org/schema/1.0/bpmn';

const EVENT_DEFINITION_TYPES: Record<EventDefinitionType, string> = {
  message: 'bpmn:MessageEventDefinition',
  timer: 'bpmn:TimerEventDefinition',
  error: 'bpmn:ErrorEventDefinition',
  signal: 'bpmn:SignalEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition',
  escalation: 'bpmn:EscalationEventDefinition',
  compensation: 'bpmn:CompensateEventDefinition',
  cancel: 'bpmn:CancelEventDefinition',
  terminate: 'bpmn:TerminateEventDefinition'
};

const EVENT_DEFINITION_RULES: Partial<Record<BpmnFlowNodeType, ReadonlySet<EventDefinitionType>>> = {
  'bpmn:StartEvent': new Set(['message', 'timer', 'conditional', 'signal']),
  'bpmn:EndEvent': new Set([
    'message', 'error', 'escalation', 'cancel', 'compensation', 'signal', 'terminate'
  ]),
  'bpmn:IntermediateCatchEvent': new Set(['message', 'timer', 'conditional', 'signal']),
  'bpmn:IntermediateThrowEvent': new Set(['message', 'escalation', 'compensation', 'signal']),
  'bpmn:BoundaryEvent': new Set([
    'message', 'timer', 'conditional', 'signal', 'error', 'escalation', 'cancel', 'compensation'
  ])
};

const ROOT_EVENT_DEFINITION_TYPES: Partial<Record<EventDefinitionType, string>> = {
  message: 'bpmn:Message',
  signal: 'bpmn:Signal',
  error: 'bpmn:Error',
  escalation: 'bpmn:Escalation'
};

const ROOT_EVENT_REFERENCE_PROPERTIES: Partial<Record<EventDefinitionType, string>> = {
  message: 'messageRef',
  signal: 'signalRef',
  error: 'errorRef',
  escalation: 'escalationRef'
};

const FLOW_NODE_TYPES = new Set<string>(BPMN_FLOW_NODE_TYPES);
const INTERACTION_NODE_TYPES = new Set<string>([
  'bpmn:Participant',
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:IntermediateThrowEvent',
  'bpmn:IntermediateCatchEvent',
  'bpmn:BoundaryEvent',
  'bpmn:Task',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ScriptTask',
  'bpmn:BusinessRuleTask',
  'bpmn:ManualTask',
  'bpmn:ReceiveTask',
  'bpmn:SendTask',
  'bpmn:SubProcess',
  'bpmn:Transaction',
  'bpmn:CallActivity'
]);
const ARTIFACT_TYPES = new Set<string>(BPMN_ARTIFACT_TYPES);
const CONNECTION_TYPES = new Set<string>(BPMN_CONNECTION_TYPES);
const CONTAINED_ARTIFACT_TYPES = new Set<BpmnArtifactType>([
  'bpmn:TextAnnotation',
  'bpmn:Group'
]);

export function isBpmnFlowNodeType(type: string): type is BpmnFlowNodeType {
  return FLOW_NODE_TYPES.has(type);
}

/** Types that inherit BPMN InteractionNode: Participant, Event, or Activity. */
export function isBpmnInteractionNodeType(type: string): boolean {
  return INTERACTION_NODE_TYPES.has(type);
}

/** Test moddle inheritance without broadening InteractionNode to every FlowNode. */
export function isBpmnInteractionNode(element: any): boolean {
  return typeof element?.$instanceOf === 'function'
    && element.$instanceOf('bpmn:InteractionNode');
}

export function isBpmnArtifactType(type: string): type is BpmnArtifactType {
  return ARTIFACT_TYPES.has(type);
}

export function isBpmnConnectionType(type: string): type is BpmnConnectionType {
  return CONNECTION_TYPES.has(type);
}

export function isBpmnElementType(type: string): type is BpmnElementType {
  return type === 'bpmn:Participant' || isBpmnFlowNodeType(type) || isBpmnArtifactType(type);
}

export function isSupportedEventDefinitionType(type: string): type is EventDefinitionType {
  return Object.prototype.hasOwnProperty.call(EVENT_DEFINITION_TYPES, type);
}

export function supportsEventDefinition(
  eventType: BpmnFlowNodeType,
  definitionType: EventDefinitionType
): boolean {
  return EVENT_DEFINITION_RULES[eventType]?.has(definitionType) === true;
}

export function supportsConditionalOutgoingFlow(element: BpmnDocumentElement): boolean {
  return element.kind === 'flowNode' && (
    /Task$/.test(element.type)
    || ['bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:CallActivity', 'bpmn:ExclusiveGateway',
      'bpmn:InclusiveGateway', 'bpmn:ComplexGateway'].includes(element.type)
  );
}

function isFlowContainerType(type: string): boolean {
  return type === 'bpmn:SubProcess' || type === 'bpmn:Transaction';
}

function assertParsedBpmnIds(elementsById: Record<string, any>): void {
  const visited = new Set<object>();
  for (const element of Object.values(elementsById)) {
    if (!element || typeof element !== 'object' || visited.has(element)) continue;
    visited.add(element);
    if (!isBpmnId(element.id)) {
      throw new Error(invalidBpmnIdMessage(element.id, bpmnModdleIdPath(element)));
    }
  }
}

function assertBpmnDocumentIds(document: BpmnDocument, includeDi: boolean): void {
  const seen = new Map<string, { identity: string; path: string }>();
  const add = (value: unknown, path: string, identity = path): void => {
    assertBpmnId(value, path);
    const previous = seen.get(value);
    if (!previous) {
      seen.set(value, { identity, path });
    } else if (previous.identity !== identity) {
      throw new Error(
        `Duplicate BPMN xsd:ID at ${path}: ${JSON.stringify(value)} is already used at ${previous.path}`
      );
    }
  };
  const reference = (value: unknown, path: string): void => assertBpmnId(value, path);
  const keyedPath = (collection: string, key: string, property = 'id'): string =>
    `${collection}[${JSON.stringify(key)}].${property}`;

  add(document.definitionsId, 'definitions.id');
  for (const [key, process] of document.processes) {
    add(process.id, keyedPath('processes', key));
  }
  for (const [key, collaboration] of document.collaborations) {
    add(collaboration.id, keyedPath('collaborations', key));
  }
  for (const itemDefinitionId of document.itemDefinitions) {
    add(itemDefinitionId, keyedPath('itemDefinitions', itemDefinitionId));
  }
  for (const [key, dataObject] of document.dataObjects) {
    add(dataObject.id, keyedPath('dataObjects', key));
    reference(dataObject.ownerId, keyedPath('dataObjects', key, 'ownerId'));
    reference(dataObject.scopeId, keyedPath('dataObjects', key, 'scopeId'));
    if (dataObject.itemSubjectRef !== undefined && dataObject.itemSubjectRef !== null) {
      reference(dataObject.itemSubjectRef, keyedPath('dataObjects', key, 'itemSubjectRef'));
    }
  }
  for (const [key, laneSet] of document.laneSets) {
    add(laneSet.id, keyedPath('laneSets', key));
    reference(laneSet.processId, keyedPath('laneSets', key, 'processId'));
    if (laneSet.parentLaneId !== undefined && laneSet.parentLaneId !== null) {
      reference(laneSet.parentLaneId, keyedPath('laneSets', key, 'parentLaneId'));
    }
    laneSet.laneIds.forEach((laneId, index) => {
      reference(laneId, `${keyedPath('laneSets', key, 'laneIds')}[${index}]`);
    });
  }
  for (const [key, lane] of document.lanes) {
    add(lane.id, keyedPath('lanes', key));
    reference(lane.processId, keyedPath('lanes', key, 'processId'));
    reference(lane.laneSetId, keyedPath('lanes', key, 'laneSetId'));
    lane.flowNodeRefs.forEach((flowNodeId, index) => {
      reference(flowNodeId, `${keyedPath('lanes', key, 'flowNodeRefs')}[${index}]`);
    });
  }
  for (const [key, element] of document.elements) {
    add(element.id, keyedPath('elements', key));
    reference(element.ownerId, keyedPath('elements', key, 'ownerId'));
    reference(element.scopeId, keyedPath('elements', key, 'scopeId'));
    if (element.kind === 'participant'
      && element.processRef !== undefined && element.processRef !== null) {
      reference(element.processRef, keyedPath('elements', key, 'processRef'));
    }
    if (element.kind === 'flowNode'
      && element.defaultFlow !== undefined && element.defaultFlow !== null) {
      reference(element.defaultFlow, keyedPath('elements', key, 'defaultFlow'));
    }
    for (const property of ['attachTo', 'dataObjectRef', 'itemSubjectRef'] as const) {
      const value = element.properties[property];
      if (value !== undefined && value !== null) {
        reference(value, keyedPath('elements', key, `properties.${property}`));
      }
    }
    const multiInstance = element.properties.multiInstance;
    if (multiInstance && typeof multiInstance === 'object' && !Array.isArray(multiInstance)) {
      for (const property of ['loopDataInputRef', 'loopDataOutputRef'] as const) {
        const value = (multiInstance as Record<string, unknown>)[property];
        if (value !== undefined) {
          reference(
            value,
            keyedPath('elements', key, `properties.multiInstance.${property}`)
          );
        }
      }
    }

    const payload = element.properties.eventDefinitionPayload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const eventPayload = payload as EventDefinitionPayload;
      if (eventPayload.definitionId !== undefined) {
        add(
          eventPayload.definitionId,
          keyedPath('elements', key, 'properties.eventDefinitionPayload.definitionId')
        );
      }
      if (eventPayload.reference?.id !== undefined) {
        const definitionType = String(element.properties.eventDefinition || 'unknown');
        add(
          eventPayload.reference.id,
          keyedPath('elements', key, 'properties.eventDefinitionPayload.reference.id'),
          `event-root:${definitionType}:${eventPayload.reference.id}`
        );
      }
      if (eventPayload.activityRef !== undefined) {
        reference(
          eventPayload.activityRef,
          keyedPath('elements', key, 'properties.eventDefinitionPayload.activityRef')
        );
      }
    }
  }
  for (const [key, connection] of document.connections) {
    add(connection.id, keyedPath('connections', key));
    reference(connection.source, keyedPath('connections', key, 'source'));
    reference(connection.target, keyedPath('connections', key, 'target'));
    reference(connection.ownerId, keyedPath('connections', key, 'ownerId'));
    reference(connection.scopeId, keyedPath('connections', key, 'scopeId'));
    if (connection.condition?.evaluatesToTypeRef !== undefined
      && connection.condition.evaluatesToTypeRef !== null) {
      reference(
        connection.condition.evaluatesToTypeRef,
        keyedPath('connections', key, 'condition.evaluatesToTypeRef')
      );
    }
  }

  add(document.diagram.id, 'diagram.id');
  add(document.diagram.planeId, 'diagram.planeId');
  reference(document.diagram.planeElementId, 'diagram.planeElementId');
  if (!includeDi) return;

  for (const [key, shape] of document.diagram.shapes) {
    add(shape.id, keyedPath('diagram.shapes', key));
    reference(shape.elementId, keyedPath('diagram.shapes', key, 'elementId'));
  }
  for (const [key, edge] of document.diagram.edges) {
    add(edge.id, keyedPath('diagram.edges', key));
    reference(edge.connectionId, keyedPath('diagram.edges', key, 'connectionId'));
  }
}

/**
 * Resolve and validate the participant boundary represented by a message-flow
 * endpoint. Flow nodes inherit that boundary from the participant whose
 * processRef matches their process owner; participant endpoints identify it
 * directly. Artifacts are not BPMN interaction nodes.
 */
export function resolveMessageFlowParticipant(
  document: BpmnDocument,
  collaborationId: string,
  endpoint: BpmnDocumentElement
): BpmnParticipantElement {
  if (!isBpmnInteractionNodeType(endpoint.type)) {
    throw new Error(`Message flow endpoint ${endpoint.id} is not a BPMN interaction node`);
  }
  if (endpoint.kind === 'participant') {
    if (endpoint.ownerId !== collaborationId) {
      throw new Error(`Message flow endpoint ${endpoint.id} belongs to another collaboration`);
    }
    return endpoint;
  }

  const participants = Array.from(document.elements.values()).filter(
    (candidate): candidate is BpmnParticipantElement => candidate.kind === 'participant'
      && candidate.ownerId === collaborationId
      && candidate.processRef === endpoint.ownerId
  );
  if (participants.length === 0) {
    throw new Error(`Message flow endpoint ${endpoint.id} is not owned by a collaboration participant`);
  }
  if (participants.length > 1) {
    throw new Error(`Message flow endpoint ${endpoint.id} has ambiguous participant ownership`);
  }
  return participants[0];
}

export function assertValidMessageFlowEndpoints(
  document: BpmnDocument,
  collaborationId: string,
  source: BpmnDocumentElement,
  target: BpmnDocumentElement
): void {
  const sourceParticipant = resolveMessageFlowParticipant(document, collaborationId, source);
  const targetParticipant = resolveMessageFlowParticipant(document, collaborationId, target);
  if (sourceParticipant.id === targetParticipant.id) {
    throw new Error('Message flows must cross participant boundaries');
  }
}

export function getDefaultElementSize(type: BpmnElementType): Size {
  if (type === 'bpmn:Participant') {
    return { width: 600, height: 250 };
  }
  if (type.includes('Gateway')) {
    return { width: 50, height: 50 };
  }
  if (type.includes('Event')) {
    return { width: 36, height: 36 };
  }
  if (type === 'bpmn:DataObjectReference' || type === 'bpmn:DataStoreReference') {
    return { width: 36, height: 50 };
  }
  if (type === 'bpmn:TextAnnotation') {
    return { width: 100, height: 30 };
  }
  if (type === 'bpmn:Group') {
    return { width: 300, height: 200 };
  }
  if (isFlowContainerType(type)) {
    return { width: 350, height: 200 };
  }
  return { width: 100, height: 80 };
}

export function createBpmnDocument(
  rootId: string,
  name: string,
  type: 'process' | 'collaboration',
  extensionProfile: BpmnExtensionProfile = 'portable'
): BpmnDocument {
  assertBpmnId(rootId, `${type}.id`);
  const document: BpmnDocument = {
    definitionsId: `Definitions_${rootId}`,
    targetNamespace: TARGET_NAMESPACE,
    extensionProfile,
    sourceIds: new Set(),
    managedIds: new Set(),
    processes: new Map(),
    collaborations: new Map(),
    laneSets: new Map(),
    lanes: new Map(),
    itemDefinitions: new Set(),
    dataObjects: new Map(),
    elements: new Map(),
    connections: new Map(),
    diagram: {
      id: `BPMNDiagram_${rootId}`,
      planeId: `BPMNPlane_${rootId}`,
      planeElementId: rootId,
      shapes: new Map(),
      edges: new Map()
    }
  };

  if (type === 'process') {
    document.processes.set(rootId, { id: rootId, name, isExecutable: true });
  } else {
    document.collaborations.set(rootId, { id: rootId, name });
  }

  return document;
}

export function createProcessContext(
  rootId: string,
  name: string,
  type: 'process' | 'collaboration',
  extensionProfile: BpmnExtensionProfile = 'portable'
): ProcessContext {
  const document = createBpmnDocument(rootId, name, type, extensionProfile);
  return {
    id: rootId,
    name,
    type,
    extensionProfile,
    document,
    elements: document.elements,
    connections: document.connections,
    xml: '',
    mutationVersion: 0,
    revision: ''
  };
}

export function calculateConnectionWaypoints(
  source: BpmnDocumentElement,
  target: BpmnDocumentElement
): Position[] {
  return [
    {
      x: source.position.x + source.size.width,
      y: source.position.y + source.size.height / 2
    },
    {
      x: target.position.x,
      y: target.position.y + target.size.height / 2
    }
  ];
}

/**
 * Associations are artifacts owned by the nearest flow/collaboration
 * container shared by both endpoints. Endpoints in different process owners
 * have no legal shared artifact container and must be rejected.
 */
export function resolveAssociationOwnership(
  document: BpmnDocument,
  source: BpmnDocumentElement,
  target: BpmnDocumentElement
): { ownerId: string; scopeId: string } {
  if (source.ownerId !== target.ownerId) {
    throw new Error('Associations cannot cross process ownership boundaries');
  }

  const sourceScopes = associationContainerChain(document, source);
  const targetScopes = new Set(associationContainerChain(document, target));
  const scopeId = sourceScopes.find(candidate => targetScopes.has(candidate));
  if (!scopeId) {
    throw new Error('Association endpoints do not share a compatible containing scope');
  }
  return { ownerId: source.ownerId, scopeId };
}

function associationContainerChain(
  document: BpmnDocument,
  endpoint: BpmnDocumentElement
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let scopeId = isFlowContainerType(endpoint.type) ? endpoint.id : endpoint.scopeId;

  while (!visited.has(scopeId)) {
    visited.add(scopeId);
    chain.push(scopeId);
    if (scopeId === endpoint.ownerId) return chain;

    const container = document.elements.get(scopeId);
    if (!container || container.ownerId !== endpoint.ownerId
      || !isFlowContainerType(container.type)) {
      throw new Error(`Association endpoint ${endpoint.id} has invalid containing scope ${scopeId}`);
    }
    scopeId = container.scopeId;
  }

  throw new Error(`Association endpoint ${endpoint.id} has cyclic containing scope ${scopeId}`);
}

export function synchronizeDiagramInterchange(
  document: BpmnDocument,
  createMissingForImportedElements = true
): void {
  const shapesByElement = new Map(
    Array.from(document.diagram.shapes.values(), shape => [shape.elementId, shape])
  );
  const shapeIds = new Set<string>();
  for (const element of [...document.elements.values(), ...document.lanes.values()]) {
    const existing = shapesByElement.get(element.id);
    if (!existing && !createMissingForImportedElements && document.sourceIds?.has(element.id)) {
      continue;
    }
    const shapeId = existing?.id || `${element.id}_di`;
    shapeIds.add(shapeId);
    document.diagram.shapes.set(shapeId, {
      id: shapeId,
      elementId: element.id,
      bounds: {
        x: element.position.x,
        y: element.position.y,
        width: element.size.width,
        height: element.size.height
      },
      labelBounds: existing?.labelBounds ? { ...existing.labelBounds } : undefined,
      labelBoundsCleared: existing?.labelBoundsCleared,
      isHorizontal: existing?.isHorizontal
        ?? ('kind' in element && element.kind === 'participant' ? true : undefined),
      isExpanded: 'kind' in element && isFlowContainerType(element.type)
        ? element.properties.isExpanded === true
        : existing?.isExpanded
    });
  }

  for (const shapeId of document.diagram.shapes.keys()) {
    if (!shapeIds.has(shapeId)) {
      document.diagram.shapes.delete(shapeId);
    }
  }

  const edgesByConnection = new Map(
    Array.from(document.diagram.edges.values(), edge => [edge.connectionId, edge])
  );
  const edgeIds = new Set<string>();
  for (const connection of document.connections.values()) {
    const source = document.elements.get(connection.source);
    const target = document.elements.get(connection.target);
    if (!source || !target) {
      throw new Error(`Connection ${connection.id} references a missing source or target`);
    }

    if (connection.waypoints.length < 2) {
      connection.waypoints = calculateConnectionWaypoints(source, target);
    }

    const existing = edgesByConnection.get(connection.id);
    if (!existing && !createMissingForImportedElements && document.sourceIds?.has(connection.id)) {
      continue;
    }
    const edgeId = existing?.id || `${connection.id}_di`;
    edgeIds.add(edgeId);
    document.diagram.edges.set(edgeId, {
      id: edgeId,
      connectionId: connection.id,
      waypoints: connection.waypoints.map(point => ({ ...point })),
      labelBounds: existing?.labelBounds ? { ...existing.labelBounds } : undefined,
      ...(existing?.labelBoundsCleared !== undefined
        ? { labelBoundsCleared: existing.labelBoundsCleared }
        : {})
    });
  }

  for (const [edgeId, edge] of document.diagram.edges) {
    if (!edgeIds.has(edgeId)) {
      if (document.sourceIds?.has(edge.connectionId)
        && document.managedIds?.has(edge.connectionId) !== true) {
        continue;
      }
      document.diagram.edges.delete(edgeId);
    }
  }
}

export class BpmnDocumentSerializer {
  private readonly moddle = new BpmnModdle({ camunda: camundaDescriptor });

  async serialize(document: BpmnDocument, formatted = true): Promise<string> {
    assertBpmnDocumentIds(document, true);
    if (document.sourceXml) {
      synchronizeDiagramInterchange(document, false);
      assertBpmnDocumentIds(document, true);
      return this.serializeRetained(document, formatted);
    }
    synchronizeDiagramInterchange(document);
    assertBpmnDocumentIds(document, true);

    const definitions = this.moddle.create('bpmn:Definitions', {
      id: document.definitionsId,
      targetNamespace: document.targetNamespace
    });
    const semanticById = new Map<string, any>();
    const rootElements: any[] = [];

    for (const process of document.processes.values()) {
      const semantic = this.moddle.create('bpmn:Process', {
        id: process.id,
        name: process.name,
        isExecutable: process.isExecutable
      });
      semantic.flowElements = [];
      semantic.artifacts = [];
      semantic.laneSets = [];
      semanticById.set(process.id, semantic);
      rootElements.push(semantic);
    }

    for (const collaboration of document.collaborations.values()) {
      const semantic = this.moddle.create('bpmn:Collaboration', {
        id: collaboration.id,
        name: collaboration.name
      });
      semantic.participants = [];
      semantic.messageFlows = [];
      semantic.artifacts = [];
      semanticById.set(collaboration.id, semantic);
      rootElements.push(semantic);
    }

    for (const itemDefinitionId of document.itemDefinitions) {
      const semantic = this.moddle.create('bpmn:ItemDefinition', { id: itemDefinitionId });
      semanticById.set(itemDefinitionId, semantic);
      rootElements.push(semantic);
    }

    for (const dataObject of document.dataObjects.values()) {
      semanticById.set(dataObject.id, this.moddle.create('bpmn:DataObject', {
        id: dataObject.id,
        name: dataObject.name
      }));
    }

    for (const element of document.elements.values()) {
      if (!isBpmnElementType(element.type)) {
        throw new Error(`Unsupported BPMN element type: ${String(element.type)}`);
      }

      const attrs: Record<string, unknown> = { id: element.id, name: element.name };
      if (element.kind === 'participant') {
        if (element.processRef) {
          const processRef = semanticById.get(element.processRef);
          if (!processRef || processRef.$type !== 'bpmn:Process') {
            throw new Error(`Participant ${element.id} references missing process ${element.processRef}`);
          }
          attrs.processRef = processRef;
        }
      }

      const semantic = this.moddle.create(element.type, attrs);
      if (isFlowContainerType(element.type)) {
        semantic.flowElements = [];
        semantic.artifacts = [];
      }
      semanticById.set(element.id, semantic);
    }

    for (const dataObject of document.dataObjects.values()) {
      const semantic = semanticById.get(dataObject.id);
      this.applyDataObjectProperties(dataObject, semantic, semanticById);
      this.attachDataObject(dataObject, semantic, semanticById);
    }

    for (const laneSet of document.laneSets.values()) {
      const semantic = this.moddle.create('bpmn:LaneSet', { id: laneSet.id });
      semantic.lanes = [];
      semanticById.set(laneSet.id, semantic);
    }

    for (const lane of document.lanes.values()) {
      semanticById.set(lane.id, this.moddle.create('bpmn:Lane', {
        id: lane.id,
        name: lane.name
      }));
    }

    for (const element of document.elements.values()) {
      this.applySupportedProperties(
        element,
        semanticById.get(element.id),
        semanticById,
        rootElements,
        document.extensionProfile
      );
    }

    for (const element of document.elements.values()) {
      const semantic = semanticById.get(element.id);
      if (element.kind === 'participant') {
        const collaboration = semanticById.get(element.ownerId);
        if (!collaboration || collaboration.$type !== 'bpmn:Collaboration') {
          throw new Error(`Participant ${element.id} has invalid collaboration owner ${element.ownerId}`);
        }
        collaboration.participants.push(semantic);
        continue;
      }

      const container = semanticById.get(element.scopeId);
      if (!container) {
        throw new Error(`Element ${element.id} has invalid scope ${element.scopeId}`);
      }

      if (element.kind === 'artifact' && CONTAINED_ARTIFACT_TYPES.has(element.type)) {
        if (!['bpmn:Process', 'bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:Collaboration']
          .includes(container.$type)) {
          throw new Error(`Artifact ${element.id} has invalid scope ${element.scopeId}`);
        }
        container.artifacts.push(semantic);
      } else {
        if (container.$type !== 'bpmn:Process' && !isFlowContainerType(container.$type)) {
          throw new Error(`Flow element ${element.id} has invalid scope ${element.scopeId}`);
        }
        container.flowElements.push(semantic);
      }
    }

    for (const connection of document.connections.values()) {
      if (!isBpmnConnectionType(connection.type)) {
        throw new Error(`Unsupported BPMN connection type: ${String(connection.type)}`);
      }
      const sourceRef = semanticById.get(connection.source);
      const targetRef = semanticById.get(connection.target);
      if (!sourceRef || !targetRef) {
        throw new Error(`Connection ${connection.id} references a missing source or target`);
      }

      const semantic = this.moddle.create(connection.type, {
        id: connection.id,
        name: connection.label,
        sourceRef,
        targetRef
      });
      semanticById.set(connection.id, semantic);
      this.applyConnectionProperties(connection, semantic, semanticById);

      if (connection.type === 'bpmn:MessageFlow') {
        const collaboration = semanticById.get(connection.ownerId);
        if (!collaboration || collaboration.$type !== 'bpmn:Collaboration') {
          throw new Error(`Message flow ${connection.id} has invalid collaboration owner ${connection.ownerId}`);
        }
        collaboration.messageFlows.push(semantic);
      } else {
        const container = semanticById.get(connection.scopeId);
        if (!container) {
          throw new Error(`Connection ${connection.id} has invalid scope ${connection.scopeId}`);
        }
        if (connection.type === 'bpmn:Association') {
          if (!['bpmn:Process', 'bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:Collaboration']
            .includes(container.$type)) {
            throw new Error(`Association ${connection.id} has invalid scope ${connection.scopeId}`);
          }
          container.artifacts.push(semantic);
        } else {
          if (container.$type !== 'bpmn:Process' && !isFlowContainerType(container.$type)) {
            throw new Error(`Sequence flow ${connection.id} has invalid scope ${connection.scopeId}`);
          }
          container.flowElements.push(semantic);
        }
      }
    }

    this.reconcileConditionalAndDefaultFlows(document, semanticById);

    this.reconcileLanes(document, semanticById);

    definitions.rootElements = rootElements;
    const planeTarget = semanticById.get(document.diagram.planeElementId);
    if (!planeTarget || !['bpmn:Process', 'bpmn:Collaboration'].includes(planeTarget.$type)) {
      throw new Error(`BPMN plane references missing root ${document.diagram.planeElementId}`);
    }

    const plane = this.moddle.create('bpmndi:BPMNPlane', {
      id: document.diagram.planeId,
      bpmnElement: planeTarget
    });
    plane.planeElement = [];

    for (const shape of document.diagram.shapes.values()) {
      const bpmnElement = semanticById.get(shape.elementId);
      if (!bpmnElement) {
        throw new Error(`BPMN shape ${shape.id} references missing element ${shape.elementId}`);
      }
      const semantic = this.moddle.create('bpmndi:BPMNShape', {
        id: shape.id,
        bpmnElement,
        isHorizontal: shape.isHorizontal,
        isExpanded: shape.isExpanded,
        bounds: this.moddle.create('dc:Bounds', shape.bounds)
      });
      if (shape.labelBounds) {
        semantic.label = this.moddle.create('bpmndi:BPMNLabel', {
          bounds: this.moddle.create('dc:Bounds', shape.labelBounds)
        });
      }
      plane.planeElement.push(semantic);
    }

    for (const edge of document.diagram.edges.values()) {
      const bpmnElement = semanticById.get(edge.connectionId);
      if (!bpmnElement) {
        throw new Error(`BPMN edge ${edge.id} references missing connection ${edge.connectionId}`);
      }
      const semantic = this.moddle.create('bpmndi:BPMNEdge', {
        id: edge.id,
        bpmnElement,
        waypoint: edge.waypoints.map(point => this.moddle.create('dc:Point', point))
      });
      if (edge.labelBounds) {
        semantic.label = this.moddle.create('bpmndi:BPMNLabel', {
          bounds: this.moddle.create('dc:Bounds', edge.labelBounds)
        });
      }
      plane.planeElement.push(semantic);
    }

    const diagram = this.moddle.create('bpmndi:BPMNDiagram', {
      id: document.diagram.id,
      plane
    });
    definitions.diagrams = [diagram];

    const { xml } = await this.moddle.toXML(definitions, {
      format: formatted,
      preamble: true
    });
    document.sourceXml = xml;
    this.rememberDocumentIds(document);
    return xml;
  }

  /**
   * Reconcile the API's typed indexes into a freshly parsed copy of the
   * imported moddle graph. Existing objects are edited in place so semantics
   * outside the API surface (extensions, lanes, conditions, labels and extra
   * DI) remain owned by bpmn-moddle and survive later mutations.
   */
  private async serializeRetained(document: BpmnDocument, formatted: boolean): Promise<string> {
    assertBpmnXmlIdentifiers(document.sourceXml!);
    const parsed = await parseBpmnXml(this.moddle, document.sourceXml!);
    if (parsed.warnings.length > 0) {
      throw new Error('Retained BPMN document can no longer be parsed safely');
    }
    assertParsedBpmnIds(parsed.elementsById);

    const definitions = parsed.rootElement;
    const semanticById = new Map<string, any>(Object.entries(parsed.elementsById));
    definitions.rootElements = definitions.rootElements || [];
    definitions.id = document.definitionsId;
    definitions.targetNamespace = document.targetNamespace;

    for (const semantic of semanticById.values()) {
      const isManaged = document.managedIds?.has(semantic.id) === true;
      if (isManaged && semantic.$type === 'bpmn:Process' && !document.processes.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      } else if (semantic.$type === 'bpmn:Collaboration'
        && isManaged && !document.collaborations.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      } else if (isManaged && isBpmnElementType(semantic.$type)
        && !document.elements.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      } else if (isBpmnConnectionType(semantic.$type)
        && isManaged && !document.connections.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      } else if (semantic.$type === 'bpmn:Lane' && isManaged && !document.lanes.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      } else if (semantic.$type === 'bpmn:LaneSet'
        && isManaged && !document.laneSets.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      } else if (semantic.$type === 'bpmn:DataObject'
        && isManaged && !document.dataObjects.has(semantic.id)) {
        this.detachSemantic(semantic, semanticById);
      }
    }

    for (const process of document.processes.values()) {
      let semantic = semanticById.get(process.id);
      if (!semantic) {
        semantic = this.moddle.create('bpmn:Process', { id: process.id });
        semantic.flowElements = [];
        semantic.artifacts = [];
        semantic.laneSets = [];
        definitions.rootElements = definitions.rootElements || [];
        definitions.rootElements.push(semantic);
        semanticById.set(process.id, semantic);
      }
      semantic.name = process.name;
      semantic.isExecutable = process.isExecutable;
    }

    for (const collaboration of document.collaborations.values()) {
      let semantic = semanticById.get(collaboration.id);
      if (!semantic) {
        semantic = this.moddle.create('bpmn:Collaboration', { id: collaboration.id });
        semantic.participants = [];
        semantic.messageFlows = [];
        semantic.artifacts = [];
        definitions.rootElements = definitions.rootElements || [];
        definitions.rootElements.push(semantic);
        semanticById.set(collaboration.id, semantic);
      }
      semantic.name = collaboration.name;
    }

    for (const dataObject of document.dataObjects.values()) {
      let semantic = semanticById.get(dataObject.id);
      const isNew = !semantic;
      if (!semantic) {
        semantic = this.moddle.create('bpmn:DataObject', { id: dataObject.id });
        semanticById.set(dataObject.id, semantic);
      }
      if (semantic.$type !== 'bpmn:DataObject') {
        throw new Error(`BPMN ID ${dataObject.id} is not a data object`);
      }
      semantic.name = dataObject.name;
      this.applyDataObjectProperties(dataObject, semantic, semanticById);
      if (isNew) this.attachDataObject(dataObject, semantic, semanticById);
    }

    for (const element of document.elements.values()) {
      let semantic = semanticById.get(element.id);
      const isNew = !semantic;
      if (!semantic) {
        semantic = this.moddle.create(element.type, { id: element.id });
        if (isFlowContainerType(element.type)) {
          semantic.flowElements = [];
          semantic.artifacts = [];
        }
        semanticById.set(element.id, semantic);
      }
      if (semantic.$type !== element.type) {
        throw new Error(`BPMN ID ${element.id} changed type from ${semantic.$type} to ${element.type}`);
      }
      semantic.name = element.name;
      if (element.kind === 'participant') {
        semantic.processRef = element.processRef ? semanticById.get(element.processRef) : undefined;
        if (element.processRef && !semantic.processRef) {
          throw new Error(`Participant ${element.id} references missing process ${element.processRef}`);
        }
      }
      this.applyRetainedProperties(
        element,
        semantic,
        semanticById,
        definitions.rootElements,
        document.extensionProfile
      );
      if (isNew) {
        this.attachElement(element, semantic, semanticById);
      }
    }

    for (const laneSet of document.laneSets.values()) {
      let semantic = semanticById.get(laneSet.id);
      if (!semantic) {
        semantic = this.moddle.create('bpmn:LaneSet', { id: laneSet.id });
        semantic.lanes = [];
        semanticById.set(laneSet.id, semantic);
      }
      if (semantic.$type !== 'bpmn:LaneSet') {
        throw new Error(`BPMN ID ${laneSet.id} is not a lane set`);
      }
    }

    for (const lane of document.lanes.values()) {
      let semantic = semanticById.get(lane.id);
      if (!semantic) {
        semantic = this.moddle.create('bpmn:Lane', { id: lane.id });
        semanticById.set(lane.id, semantic);
      }
      if (semantic.$type !== 'bpmn:Lane') {
        throw new Error(`BPMN ID ${lane.id} is not a lane`);
      }
      semantic.name = lane.name;
    }

    for (const connection of document.connections.values()) {
      let semantic = semanticById.get(connection.id);
      const isNew = !semantic;
      if (!semantic) {
        semantic = this.moddle.create(connection.type, { id: connection.id });
        semanticById.set(connection.id, semantic);
      }
      if (semantic.$type !== connection.type) {
        throw new Error(`BPMN ID ${connection.id} changed type from ${semantic.$type} to ${connection.type}`);
      }
      const sourceRef = semanticById.get(connection.source);
      const targetRef = semanticById.get(connection.target);
      if (!sourceRef || !targetRef) {
        throw new Error(`Connection ${connection.id} references a missing source or target`);
      }
      const previousSourceRef = semantic.sourceRef;
      const previousTargetRef = semantic.targetRef;
      semantic.name = connection.label;
      semantic.sourceRef = sourceRef;
      semantic.targetRef = targetRef;
      if (!isNew) {
        this.reconcileConnectionReferences(
          connection,
          semantic,
          semanticById,
          previousSourceRef,
          previousTargetRef
        );
      }
      this.applyConnectionProperties(connection, semantic, semanticById);
      if (isNew) {
        this.attachConnection(connection, semantic, semanticById);
      }
    }

    this.reconcileConditionalAndDefaultFlows(document, semanticById);

    this.reconcileLanes(document, semanticById);

    this.reconcileRetainedDiagram(document, definitions, semanticById);
    const { xml } = await this.moddle.toXML(definitions, {
      format: formatted,
      preamble: true
    });
    const verification = await parseBpmnXml(this.moddle, xml);
    const unresolvedReferences = verification.references.filter(
      reference => !Object.prototype.hasOwnProperty.call(verification.elementsById, reference.id)
    );
    if (verification.warnings.length > 0 || unresolvedReferences.length > 0) {
      throw new Error(`Retained BPMN mutation produced invalid references${
        unresolvedReferences.length > 0
          ? `: ${unresolvedReferences.map(reference => reference.id).join(', ')}`
          : ''
      }`);
    }
    document.sourceXml = xml;
    this.rememberDocumentIds(document);
    return xml;
  }

  private reconcileLanes(document: BpmnDocument, semanticById: Map<string, any>): void {
    for (const process of document.processes.values()) {
      const semantic = semanticById.get(process.id);
      if (semantic) semantic.laneSets = [];
    }
    for (const lane of document.lanes.values()) {
      const semantic = semanticById.get(lane.id);
      if (semantic) semantic.childLaneSet = undefined;
    }

    for (const laneSet of document.laneSets.values()) {
      const semantic = semanticById.get(laneSet.id);
      if (!semantic) throw new Error(`Missing lane set ${laneSet.id}`);
      semantic.lanes = laneSet.laneIds.map(laneId => {
        const lane = document.lanes.get(laneId);
        const laneSemantic = semanticById.get(laneId);
        if (!lane || !laneSemantic || lane.laneSetId !== laneSet.id) {
          throw new Error(`Lane set ${laneSet.id} references invalid lane ${laneId}`);
        }
        return laneSemantic;
      });

      if (laneSet.parentLaneId) {
        const parentLane = document.lanes.get(laneSet.parentLaneId);
        const parentSemantic = semanticById.get(laneSet.parentLaneId);
        if (!parentLane || !parentSemantic || parentLane.processId !== laneSet.processId) {
          throw new Error(`Lane set ${laneSet.id} has invalid parent lane ${laneSet.parentLaneId}`);
        }
        parentSemantic.childLaneSet = semantic;
      } else {
        const process = semanticById.get(laneSet.processId);
        if (!process || process.$type !== 'bpmn:Process') {
          throw new Error(`Lane set ${laneSet.id} references missing process ${laneSet.processId}`);
        }
        process.laneSets = process.laneSets || [];
        process.laneSets.push(semantic);
      }
    }

    for (const lane of document.lanes.values()) {
      const semantic = semanticById.get(lane.id);
      if (!document.laneSets.has(lane.laneSetId) || !semantic) {
        throw new Error(`Lane ${lane.id} references missing lane set ${lane.laneSetId}`);
      }
      semantic.flowNodeRef = lane.flowNodeRefs.map(flowNodeId => {
        const node = document.elements.get(flowNodeId);
        const nodeSemantic = semanticById.get(flowNodeId);
        if (!node || node.kind !== 'flowNode' || node.ownerId !== lane.processId
          || node.scopeId !== lane.processId || !nodeSemantic) {
          throw new Error(`Lane ${lane.id} references invalid flow node ${flowNodeId}`);
        }
        return nodeSemantic;
      });
    }
  }

  private detachSemantic(semantic: any, semanticById: Map<string, any>): void {
    if (isBpmnConnectionType(semantic.$type)) {
      semantic.sourceRef && this.removeFromCollection(semantic.sourceRef, 'outgoing', semantic);
      semantic.targetRef && this.removeFromCollection(semantic.targetRef, 'incoming', semantic);
    }
    for (const owner of semanticById.values()) {
      for (const property of owner.$descriptor?.properties || []) {
        if (!property.isReference) continue;
        const value = owner[property.name];
        if (Array.isArray(value)) {
          const filtered = value.filter((candidate: any) => candidate !== semantic);
          owner[property.name] = filtered;
          if (filtered.length === 0 && filtered.length !== value.length
            && (property.name === 'sourceRef' || property.name === 'targetRef')) {
            this.detachSemantic(owner, semanticById);
          }
        } else if (value === semantic) {
          if (owner.$type === 'bpmndi:BPMNShape' || owner.$type === 'bpmndi:BPMNEdge') {
            this.detachSemantic(owner, semanticById);
          } else if (property.name === 'sourceRef' || property.name === 'targetRef') {
            this.detachSemantic(owner, semanticById);
          } else {
            owner[property.name] = undefined;
          }
        }
      }
    }
    const parent = semantic.$parent;
    if (!parent) return;
    for (const property of parent.$descriptor?.properties || []) {
      if (property.isReference) continue;
      if (Array.isArray(parent[property.name])) {
        this.removeFromCollection(parent, property.name, semantic);
      } else if (parent[property.name] === semantic) {
        parent[property.name] = undefined;
      }
    }
  }

  private removeFromCollection(owner: any, property: string, value: any): void {
    if (Array.isArray(owner[property])) {
      owner[property] = owner[property].filter((candidate: any) => candidate !== value);
    }
  }

  private attachElement(
    element: BpmnDocumentElement,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    const container = semanticById.get(element.kind === 'participant' ? element.ownerId : element.scopeId);
    if (!container) {
      throw new Error(`Element ${element.id} has invalid scope ${element.scopeId}`);
    }
    if (element.kind === 'participant') {
      container.participants = container.participants || [];
      container.participants.push(semantic);
    } else if (element.kind === 'artifact' && CONTAINED_ARTIFACT_TYPES.has(element.type)) {
      container.artifacts = container.artifacts || [];
      container.artifacts.push(semantic);
    } else {
      container.flowElements = container.flowElements || [];
      container.flowElements.push(semantic);
    }
  }

  private attachDataObject(
    dataObject: BpmnDataObject,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    const container = semanticById.get(dataObject.scopeId);
    if (!container || !['bpmn:Process', 'bpmn:SubProcess', 'bpmn:Transaction']
      .includes(container.$type)) {
      throw new Error(`Data object ${dataObject.id} has invalid scope ${dataObject.scopeId}`);
    }
    container.flowElements = container.flowElements || [];
    container.flowElements.push(semantic);
  }

  private attachConnection(
    connection: BpmnDocumentConnection,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    const container = semanticById.get(
      connection.type === 'bpmn:MessageFlow' ? connection.ownerId : connection.scopeId
    );
    if (!container) {
      throw new Error(`Connection ${connection.id} has invalid scope ${connection.scopeId}`);
    }
    if (connection.type === 'bpmn:MessageFlow') {
      container.messageFlows = container.messageFlows || [];
      container.messageFlows.push(semantic);
    } else if (connection.type === 'bpmn:Association') {
      container.artifacts = container.artifacts || [];
      container.artifacts.push(semantic);
    } else {
      container.flowElements = container.flowElements || [];
      container.flowElements.push(semantic);
    }
  }

  private reconcileConnectionReferences(
    connection: BpmnDocumentConnection,
    semantic: any,
    semanticById: Map<string, any>,
    previousSourceRef: any,
    previousTargetRef: any
  ): void {
    const containerProperty = connection.type === 'bpmn:MessageFlow'
      ? 'messageFlows'
      : connection.type === 'bpmn:Association'
        ? 'artifacts'
        : 'flowElements';
    const containerId = connection.type === 'bpmn:MessageFlow'
      ? connection.ownerId
      : connection.scopeId;
    const container = semanticById.get(containerId);
    if (!container) throw new Error(`Connection ${connection.id} has invalid scope ${containerId}`);

    const alreadyAttached = Array.isArray(container[containerProperty])
      && container[containerProperty].includes(semantic);
    if (!alreadyAttached) {
      for (const candidate of semanticById.values()) {
        for (const property of ['flowElements', 'artifacts', 'messageFlows']) {
          this.removeFromCollection(candidate, property, semantic);
        }
      }
      container[containerProperty] = container[containerProperty] || [];
      container[containerProperty].push(semantic);
    }

    if (connection.type === 'bpmn:SequenceFlow') {
      const source = semanticById.get(connection.source);
      const target = semanticById.get(connection.target);
      if (previousSourceRef !== source && previousSourceRef?.outgoing?.includes(semantic)) {
        this.removeFromCollection(previousSourceRef, 'outgoing', semantic);
        source.outgoing = source.outgoing || [];
        if (!source.outgoing.includes(semantic)) source.outgoing.push(semantic);
      }
      if (previousTargetRef !== target && previousTargetRef?.incoming?.includes(semantic)) {
        this.removeFromCollection(previousTargetRef, 'incoming', semantic);
        target.incoming = target.incoming || [];
        if (!target.incoming.includes(semantic)) target.incoming.push(semantic);
      }
    }
  }

  private applyRetainedProperties(
    element: BpmnDocumentElement,
    semantic: any,
    semanticById: Map<string, any>,
    rootElements: any[],
    extensionProfile: BpmnExtensionProfile
  ): void {
    this.applyEventDefinitionProperties(element, semantic, semanticById, rootElements);
    this.applyDataObjectReferenceProperties(element, semantic, semanticById);
    this.applyMultiInstanceProperties(element, semantic, semanticById);
    if (element.type === 'bpmn:BoundaryEvent' && typeof element.properties.attachTo === 'string') {
      semantic.attachedToRef = semanticById.get(element.properties.attachTo);
    }
    if (element.type === 'bpmn:CallActivity'
      && typeof element.properties.calledElement === 'string') {
      if (!isBpmnQName(element.properties.calledElement)) {
        throw new Error(`Call activity ${element.id} calledElement must be a valid BPMN QName`);
      }
      semantic.calledElement = element.properties.calledElement;
    }
    if (element.type === 'bpmn:TextAnnotation' && typeof element.properties.text === 'string') {
      semantic.text = element.properties.text;
    }
    if (element.type === 'bpmn:TextAnnotation'
      && typeof element.properties.textFormat === 'string') {
      semantic.textFormat = element.properties.textFormat;
    }
    this.applyCamundaUserTaskProperties(element, semantic, extensionProfile);
  }

  private applyEventDefinitionProperties(
    element: BpmnDocumentElement,
    semantic: any,
    semanticById: Map<string, any>,
    rootElements: any[]
  ): void {
    if (element.type === 'bpmn:BoundaryEvent'
      && typeof element.properties.cancelActivity === 'boolean') {
      semantic.cancelActivity = element.properties.cancelActivity;
    }
    const definitionName = element.properties.eventDefinition;
    if (typeof definitionName !== 'string') return;
    if (!isSupportedEventDefinitionType(definitionName)) {
      throw new Error(`Unsupported event definition type: ${definitionName}`);
    }

    const definitionType = EVENT_DEFINITION_TYPES[definitionName];
    const payload = (element.properties.eventDefinitionPayload || {}) as EventDefinitionPayload;
    let definition = semantic.eventDefinitions?.length === 1
      && semantic.eventDefinitions[0].$type === definitionType
      ? semantic.eventDefinitions[0]
      : this.moddle.create(definitionType);

    if (payload.definitionId) {
      const collision = semanticById.get(payload.definitionId);
      if (collision && collision !== definition) {
        throw new Error(`BPMN ID already exists: ${payload.definitionId}`);
      }
      definition.id = payload.definitionId;
      semanticById.set(payload.definitionId, definition);
    }
    semantic.eventDefinitions = [definition];

    if (definitionName === 'timer' && payload.timer) {
      definition.timeDate = undefined;
      definition.timeDuration = undefined;
      definition.timeCycle = undefined;
      definition[payload.timer.type] = this.moddle.create('bpmn:FormalExpression', {
        body: payload.timer.expression,
        language: payload.timer.language
      });
    } else if (definitionName === 'conditional' && payload.condition) {
      definition.condition = this.moddle.create('bpmn:FormalExpression', {
        body: payload.condition.expression,
        language: payload.condition.language
      });
    } else if (definitionName === 'compensation') {
      definition.waitForCompletion = payload.waitForCompletion;
      definition.activityRef = payload.activityRef
        ? semanticById.get(payload.activityRef)
        : undefined;
      if (payload.activityRef && !definition.activityRef) {
        throw new Error(`Compensation event ${element.id} references missing activity ${payload.activityRef}`);
      }
    }

    const rootType = ROOT_EVENT_DEFINITION_TYPES[definitionName];
    const referenceProperty = ROOT_EVENT_REFERENCE_PROPERTIES[definitionName];
    if (rootType && referenceProperty && payload.reference?.id) {
      definition[referenceProperty] = this.ensureEventRoot(
        rootType,
        definitionName,
        payload.reference,
        semanticById,
        rootElements
      );
    }

  }

  private ensureEventRoot(
    rootType: string,
    definitionType: EventDefinitionType,
    reference: EventDefinitionReference,
    semanticById: Map<string, any>,
    rootElements: any[]
  ): any {
    let root = semanticById.get(reference.id!);
    if (root && root.$type !== rootType) {
      throw new Error(`BPMN ID ${reference.id} is ${root.$type}, not ${rootType}`);
    }
    if (!root) {
      root = this.moddle.create(rootType, { id: reference.id });
      semanticById.set(reference.id!, root);
      rootElements.push(root);
    }
    if (reference.name !== undefined && root.name !== undefined && root.name !== reference.name) {
      throw new Error(`Conflicting names for shared event root ${reference.id}`);
    }
    if (reference.name !== undefined) root.name = reference.name;
    if (definitionType === 'error' && reference.code !== undefined) {
      if (root.errorCode !== undefined && root.errorCode !== reference.code) {
        throw new Error(`Conflicting codes for shared event root ${reference.id}`);
      }
      root.errorCode = reference.code;
    }
    if (definitionType === 'escalation' && reference.code !== undefined) {
      if (root.escalationCode !== undefined && root.escalationCode !== reference.code) {
        throw new Error(`Conflicting codes for shared event root ${reference.id}`);
      }
      root.escalationCode = reference.code;
    }
    return root;
  }

  private applyConnectionProperties(
    connection: BpmnDocumentConnection,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    if (connection.type === 'bpmn:Association') {
      const direction = connection.associationDirection ?? 'None';
      if (!['None', 'One', 'Both'].includes(direction)) {
        throw new Error(`Association ${connection.id} has invalid direction ${String(direction)}`);
      }
      semantic.associationDirection = direction;
    } else if (connection.associationDirection !== undefined) {
      throw new Error(`Connection ${connection.id} cannot have an association direction`);
    }
    if (!connection.condition) {
      semantic.conditionExpression = undefined;
      return;
    }
    if (connection.type !== 'bpmn:SequenceFlow') {
      throw new Error(`Connection ${connection.id} cannot have a condition`);
    }
    const { body, language, type, evaluatesToTypeRef } = connection.condition;
    if (typeof body !== 'string' || body.length === 0) {
      throw new Error(`Sequence flow ${connection.id} has an empty condition`);
    }
    let conditionSemantic = semantic.conditionExpression;
    if (!conditionSemantic || conditionSemantic.$type !== type) {
      conditionSemantic = this.moddle.create(type || 'bpmn:FormalExpression');
    }
    conditionSemantic.body = body;
    conditionSemantic.language = language;
    conditionSemantic.evaluatesToTypeRef = undefined;
    if (evaluatesToTypeRef) {
      const typeRef = semanticById.get(evaluatesToTypeRef);
      if (!typeRef || typeRef.$type !== 'bpmn:ItemDefinition') {
        throw new Error(
          `Sequence flow ${connection.id} references missing condition type ${evaluatesToTypeRef}`
        );
      }
      conditionSemantic.evaluatesToTypeRef = typeRef;
    }
    semantic.conditionExpression = conditionSemantic;
  }

  private reconcileConditionalAndDefaultFlows(
    document: BpmnDocument,
    semanticById: Map<string, any>
  ): void {
    for (const connection of document.connections.values()) {
      if (!connection.condition) continue;
      const source = document.elements.get(connection.source);
      if (connection.type !== 'bpmn:SequenceFlow' || !source
        || !supportsConditionalOutgoingFlow(source)) {
        throw new Error(`Sequence flow ${connection.id} has an unsupported conditional source`);
      }
      if (source.kind === 'flowNode' && source.defaultFlow === connection.id) {
        throw new Error(`Default sequence flow ${connection.id} cannot have a condition`);
      }
    }

    for (const element of document.elements.values()) {
      if (element.kind !== 'flowNode') continue;
      const elementSemantic = semanticById.get(element.id);
      if (element.defaultFlowManaged && elementSemantic) {
        elementSemantic.default = undefined;
      }
      if (!element.defaultFlow) continue;
      if (!supportsConditionalOutgoingFlow(element)) {
        throw new Error(`Element ${element.id} cannot own a default sequence flow`);
      }
      const connection = document.connections.get(element.defaultFlow);
      const semantic = semanticById.get(element.defaultFlow);
      if (!connection || connection.type !== 'bpmn:SequenceFlow'
        || connection.source !== element.id || !semantic) {
        throw new Error(`Element ${element.id} references invalid default flow ${element.defaultFlow}`);
      }
      if (connection.condition) {
        throw new Error(`Default sequence flow ${connection.id} cannot have a condition`);
      }
      elementSemantic.default = semantic;
    }
  }

  private reconcileRetainedDiagram(
    document: BpmnDocument,
    definitions: any,
    semanticById: Map<string, any>
  ): void {
    let diagram = (definitions.diagrams || []).find((candidate: any) => candidate.id === document.diagram.id)
      || definitions.diagrams?.[0];
    if (!diagram && document.diagram.shapes.size === 0 && document.diagram.edges.size === 0) {
      return;
    }
    if (!diagram) {
      diagram = this.moddle.create('bpmndi:BPMNDiagram', { id: document.diagram.id });
      definitions.diagrams = definitions.diagrams || [];
      definitions.diagrams.push(diagram);
    }
    diagram.id = document.diagram.id;

    let plane = diagram.plane;
    if (!plane) {
      plane = this.moddle.create('bpmndi:BPMNPlane', { id: document.diagram.planeId });
      plane.planeElement = [];
      diagram.plane = plane;
    }
    plane.id = document.diagram.planeId;
    plane.bpmnElement = semanticById.get(document.diagram.planeElementId);
    if (!plane.bpmnElement) {
      throw new Error(`BPMN plane references missing root ${document.diagram.planeElementId}`);
    }
    plane.planeElement = plane.planeElement || [];
    plane.planeElement = plane.planeElement.filter((item: any) => {
      const referenced = item.bpmnElement;
      if (item.$type === 'bpmndi:BPMNShape' && isBpmnElementType(referenced?.$type)) {
        return document.elements.has(referenced.id)
          || document.managedIds?.has(referenced.id) !== true;
      }
      if (item.$type === 'bpmndi:BPMNShape' && referenced?.$type === 'bpmn:Lane') {
        return document.lanes.has(referenced.id)
          || document.managedIds?.has(referenced.id) !== true;
      }
      if (item.$type === 'bpmndi:BPMNEdge' && isBpmnConnectionType(referenced?.$type)) {
        return this.retainedConnectionIsActive(document, referenced);
      }
      return true;
    });
    const planeElementsById = new Map<string, any>(
      plane.planeElement
        .filter((item: any) => typeof item.id === 'string')
        .map((item: any) => [item.id, item])
    );

    for (const shape of document.diagram.shapes.values()) {
      let semantic = planeElementsById.get(shape.id);
      if (!semantic) {
        semantic = this.moddle.create('bpmndi:BPMNShape', { id: shape.id });
        plane.planeElement.push(semantic);
        planeElementsById.set(shape.id, semantic);
      }
      const bpmnElement = semanticById.get(shape.elementId);
      if (!bpmnElement) continue;
      semantic.bpmnElement = bpmnElement;
      semantic.bounds = semantic.bounds || this.moddle.create('dc:Bounds');
      Object.assign(semantic.bounds, shape.bounds);
      if (shape.labelBounds) {
        semantic.label = semantic.label || this.moddle.create('bpmndi:BPMNLabel');
        semantic.label.bounds = semantic.label.bounds || this.moddle.create('dc:Bounds');
        Object.assign(semantic.label.bounds, shape.labelBounds);
      } else if (shape.labelBoundsCleared) {
        semantic.label = undefined;
      }
      if (shape.isHorizontal !== undefined) semantic.isHorizontal = shape.isHorizontal;
      if (shape.isExpanded !== undefined) semantic.isExpanded = shape.isExpanded;
    }

    for (const edge of document.diagram.edges.values()) {
      const bpmnElement = semanticById.get(edge.connectionId);
      if (!bpmnElement || !this.retainedConnectionIsActive(document, bpmnElement)) {
        document.diagram.edges.delete(edge.id);
        continue;
      }
      let semantic = planeElementsById.get(edge.id);
      if (!semantic) {
        semantic = this.moddle.create('bpmndi:BPMNEdge', { id: edge.id });
        plane.planeElement.push(semantic);
        planeElementsById.set(edge.id, semantic);
      }
      semantic.bpmnElement = bpmnElement;
      semantic.waypoint = edge.waypoints.map(point => this.moddle.create('dc:Point', point));
      if (edge.labelBounds) {
        semantic.label = semantic.label || this.moddle.create('bpmndi:BPMNLabel');
        semantic.label.bounds = semantic.label.bounds || this.moddle.create('dc:Bounds');
        Object.assign(semantic.label.bounds, edge.labelBounds);
      } else if (edge.labelBoundsCleared) {
        semantic.label = undefined;
      }
    }
  }

  private retainedConnectionIsActive(document: BpmnDocument, semantic: any): boolean {
    if (document.connections.has(semantic.id)) return true;
    if (document.managedIds?.has(semantic.id) === true) return false;
    return [semantic.sourceRef, semantic.targetRef].every((endpoint: any) =>
      typeof endpoint?.id === 'string'
      && (document.managedIds?.has(endpoint.id) !== true
        || document.elements.has(endpoint.id)
        || document.lanes.has(endpoint.id))
    );
  }

  private rememberDocumentIds(document: BpmnDocument): void {
    document.sourceIds = document.sourceIds || new Set();
    document.managedIds = document.managedIds || new Set();
    for (const collection of [
      document.processes,
      document.collaborations,
      document.laneSets,
      document.lanes,
      document.dataObjects,
      document.elements,
      document.connections,
      document.diagram.shapes,
      document.diagram.edges
    ]) {
      for (const id of collection.keys()) document.sourceIds.add(id);
    }
    for (const collection of [
      document.processes,
      document.collaborations,
      document.laneSets,
      document.lanes,
      document.dataObjects,
      document.elements,
      document.connections
    ]) {
      for (const id of collection.keys()) document.managedIds.add(id);
    }
    document.sourceIds.add(document.definitionsId);
    document.sourceIds.add(document.diagram.id);
    document.sourceIds.add(document.diagram.planeId);
  }

  async parse(xml: string, limits: BpmnImportLimits): Promise<ProcessContext> {
    let definitions: any;
    let sourceIds = new Set<string>();
    let elementsById: Record<string, any> = {};
    try {
      assertBpmnXmlIdentifiers(xml);
      const result = await parseBpmnXml(this.moddle, xml);
      assertParsedBpmnIds(result.elementsById);
      const hasUnresolvedReferences = result.references.some(
        reference => !Object.prototype.hasOwnProperty.call(result.elementsById, reference.id)
      );
      if (hasUnresolvedReferences) {
        throw new Error('unresolved references');
      }
      if (result.warnings.length > 0) {
        throw new Error(result.warnings.some(warning => /unparsable content/i.test(warning.message))
          ? 'unknown type'
          : 'parser warnings');
      }
      definitions = result.rootElement;
      elementsById = result.elementsById;
      sourceIds = new Set(Object.keys(result.elementsById));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse BPMN XML: ${message}`);
    }

    if (!definitions || definitions.$type !== 'bpmn:Definitions') {
      throw new Error('Imported XML root is not BPMN Definitions');
    }

    const processRoots = (definitions.rootElements || []).filter(
      (element: any) => element.$type === 'bpmn:Process'
    );
    const collaborationRoots = (definitions.rootElements || []).filter(
      (element: any) => element.$type === 'bpmn:Collaboration'
    );
    const plane = definitions.diagrams?.[0]?.plane;
    const primaryRoot = plane?.bpmnElement || collaborationRoots[0] || processRoots[0];
    if (!primaryRoot || !['bpmn:Process', 'bpmn:Collaboration'].includes(primaryRoot.$type)) {
      throw new Error('No process or collaboration found in BPMN XML');
    }

    this.assertImportStructureAndComplexity(definitions, limits);

    const type: 'process' | 'collaboration' = primaryRoot.$type === 'bpmn:Collaboration'
      ? 'collaboration'
      : 'process';
    const name = primaryRoot.name || 'Imported Process';
    const extensionProfile = this.detectExtensionProfile(elementsById);
    const document: BpmnDocument = {
      definitionsId: definitions.id || `Definitions_${primaryRoot.id}`,
      targetNamespace: definitions.targetNamespace || TARGET_NAMESPACE,
      extensionProfile,
      sourceXml: xml,
      sourceIds,
      managedIds: new Set(),
      processes: new Map(),
      collaborations: new Map(),
      laneSets: new Map(),
      lanes: new Map(),
      itemDefinitions: new Set(
        (definitions.rootElements || [])
          .filter((root: any) => root.$type === 'bpmn:ItemDefinition')
          .map((root: any) => root.id)
      ),
      dataObjects: new Map(),
      elements: new Map(),
      connections: new Map(),
      diagram: {
        id: definitions.diagrams?.[0]?.id || `BPMNDiagram_${primaryRoot.id}`,
        planeId: plane?.id || `BPMNPlane_${primaryRoot.id}`,
        planeElementId: plane?.bpmnElement?.id || primaryRoot.id,
        shapes: new Map(),
        edges: new Map()
      }
    };

    for (const process of processRoots) {
      document.processes.set(process.id, {
        id: process.id,
        name: process.name,
        isExecutable: process.isExecutable
      });
      this.readFlowContainer(process, process.id, process.id, document);
      for (const laneSet of process.laneSets || []) {
        this.readLaneSet(laneSet, process.id, undefined, plane, document);
      }
    }

    for (const collaboration of collaborationRoots) {
      document.collaborations.set(collaboration.id, {
        id: collaboration.id,
        name: collaboration.name
      });
      for (const participant of collaboration.participants || []) {
        const shape = this.findShape(plane, participant.id);
        const element: BpmnParticipantElement = {
          kind: 'participant',
          id: participant.id,
          type: 'bpmn:Participant',
          name: participant.name,
          ownerId: collaboration.id,
          scopeId: collaboration.id,
          processRef: participant.processRef?.id,
          position: this.readPosition(shape, { x: 100, y: 100 }),
          size: this.readSize(shape, getDefaultElementSize('bpmn:Participant')),
          properties: {}
        };
        document.elements.set(element.id, element);
      }
      for (const messageFlow of collaboration.messageFlows || []) {
        this.readConnection(messageFlow, collaboration.id, collaboration.id, plane, document);
      }
      for (const artifact of collaboration.artifacts || []) {
        this.readArtifactOrAssociation(artifact, collaboration.id, collaboration.id, plane, document);
      }
    }

    this.assertImportedDataObjectReferences(document);
    this.assertImportedConnections(document);

    for (const planeElement of plane?.planeElement || []) {
      if (planeElement.$type === 'bpmndi:BPMNShape' && planeElement.bpmnElement?.id) {
        const shape = {
          id: planeElement.id,
          elementId: planeElement.bpmnElement.id,
          bounds: {
            x: planeElement.bounds?.x ?? 100,
            y: planeElement.bounds?.y ?? 100,
            width: planeElement.bounds?.width ?? 100,
            height: planeElement.bounds?.height ?? 80
          },
          labelBounds: planeElement.label?.bounds ? {
            x: planeElement.label.bounds.x,
            y: planeElement.label.bounds.y,
            width: planeElement.label.bounds.width,
            height: planeElement.label.bounds.height
          } : undefined,
          isHorizontal: planeElement.isHorizontal,
          isExpanded: planeElement.isExpanded
        };
        document.diagram.shapes.set(planeElement.id, shape);
        const modelElement = document.elements.get(shape.elementId);
        if (modelElement) {
          modelElement.position = { x: shape.bounds.x, y: shape.bounds.y };
          modelElement.size = { width: shape.bounds.width, height: shape.bounds.height };
          if (isFlowContainerType(modelElement.type)) {
            modelElement.properties.isExpanded = planeElement.isExpanded === true;
          }
        }
        const modelLane = document.lanes.get(shape.elementId);
        if (modelLane) {
          modelLane.position = { x: shape.bounds.x, y: shape.bounds.y };
          modelLane.size = { width: shape.bounds.width, height: shape.bounds.height };
        }
      } else if (planeElement.$type === 'bpmndi:BPMNEdge' && planeElement.bpmnElement?.id) {
        const edge = {
          id: planeElement.id,
          connectionId: planeElement.bpmnElement.id,
          waypoints: (planeElement.waypoint || []).map((point: any) => ({ x: point.x, y: point.y })),
          labelBounds: planeElement.label?.bounds ? {
            x: planeElement.label.bounds.x,
            y: planeElement.label.bounds.y,
            width: planeElement.label.bounds.width,
            height: planeElement.label.bounds.height
          } : undefined
        };
        document.diagram.edges.set(planeElement.id, edge);
        const modelConnection = document.connections.get(edge.connectionId);
        if (modelConnection) {
          modelConnection.waypoints = edge.waypoints.map((point: Position) => ({ ...point }));
        }
      }
    }

    this.rememberDocumentIds(document);
    return {
      id: primaryRoot.id,
      name,
      type,
      extensionProfile,
      document,
      elements: document.elements,
      connections: document.connections,
      xml,
      persistedXml: xml,
      mutationVersion: 0,
      revision: ''
    };
  }

  private assertImportStructureAndComplexity(definitions: any, limits: BpmnImportLimits): void {
    let elementCount = 0;
    let flowCount = 0;

    const requireId = (element: any): void => {
      if (typeof element?.id !== 'string' || element.id.length === 0) {
        throw new Error('BPMN import contains an element without a required ID');
      }
    };
    const incrementElements = (): void => {
      elementCount += 1;
      if (elementCount > limits.maxElements) {
        throw new Error('BPMN import exceeds the configured element limit');
      }
    };
    const incrementFlows = (): void => {
      flowCount += 1;
      if (flowCount > limits.maxFlows) {
        throw new Error('BPMN import exceeds the configured flow limit');
      }
    };
    const countArtifact = (artifact: any): void => {
      requireId(artifact);
      if (artifact?.$type === 'bpmn:Association') {
        incrementFlows();
      } else {
        incrementElements();
      }
    };
    const countFlowContainers = (initialContainer: any): void => {
      const pendingContainers = [initialContainer];
      while (pendingContainers.length > 0) {
        const container = pendingContainers.pop();
        for (const item of container?.flowElements || []) {
          requireId(item);
          if (isBpmnConnectionType(item.$type)) {
            incrementFlows();
          } else {
            incrementElements();
            if (isFlowContainerType(item.$type)) {
              pendingContainers.push(item);
            }
          }
        }
        for (const artifact of container?.artifacts || []) {
          countArtifact(artifact);
        }
      }
    };
    const countLaneSet = (laneSet: any): void => {
      requireId(laneSet);
      incrementElements();
      for (const lane of laneSet.lanes || []) {
        requireId(lane);
        incrementElements();
        if (lane.childLaneSet) countLaneSet(lane.childLaneSet);
      }
    };

    for (const root of definitions.rootElements || []) {
      requireId(root);
      incrementElements();
      if (root.$type === 'bpmn:Process') {
        countFlowContainers(root);
        for (const laneSet of root.laneSets || []) countLaneSet(laneSet);
      } else if (root.$type === 'bpmn:Collaboration') {
        for (const participant of root.participants || []) {
          requireId(participant);
          incrementElements();
        }
        for (const messageFlow of root.messageFlows || []) {
          requireId(messageFlow);
          incrementFlows();
        }
        for (const artifact of root.artifacts || []) {
          countArtifact(artifact);
        }
      }
    }

    let diElementCount = 0;
    for (const diagram of definitions.diagrams || []) {
      diElementCount += 1;
      if (diElementCount > limits.maxDiElements) {
        throw new Error('BPMN import exceeds the configured DI element limit');
      }
      if (diagram.plane) {
        diElementCount += 1;
        if (diElementCount > limits.maxDiElements) {
          throw new Error('BPMN import exceeds the configured DI element limit');
        }
      }
      for (const planeElement of diagram.plane?.planeElement || []) {
        requireId(planeElement);
        diElementCount += 1;
        if (diElementCount > limits.maxDiElements) {
          throw new Error('BPMN import exceeds the configured DI element limit');
        }
      }
    }
  }

  private applySupportedProperties(
    element: BpmnDocumentElement,
    semantic: any,
    semanticById: Map<string, any>,
    rootElements: any[],
    extensionProfile: BpmnExtensionProfile
  ): void {
    this.applyEventDefinitionProperties(element, semantic, semanticById, rootElements);
    this.applyDataObjectReferenceProperties(element, semantic, semanticById);
    this.applyMultiInstanceProperties(element, semantic, semanticById);

    if (element.type === 'bpmn:BoundaryEvent') {
      const attachedTo = element.properties.attachTo;
      if (typeof attachedTo !== 'string' || !attachedTo) {
        throw new Error(`Boundary event ${element.id} requires attachTo`);
      }
      const attachedToRef = semanticById.get(attachedTo);
      if (!attachedToRef) {
        throw new Error(`Boundary event ${element.id} references missing activity ${attachedTo}`);
      }
      semantic.attachedToRef = attachedToRef;
    }

    if (element.type === 'bpmn:CallActivity') {
      const calledElement = element.properties.calledElement;
      if (typeof calledElement === 'string') {
        if (!isBpmnQName(calledElement)) {
          throw new Error(`Call activity ${element.id} calledElement must be a valid BPMN QName`);
        }
        semantic.calledElement = calledElement;
      }
    }

    if (element.type === 'bpmn:TextAnnotation') {
      const text = element.properties.text;
      if (typeof text === 'string') {
        semantic.text = text;
      }
      const textFormat = element.properties.textFormat;
      if (typeof textFormat === 'string') {
        semantic.textFormat = textFormat;
      }
    }
    this.applyCamundaUserTaskProperties(element, semantic, extensionProfile);
  }

  private applyCamundaUserTaskProperties(
    element: BpmnDocumentElement,
    semantic: any,
    extensionProfile: BpmnExtensionProfile
  ): void {
    if (element.type !== 'bpmn:UserTask' || extensionProfile !== 'camunda7') return;
    semantic.assignee = element.properties.assignee;
    semantic.candidateGroups = Array.isArray(element.properties.candidateGroups)
      ? element.properties.candidateGroups.join(',')
      : undefined;
    semantic.dueDate = element.properties.dueDate;
  }

  private applyMultiInstanceProperties(
    element: BpmnDocumentElement,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    const raw = element.properties.multiInstance;
    if (raw === undefined) return;

    const existing = semantic.loopCharacteristics;
    if (existing && existing.$type !== 'bpmn:MultiInstanceLoopCharacteristics') {
      throw new Error(
        `Activity ${element.id} already has incompatible ${existing.$type}`
      );
    }

    const characteristics = existing
      || this.moddle.create('bpmn:MultiInstanceLoopCharacteristics');
    const multiInstance = raw as BpmnMultiInstanceLoopCharacteristics;
    characteristics.isSequential = multiInstance.isSequential;
    characteristics.loopCardinality = this.createLoopExpression(
      multiInstance.loopCardinality
    );
    characteristics.completionCondition = this.createLoopExpression(
      multiInstance.completionCondition
    );
    characteristics.loopDataInputRef = this.resolveLoopDataReference(
      element,
      'loopDataInputRef',
      multiInstance.loopDataInputRef,
      semanticById
    );
    characteristics.loopDataOutputRef = this.resolveLoopDataReference(
      element,
      'loopDataOutputRef',
      multiInstance.loopDataOutputRef,
      semanticById
    );
    semantic.loopCharacteristics = characteristics;
  }

  private createLoopExpression(expression?: BpmnLoopExpression): any {
    if (!expression) return undefined;
    return this.moddle.create('bpmn:FormalExpression', {
      body: expression.body,
      language: expression.language
    });
  }

  private resolveLoopDataReference(
    element: BpmnDocumentElement,
    property: 'loopDataInputRef' | 'loopDataOutputRef',
    referenceId: string | undefined,
    semanticById: Map<string, any>
  ): any {
    if (!referenceId) return undefined;
    const reference = semanticById.get(referenceId);
    if (!reference || reference.$instanceOf?.('bpmn:ItemAwareElement') !== true) {
      throw new Error(
        `Activity ${element.id} ${property} references missing ItemAwareElement ${referenceId}`
      );
    }
    return reference;
  }

  private applyDataObjectReferenceProperties(
    element: BpmnDocumentElement,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    if (element.type !== 'bpmn:DataObjectReference') return;

    const dataObjectId = element.properties.dataObjectRef;
    if (typeof dataObjectId !== 'string' || dataObjectId.length === 0) {
      throw new Error(`Data object reference ${element.id} has an invalid dataObjectRef`);
    }

    const dataObject = semanticById.get(dataObjectId);
    if (!dataObject) {
      throw new Error(`Data object reference ${element.id} references missing data object ${dataObjectId}`);
    }
    if (dataObject.$type !== 'bpmn:DataObject') {
      throw new Error(`Data object reference ${element.id} references non-data object ${dataObjectId}`);
    }
    semantic.dataObjectRef = dataObject;
  }

  private applyDataObjectProperties(
    dataObject: BpmnDataObject,
    semantic: any,
    semanticById: Map<string, any>
  ): void {
    if (dataObject.isCollection !== undefined) {
      semantic.isCollection = dataObject.isCollection;
    }
    if (dataObject.itemSubjectRef === null) {
      semantic.itemSubjectRef = undefined;
      return;
    }
    if (dataObject.itemSubjectRef === undefined) return;
    const itemDefinition = semanticById.get(dataObject.itemSubjectRef);
    if (!itemDefinition || itemDefinition.$type !== 'bpmn:ItemDefinition') {
      throw new Error(
        `Data object ${dataObject.id} references invalid itemSubjectRef ${dataObject.itemSubjectRef}`
      );
    }
    semantic.itemSubjectRef = itemDefinition;
  }

  private readLaneSet(
    laneSet: any,
    processId: string,
    parentLaneId: string | undefined,
    plane: any,
    document: BpmnDocument
  ): void {
    const laneIds = (laneSet.lanes || []).map((lane: any) => lane.id);
    document.laneSets.set(laneSet.id, {
      id: laneSet.id,
      processId,
      parentLaneId,
      laneIds
    });
    for (const lane of laneSet.lanes || []) {
      const shape = this.findShape(plane, lane.id);
      const model: BpmnLane = {
        id: lane.id,
        name: lane.name,
        processId,
        laneSetId: laneSet.id,
        flowNodeRefs: (lane.flowNodeRef || []).map((node: any) => node.id),
        position: this.readPosition(shape, { x: 100, y: 100 }),
        size: this.readSize(shape, { width: 600, height: 100 })
      };
      document.lanes.set(model.id, model);
      if (lane.childLaneSet) {
        this.readLaneSet(lane.childLaneSet, processId, lane.id, plane, document);
      }
    }
  }

  private readFlowContainer(container: any, ownerId: string, scopeId: string, document: BpmnDocument): void {
    for (const item of container.flowElements || []) {
      if (item.$type === 'bpmn:DataObject') {
        document.dataObjects.set(item.id, {
          id: item.id,
          name: item.name,
          ownerId,
          scopeId,
          isCollection: Object.prototype.hasOwnProperty.call(item, 'isCollection')
            ? item.isCollection
            : undefined,
          itemSubjectRef: item.itemSubjectRef?.id
        });
        continue;
      }
      if (isBpmnConnectionType(item.$type)) {
        this.readConnection(item, ownerId, scopeId, undefined, document);
        continue;
      }
      if (isBpmnFlowNodeType(item.$type)) {
        const element = this.readFlowNode(item, ownerId, scopeId);
        document.elements.set(element.id, element);
        if (isFlowContainerType(item.$type)) {
          this.readFlowContainer(item, ownerId, item.id, document);
        }
        continue;
      }
      if (isBpmnArtifactType(item.$type)) {
        const element = this.readArtifact(item, ownerId, scopeId);
        document.elements.set(element.id, element);
        continue;
      }
      // Retain valid moddle constructs outside the mutation API in sourceXml.
    }

    for (const artifact of container.artifacts || []) {
      this.readArtifactOrAssociation(artifact, ownerId, scopeId, undefined, document);
    }
  }

  private readFlowNode(item: any, ownerId: string, scopeId: string): BpmnFlowNodeElement {
    const type = item.$type as BpmnFlowNodeType;
    const definition = item.eventDefinitions?.[0];
    const eventDefinitionName = definition?.$type
      ? (Object.entries(EVENT_DEFINITION_TYPES)
          .find(([, value]) => value === definition.$type)?.[0] as EventDefinitionType | undefined)
      : undefined;
    const properties: Record<string, unknown> = {};
    if (item.loopCharacteristics?.$type === 'bpmn:MultiInstanceLoopCharacteristics') {
      const loop = item.loopCharacteristics;
      properties.multiInstance = {
        isSequential: loop.isSequential === true,
        ...(loop.loopCardinality ? {
          loopCardinality: this.readLoopExpression(loop.loopCardinality)
        } : {}),
        ...(loop.completionCondition ? {
          completionCondition: this.readLoopExpression(loop.completionCondition)
        } : {}),
        ...(loop.loopDataInputRef?.id ? { loopDataInputRef: loop.loopDataInputRef.id } : {}),
        ...(loop.loopDataOutputRef?.id ? { loopDataOutputRef: loop.loopDataOutputRef.id } : {})
      } satisfies BpmnMultiInstanceLoopCharacteristics;
    }
    if ((item.eventDefinitions || []).length === 1 && eventDefinitionName) {
      properties.eventDefinition = eventDefinitionName;
      const payload: EventDefinitionPayload = {};
      if (typeof definition.id === 'string') payload.definitionId = definition.id;

      if (eventDefinitionName === 'timer') {
        const timerType = (['timeDate', 'timeDuration', 'timeCycle'] as const)
          .find(candidate => definition[candidate]);
        if (timerType) {
          payload.timer = {
            type: timerType,
            expression: definition[timerType].body || '',
            language: definition[timerType].language
          };
        }
      } else if (eventDefinitionName === 'conditional' && definition.condition) {
        payload.condition = {
          expression: definition.condition.body || '',
          language: definition.condition.language
        };
      } else if (eventDefinitionName === 'compensation') {
        if (definition.activityRef?.id) payload.activityRef = definition.activityRef.id;
        if (typeof definition.waitForCompletion === 'boolean') {
          payload.waitForCompletion = definition.waitForCompletion;
        }
      }

      const referenceProperty = ROOT_EVENT_REFERENCE_PROPERTIES[eventDefinitionName];
      const reference = referenceProperty ? definition[referenceProperty] : undefined;
      if (reference?.id) {
        payload.reference = {
          id: reference.id,
          name: reference.name,
          code: eventDefinitionName === 'error'
            ? reference.errorCode
            : eventDefinitionName === 'escalation' ? reference.escalationCode : undefined
        };
      }
      properties.eventDefinitionPayload = payload;
    }
    if (item.attachedToRef?.id) {
      properties.attachTo = item.attachedToRef.id;
    }
    if (type === 'bpmn:BoundaryEvent' && typeof item.cancelActivity === 'boolean') {
      properties.cancelActivity = item.cancelActivity;
    }
    if (item.calledElement !== undefined && !isBpmnQName(item.calledElement)) {
      throw new Error(`Call activity ${item.id} calledElement must be a valid BPMN QName`);
    }
    if (typeof item.calledElement === 'string') {
      properties.calledElement = item.calledElement;
    }
    if (type === 'bpmn:UserTask') {
      if (typeof item.assignee === 'string' && item.assignee.length > 0) {
        properties.assignee = item.assignee;
      }
      if (typeof item.candidateGroups === 'string' && item.candidateGroups.length > 0) {
        const candidateGroups = item.candidateGroups.split(',');
        if (candidateGroups.every((group: string) => group.length > 0)) {
          properties.candidateGroups = candidateGroups;
        }
      }
      if (typeof item.dueDate === 'string' && item.dueDate.length > 0) {
        properties.dueDate = item.dueDate;
      }
    }

    return {
      kind: 'flowNode',
      id: item.id,
      type,
      name: item.name,
      ownerId,
      scopeId,
      defaultFlow: item.default?.id,
      defaultFlowManaged: item.default !== undefined,
      position: { x: 100, y: 100 },
      size: getDefaultElementSize(type),
      properties
    };
  }

  private readLoopExpression(expression: any): BpmnLoopExpression {
    return {
      body: expression.body ?? '',
      language: expression.language
    };
  }

  private detectExtensionProfile(elementsById: Record<string, any>): BpmnExtensionProfile {
    for (const element of Object.values(elementsById)) {
      const descriptor = element?.$descriptor;
      const model = element?.$model;
      if (!descriptor || !model) continue;
      const elementPackage = descriptor.ns?.prefix
        ? model.getPackage(descriptor.ns.prefix)
        : undefined;
      if (elementPackage?.uri === CAMUNDA_7_NAMESPACE) return 'camunda7';
      for (const property of descriptor.properties || []) {
        if (!Object.prototype.hasOwnProperty.call(element, property.name)
          || element[property.name] === undefined) continue;
        const propertyPackage = property.ns?.prefix
          ? model.getPackage(property.ns.prefix)
          : undefined;
        if (propertyPackage?.uri === CAMUNDA_7_NAMESPACE) return 'camunda7';
      }
    }
    return 'portable';
  }

  private readArtifact(item: any, ownerId: string, scopeId: string): BpmnArtifactElement {
    const type = item.$type as BpmnArtifactType;
    const properties: Record<string, unknown> = {};
    if (typeof item.text === 'string') {
      properties.text = item.text;
    }
    if (item.$type === 'bpmn:TextAnnotation' && typeof item.textFormat === 'string') {
      properties.textFormat = item.textFormat;
    }
    if (item.$type === 'bpmn:DataObjectReference' && item.dataObjectRef?.id) {
      properties.dataObjectRef = item.dataObjectRef.id;
      if (Object.prototype.hasOwnProperty.call(item.dataObjectRef, 'isCollection')) {
        properties.isCollection = item.dataObjectRef.isCollection;
      }
      if (item.dataObjectRef.itemSubjectRef?.id) {
        properties.itemSubjectRef = item.dataObjectRef.itemSubjectRef.id;
      }
    }
    return {
      kind: 'artifact',
      id: item.id,
      type,
      name: item.name,
      ownerId,
      scopeId,
      position: { x: 100, y: 100 },
      size: getDefaultElementSize(type),
      properties
    };
  }

  private readArtifactOrAssociation(
    item: any,
    ownerId: string,
    scopeId: string,
    plane: any,
    document: BpmnDocument
  ): void {
    if (item.$type === 'bpmn:Association') {
      this.readConnection(item, ownerId, scopeId, plane, document);
    } else if (isBpmnArtifactType(item.$type)) {
      document.elements.set(item.id, this.readArtifact(item, ownerId, scopeId));
    }
  }

  private readConnection(
    item: any,
    ownerId: string,
    scopeId: string,
    plane: any,
    document: BpmnDocument
  ): void {
    const type = item.$type;
    if (!isBpmnConnectionType(type)) {
      throw new Error(`Unsupported BPMN connection type in imported diagram: ${type}`);
    }
    const edge = this.findEdge(plane, item.id);
    const expression = item.conditionExpression;
    const connection: BpmnDocumentConnection = {
      id: item.id,
      type,
      source: item.sourceRef?.id || '',
      target: item.targetRef?.id || '',
      ownerId,
      scopeId,
      label: item.name,
      condition: expression ? {
        body: expression.body || '',
        type: expression.$type || 'bpmn:Expression',
        language: expression.language,
        evaluatesToTypeRef: expression.evaluatesToTypeRef?.id
      } : undefined,
      associationDirection: type === 'bpmn:Association'
        ? (item.associationDirection || 'None')
        : undefined,
      waypoints: (edge?.waypoint || []).map((point: any) => ({ x: point.x, y: point.y })),
      properties: {}
    };
    document.connections.set(connection.id, connection);
  }

  private assertImportedDataObjectReferences(document: BpmnDocument): void {
    for (const element of document.elements.values()) {
      if (element.type !== 'bpmn:DataObjectReference') continue;
      const dataObjectRef = element.properties.dataObjectRef;
      const dataObject = typeof dataObjectRef === 'string'
        ? document.dataObjects.get(dataObjectRef)
        : undefined;
      if (!dataObject) {
        throw new Error(`Data object reference ${element.id} has an invalid dataObjectRef`);
      }
      if (dataObject.ownerId !== element.ownerId || dataObject.scopeId !== element.scopeId) {
        throw new Error(`Data object reference ${element.id} crosses data object scope`);
      }
      if (dataObject.itemSubjectRef !== undefined && dataObject.itemSubjectRef !== null
        && !document.itemDefinitions.has(dataObject.itemSubjectRef)) {
        throw new Error(
          `Data object ${dataObject.id} references invalid itemSubjectRef ${dataObject.itemSubjectRef}`
        );
      }
    }
  }

  private assertImportedConnections(document: BpmnDocument): void {
    for (const connection of document.connections.values()) {
      const source = document.elements.get(connection.source);
      const target = document.elements.get(connection.target);
      if (!source || !target) {
        // A valid sequence flow may connect moddle types that are intentionally
        // not exposed by this engine. Keep it in sourceXml, not the typed index.
        document.connections.delete(connection.id);
        continue;
      }
      if (connection.type === 'bpmn:MessageFlow') {
        if (!document.collaborations.has(connection.ownerId)
          || connection.scopeId !== connection.ownerId) {
          throw new Error(`Imported message flow ${connection.id} has an invalid collaboration owner`);
        }
        try {
          assertValidMessageFlowEndpoints(document, connection.ownerId, source, target);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Imported message flow ${connection.id} is invalid: ${message}`);
        }
        continue;
      }
      if (connection.type !== 'bpmn:SequenceFlow') {
        if (connection.condition) {
          throw new Error(`Imported connection ${connection.id} cannot have a condition`);
        }
        if (connection.type === 'bpmn:Association') {
          if (!['None', 'One', 'Both'].includes(connection.associationDirection || 'None')) {
            throw new Error(`Imported association ${connection.id} has an invalid direction`);
          }
          let ownership: { ownerId: string; scopeId: string };
          try {
            ownership = resolveAssociationOwnership(document, source, target);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Imported association ${connection.id} is invalid: ${message}`);
          }
          if (connection.ownerId !== ownership.ownerId || connection.scopeId !== ownership.scopeId) {
            throw new Error(
              `Imported association ${connection.id} is not contained by its compatible owner and scope`
            );
          }
        }
        continue;
      }
      if (source.kind !== 'flowNode' || target.kind !== 'flowNode') {
        throw new Error(`Imported sequence flow ${connection.id} must connect BPMN flow nodes`);
      }
      if (source.ownerId !== target.ownerId || source.scopeId !== target.scopeId) {
        throw new Error(`Imported sequence flow ${connection.id} crosses process or nested-scope boundaries`);
      }
      if (connection.ownerId !== source.ownerId || connection.scopeId !== source.scopeId) {
        throw new Error(`Imported sequence flow ${connection.id} is not contained by its owner and scope`);
      }
      if (connection.condition && !supportsConditionalOutgoingFlow(source)) {
        throw new Error(`Imported sequence flow ${connection.id} has an unsupported conditional source`);
      }
      if (connection.condition && connection.condition.body.length === 0) {
        throw new Error(`Imported sequence flow ${connection.id} has an empty condition`);
      }
    }

    for (const element of document.elements.values()) {
      if (element.kind !== 'flowNode' || !element.defaultFlow) continue;
      const defaultFlow = document.connections.get(element.defaultFlow);
      if (!defaultFlow) {
        // The serializer retains valid constructs outside the typed mutation
        // surface in sourceXml, including their default-flow ownership.
        element.defaultFlow = undefined;
        element.defaultFlowManaged = false;
        continue;
      }
      if (!supportsConditionalOutgoingFlow(element)
        || defaultFlow.type !== 'bpmn:SequenceFlow'
        || defaultFlow.source !== element.id) {
        throw new Error(`Imported element ${element.id} references invalid default flow ${defaultFlow.id}`);
      }
      if (defaultFlow.condition) {
        throw new Error(`Imported default sequence flow ${defaultFlow.id} cannot have a condition`);
      }
    }
  }

  private findShape(plane: any, elementId: string): any {
    return (plane?.planeElement || []).find(
      (element: any) => element.$type === 'bpmndi:BPMNShape' && element.bpmnElement?.id === elementId
    );
  }

  private findEdge(plane: any, connectionId: string): any {
    return (plane?.planeElement || []).find(
      (element: any) => element.$type === 'bpmndi:BPMNEdge' && element.bpmnElement?.id === connectionId
    );
  }

  private readPosition(shape: any, fallback: Position): Position {
    return {
      x: shape?.bounds?.x ?? fallback.x,
      y: shape?.bounds?.y ?? fallback.y
    };
  }

  private readSize(shape: any, fallback: Size): Size {
    return {
      width: shape?.bounds?.width ?? fallback.width,
      height: shape?.bounds?.height ?? fallback.height
    };
  }
}
