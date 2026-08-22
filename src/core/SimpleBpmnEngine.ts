import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { isDeepStrictEqual } from 'util';
import { config } from '../config/index.js';
import type { BpmnImportLimits, ResourceLimits } from '../config/index.js';
import {
  BpmnConnectionType,
  BpmnConnectOptions,
  BpmnDataObject,
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnDocumentElement,
  BpmnElementType,
  BpmnElementUpdate,
  BpmnExtensionProfile,
  EventDefinitionPayload,
  EventDefinitionType,
  BpmnLane,
  BpmnMultiInstanceLoopCharacteristics,
  ElementDefinition,
  ProcessContext
} from '../types/index.js';
import { IdGenerator } from '../utils/IdGenerator.js';
import { FileManager } from '../utils/FileManager.js';
import { resolveSafeFilePath } from '../utils/SafeFilePath.js';
import {
  assertValidMessageFlowEndpoints,
  BpmnDocumentSerializer,
  calculateConnectionWaypoints,
  createProcessContext,
  getDefaultElementSize,
  isBpmnConnectionType,
  isBpmnElementType,
  isBpmnFlowNodeType,
  isBpmnQName,
  isSupportedEventDefinitionType,
  resolveAssociationOwnership,
  supportsEventDefinition,
  supportsConditionalOutgoingFlow
} from './BpmnDocument.js';
import { BpmnDocumentLayoutAdapter } from './layout/adapters/BpmnDocumentLayoutAdapter.js';
import { applyCollaborationLayoutPolicy } from './layout/CollaborationLayoutPolicy.js';
import {
  assertLayoutComplexity,
  BpmnAutoLayoutV2Adapter,
  type BpmnLayoutAdapter,
  type BpmnLayoutResult
} from './layout/BpmnLayoutAdapter.js';
import type { LayoutDirection, LayoutModel } from './layout/LayoutModel.js';

/**
 * Stateful BPMN engine backed by one typed document model and bpmn-moddle.
 * Existing flat-template files are migrated into the model during import;
 * unsupported semantic types are rejected instead of being coerced to tasks.
 */
export class SimpleBpmnEngine {
  private readonly processes = new Map<string, ProcessContext>();
  private readonly diagramsPath: string;
  private readonly serializer = new BpmnDocumentSerializer();
  private readonly fileManager: FileManager;
  private readonly importLimits: BpmnImportLimits;
  private readonly layoutAdapter: BpmnLayoutAdapter;
  private readonly resourceLimits: ResourceLimits;
  private readonly processLocks = new Map<string, Promise<void>>();

  constructor(
    diagramsPath = config.bpmnDiagramsPath,
    importLimits: BpmnImportLimits = config.bpmnImportLimits,
    layoutAdapter?: BpmnLayoutAdapter,
    resourceLimits: ResourceLimits = config.resourceLimits
  ) {
    this.diagramsPath = diagramsPath;
    this.fileManager = new FileManager(diagramsPath);
    this.importLimits = { ...importLimits };
    this.resourceLimits = { ...resourceLimits };
    this.layoutAdapter = layoutAdapter
      ?? new BpmnAutoLayoutV2Adapter(
        undefined,
        this.resourceLimits.layoutTimeoutMs,
        this.resourceLimits.maxConcurrentLayouts
      );
    if (Object.values(this.importLimits).some(
      limit => !Number.isSafeInteger(limit) || limit <= 0
    )) {
      throw new Error('Invalid BPMN import limits');
    }
    if (!Number.isSafeInteger(this.resourceLimits.maxMermaidBytes)
      || !Number.isSafeInteger(this.resourceLimits.maxLayoutElements)
      || !Number.isSafeInteger(this.resourceLimits.maxLayoutConnections)
      || !Number.isSafeInteger(this.resourceLimits.maxLayoutBytes)
      || !Number.isSafeInteger(this.resourceLimits.maxConcurrentLayouts)
      || !Number.isSafeInteger(this.resourceLimits.maxListingItems)
      || !Number.isSafeInteger(this.resourceLimits.layoutTimeoutMs)
      || !Number.isFinite(this.resourceLimits.maxLayoutDensity)
      || Object.values(this.resourceLimits).some(limit => limit <= 0)) {
      throw new Error('Invalid BPMN resource limits');
    }
  }

  async createProcess(
    name: string,
    type: 'process' | 'collaboration' = 'process',
    extensionProfile: BpmnExtensionProfile = 'portable'
  ): Promise<ProcessContext> {
    if (type !== 'process' && type !== 'collaboration') {
      throw new Error(`Unsupported BPMN root type: ${String(type)}`);
    }

    const rootId = this.generateUniqueId(undefined, type === 'process' ? 'Process' : 'Collaboration');
    const context = createProcessContext(rootId, name, type, extensionProfile);
    context.filename = this.defaultFilename(context);

    await this.commitMutation(context, () => undefined);
    this.processes.set(rootId, context);
    return context;
  }

  async createElement(processId: string, definition: ElementDefinition): Promise<BpmnDocumentElement> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      if (!isBpmnElementType(definition.type)) {
        throw new Error(`Unsupported BPMN element type: ${String(definition.type)}`);
      }

      const type = definition.type;
      const elementId = definition.id
        || this.generateUniqueId(working.document, type.slice('bpmn:'.length));
      if (this.hasId(working.document, elementId)) {
        throw new Error(`BPMN ID already exists: ${elementId}`);
      }
      const position = definition.position || {
        x: 100 + working.elements.size * 50,
        y: 200
      };
      const size = definition.size || getDefaultElementSize(type);
      const properties = { ...(definition.properties || {}) };
      if (['bpmn:SubProcess', 'bpmn:Transaction'].includes(type)
        && properties.isExpanded === undefined) {
        properties.isExpanded = true;
      }
      this.normalizeEventDefinitionProperties(working.document, type, properties);
      let element: BpmnDocumentElement;

      if (type === 'bpmn:Participant') {
        if (working.type !== 'collaboration') {
          throw new Error('Participants can only be added to collaboration diagrams');
        }
        if ((definition.ownerId && definition.ownerId !== working.id)
          || (definition.scopeId && definition.scopeId !== working.id)) {
          throw new Error(`Participant ${elementId} must belong to collaboration ${working.id}`);
        }
        const blackBox = properties.blackBox === true;
        const requestedProcessRef = properties.processRef;
        if (requestedProcessRef !== undefined
          && (typeof requestedProcessRef !== 'string' || requestedProcessRef.length === 0)) {
          throw new Error(`Participant ${elementId} has invalid processRef ${String(requestedProcessRef)}`);
        }
        if (blackBox && requestedProcessRef !== undefined) {
          throw new Error(`Black-box participant ${elementId} cannot define processRef`);
        }
        const processRef = blackBox
          ? undefined
          : (requestedProcessRef as string | undefined) || `${elementId}_Process`;
        if (processRef && (processRef === elementId || working.document.collaborations.has(processRef)
          || working.document.elements.has(processRef) || working.document.connections.has(processRef))) {
          throw new Error(`Participant ${elementId} has invalid processRef ${processRef}`);
        }
        element = {
          kind: 'participant',
          id: elementId,
          type,
          name: definition.name,
          ownerId: definition.ownerId || working.id,
          scopeId: definition.scopeId || working.id,
          processRef,
          position,
          size,
          properties
        };
        this.assertElementProperties(working, type, properties, element.ownerId, element.scopeId);
      } else {
        const mayBelongToCollaboration = working.type === 'collaboration'
          && ['bpmn:TextAnnotation', 'bpmn:Group'].includes(type);
        const ownerId = definition.ownerId
          || (mayBelongToCollaboration ? working.id : this.defaultProcessOwner(working));
        const scopeId = definition.scopeId || ownerId;
        const isCollaborationArtifact = mayBelongToCollaboration
          && ownerId === working.id
          && scopeId === working.id;
        if (!isCollaborationArtifact) {
          this.assertFlowScope(working.document, ownerId, scopeId);
        }
        element = isBpmnFlowNodeType(type)
          ? {
              kind: 'flowNode', id: elementId, type, name: definition.name, ownerId, scopeId,
              position, size, properties
            }
          : {
              kind: 'artifact', id: elementId, type, name: definition.name, ownerId, scopeId,
              position, size, properties
            };
        this.assertElementProperties(working, type, properties, element.ownerId, element.scopeId);
      }

      if (!definition.position && element.kind !== 'participant'
        && element.scopeId !== element.ownerId) {
        const scope = working.elements.get(element.scopeId)!;
        const siblingIndex = Array.from(working.elements.values())
          .filter(candidate => candidate.scopeId === element.scopeId).length;
        element.position = {
          x: scope.position.x + 40 + siblingIndex * 150,
          y: scope.position.y + 60
        };
      }

      if (element.kind === 'participant' && element.processRef
        && !working.document.processes.has(element.processRef)) {
        working.document.processes.set(element.processRef, {
          id: element.processRef,
          name: definition.name,
          isExecutable: true
        });
      }
      working.elements.set(element.id, element);
      if (element.type === 'bpmn:BoundaryEvent') {
        const host = working.elements.get(element.properties.attachTo as string)!;
        element.position = this.positionOnActivityBoundary(host, element.size, definition.position);
      }
      if (element.kind !== 'participant' && element.scopeId !== element.ownerId) {
        this.fitExpandedFlowContainers(working, element.scopeId);
      }
      return element;
    });
  }

  async addDataObject(
    processId: string,
    name: string,
    options: {
      position?: BpmnDocumentElement['position'];
      isCollection?: boolean;
      itemSubjectRef?: string;
      ownerId?: string;
      scopeId?: string;
    } = {}
  ): Promise<{ dataObject: BpmnDataObject; reference: BpmnDocumentElement }> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      const ownerId = options.ownerId || this.defaultProcessOwner(working);
      const scopeId = options.scopeId || ownerId;
      this.assertFlowScope(working.document, ownerId, scopeId);

      const dataObject: BpmnDataObject = {
        id: this.generateUniqueId(working.document, 'DataObject'),
        name,
        ownerId,
        scopeId,
        isCollection: options.isCollection ?? false,
        itemSubjectRef: options.itemSubjectRef
      };
      working.document.dataObjects.set(dataObject.id, dataObject);

      const reference: BpmnDocumentElement = {
        kind: 'artifact',
        id: this.generateUniqueId(working.document, 'DataObjectReference'),
        type: 'bpmn:DataObjectReference',
        name,
        ownerId,
        scopeId,
        position: options.position || {
          x: 100 + working.elements.size * 50,
          y: 200
        },
        size: getDefaultElementSize('bpmn:DataObjectReference'),
        properties: {
          dataObjectRef: dataObject.id,
          isCollection: dataObject.isCollection,
          ...(dataObject.itemSubjectRef ? { itemSubjectRef: dataObject.itemSubjectRef } : {})
        }
      };
      this.assertElementProperties(
        working,
        reference.type,
        reference.properties,
        ownerId,
        scopeId
      );
      working.elements.set(reference.id, reference);
      if (!options.position && scopeId !== ownerId) {
        const scope = working.elements.get(scopeId)!;
        const siblingIndex = Array.from(working.elements.values())
          .filter(candidate => candidate.scopeId === scopeId).length;
        reference.position = {
          x: scope.position.x + 40 + siblingIndex * 150,
          y: scope.position.y + 60
        };
      }
      if (scopeId !== ownerId) this.fitExpandedFlowContainers(working, scopeId);
      return { dataObject, reference };
    });
  }

  async addTextAnnotation(
    processId: string,
    text: string,
    options: {
      textFormat?: string;
      position?: BpmnDocumentElement['position'];
      size?: BpmnDocumentElement['size'];
      associatedElementId?: string;
    } = {}
  ): Promise<{
    annotation: BpmnDocumentElement;
    association?: BpmnDocumentConnection;
  }> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Text annotation text must not be blank');
    }
    if (options.textFormat !== undefined
      && (typeof options.textFormat !== 'string' || options.textFormat.trim().length === 0)) {
      throw new Error('Text annotation textFormat must not be blank');
    }

    const context = this.getProcess(processId);
    const associatedElement = options.associatedElementId === undefined
      ? undefined
      : context.elements.get(options.associatedElementId);
    if (options.associatedElementId !== undefined && !associatedElement) {
      throw new Error(`Associated element ${options.associatedElementId} not found`);
    }

    const annotation = await this.createElement(processId, {
      type: 'bpmn:TextAnnotation',
      position: options.position,
      size: options.size,
      ownerId: associatedElement?.ownerId,
      scopeId: associatedElement?.scopeId,
      properties: {
        text,
        ...(options.textFormat === undefined ? {} : { textFormat: options.textFormat })
      }
    });
    const association = associatedElement
      ? await this.addAssociation(processId, annotation.id, associatedElement.id)
      : undefined;

    return { annotation, association };
  }

  async connect(
    processId: string,
    sourceId: string,
    targetId: string,
    label?: string,
    typeOrOptions?: BpmnConnectionType | BpmnConnectOptions,
    options: BpmnConnectOptions = {}
  ): Promise<BpmnDocumentConnection> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      const type = typeof typeOrOptions === 'string' ? typeOrOptions : undefined;
      const connectionOptions = typeof typeOrOptions === 'string'
        ? options
        : (typeOrOptions || options);
      if (connectionOptions.isDefault !== undefined
        && typeof connectionOptions.isDefault !== 'boolean') {
        throw new Error('isDefault must be a boolean');
      }
      const isDefault = connectionOptions.isDefault ?? false;
      const associationDirection = connectionOptions.associationDirection ?? 'None';
      if (!['None', 'One', 'Both'].includes(associationDirection)) {
        throw new Error(`Invalid association direction: ${String(associationDirection)}`);
      }
      if (type !== undefined && !isBpmnConnectionType(type)) {
        throw new Error(`Unsupported BPMN connection type: ${String(type)}`);
      }
      const source = working.elements.get(sourceId);
      const target = working.elements.get(targetId);
      if (!source || !target) {
        throw new Error('Source or target element not found');
      }

      let resolvedType = type;
      if (resolvedType === undefined) {
        if (source.kind === 'flowNode' && target.kind === 'flowNode'
          && source.ownerId === target.ownerId) {
          if (source.scopeId !== target.scopeId) {
            throw new Error('Sequence flows cannot cross process or nested-scope boundaries');
          }
          resolvedType = 'bpmn:SequenceFlow';
        } else if (working.type === 'collaboration') {
          assertValidMessageFlowEndpoints(working.document, working.id, source, target);
          resolvedType = 'bpmn:MessageFlow';
        } else {
          resolvedType = 'bpmn:SequenceFlow';
        }
      }

      let ownerId: string;
      let scopeId: string;
      if (resolvedType === 'bpmn:SequenceFlow') {
        if (source.kind !== 'flowNode' || target.kind !== 'flowNode') {
          throw new Error('Sequence flows can only connect BPMN flow nodes');
        }
        if (source.ownerId !== target.ownerId || source.scopeId !== target.scopeId) {
          throw new Error('Sequence flows cannot cross process or nested-scope boundaries');
        }
        ownerId = source.ownerId;
        scopeId = source.scopeId;
      } else if (resolvedType === 'bpmn:MessageFlow') {
        if (working.type !== 'collaboration') {
          throw new Error('Message flows can only be added to collaboration diagrams');
        }
        assertValidMessageFlowEndpoints(working.document, working.id, source, target);
        ownerId = working.id;
        scopeId = working.id;
      } else {
        ({ ownerId, scopeId } = resolveAssociationOwnership(working.document, source, target));
      }

      if (connectionOptions.associationDirection !== undefined
        && resolvedType !== 'bpmn:Association') {
        throw new Error('associationDirection can only be set for associations');
      }

      const condition = this.normalizeCondition(connectionOptions);
      if (condition && resolvedType !== 'bpmn:SequenceFlow') {
        throw new Error('Conditions can only be added to sequence flows');
      }
      if (condition && !supportsConditionalOutgoingFlow(source)) {
        throw new Error(`Element ${source.id} cannot own a conditional sequence flow`);
      }
      if (isDefault && resolvedType !== 'bpmn:SequenceFlow') {
        throw new Error('Only sequence flows can be default flows');
      }
      if (isDefault && !supportsConditionalOutgoingFlow(source)) {
        throw new Error(`Element ${source.id} cannot own a default sequence flow`);
      }
      if (isDefault && condition) {
        throw new Error('A default sequence flow cannot have a condition');
      }
      if (isDefault && source.kind === 'flowNode' && source.defaultFlow) {
        throw new Error(`Element ${source.id} already owns default flow ${source.defaultFlow}`);
      }
      const flowId = this.generateUniqueId(working.document, this.connectionPrefix(resolvedType));
      const connection: BpmnDocumentConnection = {
        id: flowId, source: sourceId, target: targetId, type: resolvedType, ownerId, scopeId, label,
        condition,
        associationDirection: resolvedType === 'bpmn:Association' ? associationDirection : undefined,
        waypoints: calculateConnectionWaypoints(source, target), properties: {}
      };
      working.connections.set(flowId, connection);
      if (isDefault && source.kind === 'flowNode') {
        source.defaultFlow = flowId;
        source.defaultFlowManaged = true;
      }
      return connection;
    });
  }

  /** Create a BPMN artifact association. The BPMN direction defaults to None. */
  async addAssociation(
    processId: string,
    sourceId: string,
    targetId: string,
    associationDirection: BpmnConnectOptions['associationDirection'] = 'None'
  ): Promise<BpmnDocumentConnection> {
    return this.connect(
      processId,
      sourceId,
      targetId,
      undefined,
      'bpmn:Association',
      { associationDirection }
    );
  }

  async addLane(
    processId: string,
    poolId: string,
    name: string,
    flowNodeIds: string[],
    position: 'top' | 'bottom' = 'bottom'
  ): Promise<BpmnLane> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      if (working.type !== 'collaboration') {
        throw new Error('Lanes can only be added to pools in collaboration diagrams');
      }
      const participant = working.elements.get(poolId);
      if (!participant || participant.kind !== 'participant') {
        throw new Error(`Participant ${poolId} not found`);
      }
      if (!participant.processRef || !working.document.processes.has(participant.processRef)) {
        throw new Error(`Participant ${poolId} does not reference a process`);
      }
      if (position !== 'top' && position !== 'bottom') {
        throw new Error(`Invalid lane position: ${String(position)}`);
      }
      if (!Array.isArray(flowNodeIds) || flowNodeIds.length === 0) {
        throw new Error('A lane requires at least one flowNodeId');
      }
      if (new Set(flowNodeIds).size !== flowNodeIds.length) {
        throw new Error('Lane flowNodeIds must be unique');
      }

      const processRef = participant.processRef;
      for (const memberId of flowNodeIds) {
        const member = working.elements.get(memberId);
        if (!member || member.kind !== 'flowNode') {
          throw new Error(`Lane member ${memberId} is not a flow node`);
        }
        if (member.ownerId !== processRef || member.scopeId !== processRef) {
          throw new Error(`Lane member ${memberId} is not in participant ${poolId}'s process scope`);
        }
      }

      const topLevelLaneSets = Array.from(working.document.laneSets.values())
        .filter(laneSet => laneSet.processId === processRef && laneSet.parentLaneId === undefined);
      if (topLevelLaneSets.length > 1) {
        throw new Error(`Process ${processRef} has multiple top-level lane sets`);
      }
      const laneSet = topLevelLaneSets[0] || {
        id: this.generateUniqueId(working.document, 'LaneSet'),
        processId: processRef,
        laneIds: []
      };
      if (laneSet.laneIds.some(laneId => Array.from(working.document.laneSets.values())
        .some(candidate => candidate.parentLaneId === laneId))) {
        throw new Error('Adding a top-level lane to a nested lane hierarchy is not supported');
      }
      if (!topLevelLaneSets[0]) working.document.laneSets.set(laneSet.id, laneSet);

      // BPMN lane assignment is exclusive within a process. Supplying an
      // existing member therefore moves it from its previous lane.
      for (const lane of working.document.lanes.values()) {
        if (lane.processId === processRef) {
          lane.flowNodeRefs = lane.flowNodeRefs.filter(id => !flowNodeIds.includes(id));
        }
      }
      const lane: BpmnLane = {
        id: this.generateUniqueId(working.document, 'Lane'),
        name,
        processId: processRef,
        laneSetId: laneSet.id,
        flowNodeRefs: [...flowNodeIds],
        position: { x: participant.position.x + 30, y: participant.position.y },
        size: { width: Math.max(1, participant.size.width - 30), height: participant.size.height }
      };
      working.document.lanes.set(lane.id, lane);
      if (position === 'top') laneSet.laneIds.unshift(lane.id);
      else laneSet.laneIds.push(lane.id);
      this.layoutPoolLanes(working, participant.id);
      return lane;
    });
  }

  async updateElement(
    processId: string,
    elementId: string,
    update: BpmnElementUpdate
  ): Promise<BpmnDocumentElement | BpmnLane> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      const workingLane = working.document.lanes.get(elementId);
      if (workingLane) {
        if (update.properties && Object.keys(update.properties).length > 0) {
          throw new Error('Lane membership is changed by add_lane assignment semantics');
        }
        if (update.name !== undefined) workingLane.name = update.name;
        return workingLane;
      }
      const workingElement = working.elements.get(elementId);
      if (!workingElement) {
        throw new Error(`Element ${elementId} not found`);
      }
      if (workingElement.kind === 'participant' && update.properties
        && (Object.prototype.hasOwnProperty.call(update.properties, 'processRef')
          || Object.prototype.hasOwnProperty.call(update.properties, 'blackBox'))) {
        throw new Error('Participant processRef and blackBox mode cannot be changed after creation');
      }
      const hasDefaultFlowUpdate = Object.prototype.hasOwnProperty.call(update, 'defaultFlow');
      const requestedDefaultFlow = update.defaultFlow;
      const workingProperties = update.properties
        ? { ...workingElement.properties, ...update.properties }
        : workingElement.properties;
      if (update.properties) {
        for (const key of ['assignee', 'candidateGroups', 'dueDate']) {
          if (update.properties[key] === null) delete workingProperties[key];
        }
      }
      if (workingElement.type === 'bpmn:BoundaryEvent'
        && update.properties
        && Object.prototype.hasOwnProperty.call(update.properties, 'eventDefinition')
        && !Object.prototype.hasOwnProperty.call(update.properties, 'cancelActivity')) {
        delete workingProperties.cancelActivity;
      }
      if (update.properties && (
        Object.prototype.hasOwnProperty.call(update.properties, 'eventDefinition')
        || Object.prototype.hasOwnProperty.call(update.properties, 'eventDefinitionPayload')
      )) {
        this.normalizeEventDefinitionProperties(
          working.document,
          workingElement.type,
          workingProperties
        );
      }
      this.assertElementProperties(
        working,
        workingElement.type,
        workingProperties,
        workingElement.ownerId,
        workingElement.scopeId
      );
      if (workingElement.type === 'bpmn:DataObjectReference' && update.properties) {
        const dataObject = working.document.dataObjects.get(
          workingProperties.dataObjectRef as string
        )!;
        if (Object.prototype.hasOwnProperty.call(update.properties, 'isCollection')) {
          dataObject.isCollection = workingProperties.isCollection as boolean;
        }
        if (Object.prototype.hasOwnProperty.call(update.properties, 'itemSubjectRef')) {
          dataObject.itemSubjectRef = workingProperties.itemSubjectRef as string | null;
          if (dataObject.itemSubjectRef === null) delete workingProperties.itemSubjectRef;
        }
      }
      if (update.name !== undefined) {
        workingElement.name = update.name;
      }
      if (update.properties) {
        workingElement.properties = workingProperties;
      }
      if (workingElement.type === 'bpmn:BoundaryEvent'
        && update.properties?.attachTo !== undefined) {
        const host = working.elements.get(workingElement.properties.attachTo as string)!;
        workingElement.position = this.positionOnActivityBoundary(
          host,
          workingElement.size,
          workingElement.position
        );
      }
      if (hasDefaultFlowUpdate) {
        if (workingElement.kind !== 'flowNode') {
          throw new Error(`Element ${workingElement.id} cannot own a default sequence flow`);
        }
        this.assertDefaultFlowAssignment(working, workingElement, requestedDefaultFlow);
        workingElement.defaultFlow = requestedDefaultFlow == null
          ? undefined
          : requestedDefaultFlow as string;
        workingElement.defaultFlowManaged = true;
      }
      if (workingElement.kind === 'flowNode'
        && ['bpmn:SubProcess', 'bpmn:Transaction'].includes(workingElement.type)
        && workingElement.properties.isExpanded === true) {
        this.fitExpandedFlowContainers(working, workingElement.id);
      }
      return workingElement;
    });
  }

  async deleteElement(processId: string, elementId: string): Promise<number> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      const lane = working.document.lanes.get(elementId);
      if (lane) {
        const processRef = lane.processId;
        this.deleteLaneHierarchy(working.document, lane.id);
        const participant = Array.from(working.elements.values()).find(
          candidate => candidate.kind === 'participant' && candidate.processRef === processRef
        );
        if (participant?.kind === 'participant') this.layoutPoolLanes(working, participant.id);
        return 0;
      }
      const element = working.elements.get(elementId);
      if (!element) {
        throw new Error(`Element ${elementId} not found`);
      }

      const idsToDelete = new Set<string>([elementId]);
      let foundNested = true;
      while (foundNested) {
        foundNested = false;
        for (const candidate of working.elements.values()) {
          const attachTo = candidate.properties.attachTo;
          const isAttachedBoundary = candidate.type === 'bpmn:BoundaryEvent'
            && typeof attachTo === 'string'
            && idsToDelete.has(attachTo);
          if ((idsToDelete.has(candidate.scopeId) || isAttachedBoundary)
            && !idsToDelete.has(candidate.id)) {
            idsToDelete.add(candidate.id);
            foundNested = true;
          }
        }
      }

      let removesOwnedProcess = false;
      if (element.kind === 'participant') {
        const hasOtherParticipantForProcess = Array.from(working.elements.values()).some(
          candidate => candidate.kind === 'participant'
            && candidate.id !== element.id
            && candidate.processRef === element.processRef
        );
        if (element.processRef && !hasOtherParticipantForProcess) {
          removesOwnedProcess = true;
          for (const candidate of working.elements.values()) {
            if (candidate.ownerId === element.processRef) {
              idsToDelete.add(candidate.id);
            }
          }
        }
      }

      const connectionsToDelete: string[] = [];
      for (const connection of working.connections.values()) {
        if (idsToDelete.has(connection.source) || idsToDelete.has(connection.target)
          || (removesOwnedProcess && element.kind === 'participant' && element.processRef
            && (connection.ownerId === element.processRef || connection.scopeId === element.processRef))) {
          connectionsToDelete.push(connection.id);
        }
      }
      if (removesOwnedProcess && element.kind === 'participant' && element.processRef) {
        working.document.processes.delete(element.processRef);
        for (const lane of Array.from(working.document.lanes.values())) {
          if (lane.processId === element.processRef) this.deleteLaneHierarchy(working.document, lane.id);
        }
      }
      const dataObjectIdsFromDeletedReferences = new Set(
        Array.from(working.elements.values())
          .filter(candidate => idsToDelete.has(candidate.id)
            && candidate.type === 'bpmn:DataObjectReference'
            && typeof candidate.properties.dataObjectRef === 'string')
          .map(candidate => candidate.properties.dataObjectRef as string)
      );
      for (const id of idsToDelete) {
        working.elements.delete(id);
        for (const lane of working.document.lanes.values()) {
          lane.flowNodeRefs = lane.flowNodeRefs.filter(flowNodeId => flowNodeId !== id);
        }
      }
      for (const dataObject of Array.from(working.document.dataObjects.values())) {
        const referenceStillExists = Array.from(working.elements.values()).some(
          candidate => candidate.type === 'bpmn:DataObjectReference'
            && candidate.properties.dataObjectRef === dataObject.id
        );
        const removedWithScope = idsToDelete.has(dataObject.scopeId)
          || (removesOwnedProcess && element.kind === 'participant'
            && dataObject.ownerId === element.processRef);
        if ((dataObjectIdsFromDeletedReferences.has(dataObject.id) && !referenceStillExists)
          || removedWithScope) {
          working.document.dataObjects.delete(dataObject.id);
        }
      }
      for (const connectionId of connectionsToDelete) {
        working.connections.delete(connectionId);
      }
      for (const candidate of working.elements.values()) {
        if (candidate.kind === 'flowNode' && candidate.defaultFlow
          && connectionsToDelete.includes(candidate.defaultFlow)) {
          candidate.defaultFlow = undefined;
          candidate.defaultFlowManaged = true;
        }
      }
      return connectionsToDelete.length;
    });
  }

  async deleteAssociation(processId: string, associationId: string): Promise<void> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, working => {
      const connection = working.connections.get(associationId);
      if (!connection || connection.type !== 'bpmn:Association') {
        throw new Error(`Association ${associationId} not found`);
      }
      working.connections.delete(associationId);
    });
  }

  async exportXml(processId: string, formatted = true): Promise<string> {
    const context = this.getProcess(processId);
    return this.withProcessLock(processId, () => this.serializer.serialize(
      this.cloneDocument(context.document),
      formatted
    ));
  }

  async save(processId: string): Promise<string> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, () => undefined);
    return context.filename!;
  }

  async saveAs(processId: string, filename: string): Promise<string> {
    const context = this.getProcess(processId);
    const normalizedFilename = extname(filename) === ''
      && !filename.toLowerCase().endsWith('.bpmn')
      ? `${filename}.bpmn`
      : filename;
    await this.commitMutation(
      context,
      working => {
        working.filename = normalizedFilename;
      },
      normalizedFilename,
      false
    );
    return normalizedFilename;
  }

  getActiveFilename(processId: string): string {
    const context = this.getProcess(processId);
    if (!context.filename) {
      throw new Error(`Process ${processId} has no active filename`);
    }
    return context.filename;
  }

  async importXml(
    xml: string,
    name?: string,
    authoredProfile?: BpmnExtensionProfile
  ): Promise<ProcessContext> {
    if (typeof xml !== 'string') {
      throw new Error('BPMN import rejected: XML input must be text');
    }
    if (Buffer.byteLength(xml, 'utf8') > this.importLimits.maxBytes) {
      throw new Error('BPMN import rejected: configured byte limit exceeded');
    }

    let context: ProcessContext;
    try {
      context = await this.serializer.parse(xml, this.importLimits);
    } catch (error) {
      throw this.safeImportError(error);
    }

    if (name !== undefined) {
      context.name = name;
      const root = context.type === 'process'
        ? context.document.processes.get(context.id)
        : context.document.collaborations.get(context.id);
      if (root) root.name = name;
    }
    if (authoredProfile !== undefined) {
      context.extensionProfile = authoredProfile;
      context.document.extensionProfile = authoredProfile;
    }
    context.filename = this.defaultFilename(context);
    await this.commitMutation(context, () => undefined);
    this.processes.set(context.id, context);
    return context;
  }

  getProcess(processId: string): ProcessContext {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }
    return process;
  }

  async listDiagrams(): Promise<Array<{ filename: string; path: string; name: string; processId: string }>> {
    try {
      const filenames: string[] = [];
      const directory = await fs.opendir(this.diagramsPath);
      let scannedEntries = 0;
      for await (const entry of directory) {
        scannedEntries++;
        if (scannedEntries > this.resourceLimits.maxListingItems) {
          throw new Error(
            `Diagram listing rejected: scan limit ${this.resourceLimits.maxListingItems} exceeded`
          );
        }
        if (!entry.isFile() || !entry.name.endsWith('.bpmn')) continue;
        filenames.push(entry.name);
      }
      const diagrams: Array<{ filename: string; path: string; name: string; processId: string }> = [];
      for (const filename of filenames) {
        const encodedMetadata = this.metadataFromDefaultFilename(filename);
        const match = filename.match(/^(.+?)_(.+)\.bpmn$/);
        let processId = encodedMetadata?.processId
          ?? (match ? match[1] : filename.replace('.bpmn', ''));
        let name = encodedMetadata?.name
          ?? (match ? match[2].replace(/_/g, ' ') : filename.replace('.bpmn', ''));
        if (!encodedMetadata) {
          try {
            const xml = await this.fileManager.readBpmnFile(filename, this.importLimits.maxBytes);
            const context = await this.serializer.parse(xml, this.importLimits);
            processId = context.id;
            name = context.name;
          } catch {
            // Preserve the historical filename-derived listing for files that
            // cannot be loaded; valid BPMN metadata is authoritative otherwise.
          }
        }
        diagrams.push({
          filename,
          path: join(this.diagramsPath, filename),
          processId,
          name
        });
      }
      return diagrams;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async loadDiagram(filename: string): Promise<ProcessContext> {
    const xml = await this.fileManager.readBpmnFile(filename, this.importLimits.maxBytes);
    let context: ProcessContext;
    try {
      context = await this.serializer.parse(xml, this.importLimits);
    } catch (error) {
      throw this.safeImportError(error);
    }
    context.filename = filename;
    this.processes.set(context.id, context);
    return context;
  }

  async deleteDiagram(filename: string): Promise<void> {
    const activeContext = Array.from(this.processes.values())
      .find(context => context.filename === filename);
    const remove = async (): Promise<void> => {
      const filepath = await resolveSafeFilePath({
        rootDirectory: this.diagramsPath,
        filename,
        allowedExtensions: ['.bpmn'],
        access: 'delete'
      });
      try {
        // Node does not expose unlinkat(2) with a directory file descriptor, so
        // a residual race remains between the symlink checks and this unlink.
        await fs.unlink(filepath);
      } catch {
        throw new Error('Unable to delete BPMN file');
      }
      if (activeContext?.filename === filename) {
        this.processes.delete(activeContext.id);
      }
    };

    if (activeContext) {
      await this.withProcessLock(activeContext.id, remove);
    } else {
      await remove();
    }
  }

  getDiagramsPath(): string {
    return this.diagramsPath;
  }

  async applyAutoLayout(
    processId: string,
    algorithm: 'horizontal' | 'vertical' = 'horizontal'
  ): Promise<BpmnLayoutResult> {
    if (algorithm !== 'horizontal') {
      throw new Error('Only horizontal layout algorithm is currently supported');
    }
    const snapshot = await this.withProcessLock(processId, async () => {
      const context = this.getProcess(processId);
      const xml = await this.serializer.serialize(this.cloneDocument(context.document), true);
      return {
        xml,
        document: this.cloneDocument(context.document),
        elementCount: context.elements.size + context.document.lanes.size,
        connectionCount: context.connections.size
      };
    });
    assertLayoutComplexity(
      snapshot.elementCount,
      snapshot.connectionCount,
      Buffer.byteLength(snapshot.xml, 'utf8'),
      this.resourceLimits
    );
    const hasWhiteBoxParticipant = Array.from(snapshot.document.elements.values()).some(
      element => element.kind === 'participant' && element.processRef !== undefined
    );
    if (snapshot.document.collaborations.has(snapshot.document.diagram.planeElementId)
      && !hasWhiteBoxParticipant) {
      const context = this.getProcess(processId);
      await this.commitMutation(context, working => {
        const requested = this.cloneDocument(working.document);
        applyCollaborationLayoutPolicy(requested, working.document);
      });
      return { xml: context.xml!, warnings: [] };
    }
    const result = await this.layoutAdapter.layout(snapshot.xml);
    await this.applyLayoutXml(processId, result.xml, snapshot.document);
    return result;
  }

  getLayoutModel(
    processId: string,
    direction: LayoutDirection = 'left-to-right'
  ): LayoutModel {
    return BpmnDocumentLayoutAdapter.fromContext(this.getProcess(processId), direction);
  }

  async applyLayoutModel(processId: string, layout: LayoutModel): Promise<void> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, working => {
      BpmnDocumentLayoutAdapter.applyToContext(layout, working);
      this.repositionBoundaryEvents(working);
    });
  }

  /**
   * Atomically adopt XML returned by a successful external layout adapter.
   * Adapter warnings are handled before this boundary; this method accepts
   * only XML whose semantics still match the active mutable document.
   */
  async applyLayoutXml(
    processId: string,
    xml: string,
    requestedLayout?: BpmnDocument
  ): Promise<void> {
    if (typeof xml !== 'string') {
      throw new Error('Layout XML must be text');
    }
    if (Buffer.byteLength(xml, 'utf8') > this.importLimits.maxBytes) {
      throw new Error('Layout XML exceeds the configured byte limit');
    }

    const context = this.getProcess(processId);
    await this.commitMutation(context, async working => {
      let laidOut: ProcessContext;
      try {
        laidOut = await this.serializer.parse(xml, this.importLimits);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse layout XML: ${message}`);
      }
      this.assertLayoutSemanticsUnchanged(working.document, laidOut.document);
      if (requestedLayout) {
        applyCollaborationLayoutPolicy(requestedLayout, laidOut.document);
      }
      working.document = laidOut.document;
      working.elements = laidOut.document.elements;
      working.connections = laidOut.document.connections;
    });
  }

  clear(): void {
    this.processes.clear();
    IdGenerator.reset();
  }

  /**
   * The single commit path for model mutations and explicit saves. Serialization
   * performs structural validation; the atomic file write completes before the
   * new XML becomes visible in memory. Any failure restores the full model.
   */
  private async commitMutation<T>(
    context: ProcessContext,
    mutation: (working: ProcessContext) => T | Promise<T>,
    filename?: string,
    overwrite = true
  ): Promise<T> {
    return this.withProcessLock(context.id, async () => {
      const targetFilename = filename || context.filename;
      if (!targetFilename) {
        throw new Error(`Process ${context.id} has no active filename`);
      }
      const workingDocument = this.cloneDocument(context.document);
      const working: ProcessContext = {
        id: context.id,
        name: context.name,
        type: context.type,
        extensionProfile: context.extensionProfile,
        filename: context.filename,
        document: workingDocument,
        elements: workingDocument.elements,
        connections: workingDocument.connections,
        xml: context.xml,
      };

      const value = await mutation(working);
      const xml = await this.serializer.serialize(working.document);
      const saveResult = await this.fileManager.saveBpmnFile(xml, {
        filename: targetFilename,
        overwrite
      });
      if (!saveResult.success) {
        throw new Error(saveResult.error || 'Unable to save BPMN file');
      }
      context.document = working.document;
      context.extensionProfile = working.document.extensionProfile;
      context.elements = working.elements;
      context.connections = working.connections;
      context.xml = xml;
      context.filename = working.filename;
      return value;
    });
  }

  private async withProcessLock<T>(processId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.processLocks.get(processId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.processLocks.set(processId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.processLocks.get(processId) === tail) {
        this.processLocks.delete(processId);
      }
    }
  }

  private deleteLaneHierarchy(document: BpmnDocument, laneId: string): void {
    for (const childSet of Array.from(document.laneSets.values())) {
      if (childSet.parentLaneId !== laneId) continue;
      for (const childLaneId of [...childSet.laneIds]) {
        this.deleteLaneHierarchy(document, childLaneId);
      }
      document.laneSets.delete(childSet.id);
    }
    const lane = document.lanes.get(laneId);
    if (!lane) return;
    const laneSet = document.laneSets.get(lane.laneSetId);
    if (laneSet) {
      laneSet.laneIds = laneSet.laneIds.filter(id => id !== laneId);
      if (laneSet.laneIds.length === 0) document.laneSets.delete(laneSet.id);
    }
    document.lanes.delete(laneId);
  }

  private fitExpandedFlowContainers(context: ProcessContext, startScopeId: string): void {
    const resized = new Set<string>();
    const visited = new Set<string>();
    let scopeId: string | undefined = startScopeId;

    while (scopeId && !visited.has(scopeId)) {
      visited.add(scopeId);
      const container = context.elements.get(scopeId);
      if (!container || container.kind !== 'flowNode'
        || !['bpmn:SubProcess', 'bpmn:Transaction'].includes(container.type)) {
        break;
      }

      if (container.properties.isExpanded === true) {
        const children = Array.from(context.elements.values())
          .filter(element => element.id !== container.id && element.scopeId === container.id);
        if (children.length > 0) {
          const horizontalPadding = 30;
          const topPadding = 50;
          const bottomPadding = 30;
          const minimum = getDefaultElementSize(container.type);
          const minimumX = Math.min(...children.map(child => child.position.x));
          const minimumY = Math.min(...children.map(child => child.position.y));
          const maximumX = Math.max(...children.map(child => child.position.x + child.size.width));
          const maximumY = Math.max(...children.map(child => child.position.y + child.size.height));
          const right = Math.max(
            container.position.x + Math.max(container.size.width, minimum.width),
            maximumX + horizontalPadding
          );
          const bottom = Math.max(
            container.position.y + Math.max(container.size.height, minimum.height),
            maximumY + bottomPadding
          );
          container.position = {
            x: Math.min(container.position.x, minimumX - horizontalPadding),
            y: Math.min(container.position.y, minimumY - topPadding)
          };
          container.size = {
            width: right - container.position.x,
            height: bottom - container.position.y
          };
          resized.add(container.id);
        }
      }

      scopeId = container.scopeId === container.ownerId ? undefined : container.scopeId;
    }

    if (resized.size === 0) return;
    for (const connection of context.connections.values()) {
      if (!resized.has(connection.source) && !resized.has(connection.target)) continue;
      const source = context.elements.get(connection.source);
      const target = context.elements.get(connection.target);
      if (source && target) connection.waypoints = calculateConnectionWaypoints(source, target);
    }
  }

  private positionOnActivityBoundary(
    host: BpmnDocumentElement,
    size: BpmnDocumentElement['size'],
    requested?: BpmnDocumentElement['position']
  ): BpmnDocumentElement['position'] {
    const left = host.position.x;
    const right = left + host.size.width;
    const top = host.position.y;
    const bottom = top + host.size.height;
    if (!requested) {
      return {
        x: left + (host.size.width - size.width) / 2,
        y: bottom - size.height / 2
      };
    }

    const requestedCenter = {
      x: requested.x + size.width / 2,
      y: requested.y + size.height / 2
    };
    const clamp = (value: number, minimum: number, maximum: number): number =>
      Math.min(maximum, Math.max(minimum, value));
    const candidates = [
      { x: clamp(requestedCenter.x, left, right), y: bottom },
      { x: clamp(requestedCenter.x, left, right), y: top },
      { x: left, y: clamp(requestedCenter.y, top, bottom) },
      { x: right, y: clamp(requestedCenter.y, top, bottom) }
    ];
    const closest = candidates.reduce((best, candidate) => {
      const distance = (candidate.x - requestedCenter.x) ** 2
        + (candidate.y - requestedCenter.y) ** 2;
      const bestDistance = (best.x - requestedCenter.x) ** 2
        + (best.y - requestedCenter.y) ** 2;
      return distance < bestDistance ? candidate : best;
    });
    return {
      x: closest.x - size.width / 2,
      y: closest.y - size.height / 2
    };
  }

  private repositionBoundaryEvents(context: ProcessContext): void {
    for (const element of context.elements.values()) {
      if (element.type !== 'bpmn:BoundaryEvent') continue;
      const host = context.elements.get(element.properties.attachTo as string);
      if (!host) continue;
      element.position = this.positionOnActivityBoundary(host, element.size, element.position);
    }
  }

  private layoutPoolLanes(context: ProcessContext, participantId: string): void {
    const participant = context.elements.get(participantId);
    if (!participant || participant.kind !== 'participant' || !participant.processRef) return;
    const laneSet = Array.from(context.document.laneSets.values()).find(
      candidate => candidate.processId === participant.processRef && candidate.parentLaneId === undefined
    );
    if (!laneSet || laneSet.laneIds.length === 0) return;

    const lanes = laneSet.laneIds
      .map(id => context.document.lanes.get(id))
      .filter((lane): lane is BpmnLane => lane !== undefined);
    const laneHeights = lanes.map(lane => Math.max(
      100,
      ...lane.flowNodeRefs.map(id => (context.elements.get(id)?.size.height || 0) + 40)
    ));
    const requestedParticipantHeight = participant.size.height;
    let laneWidth = Math.max(1, participant.size.width - 30);
    const movedNodeIds = new Set<string>();

    for (const lane of lanes) {
      let x = participant.position.x + 60;
      for (const flowNodeId of lane.flowNodeRefs) {
        const node = context.elements.get(flowNodeId);
        if (!node) continue;
        node.position.x = x;
        x += node.size.width + 50;
        movedNodeIds.add(node.id);
      }
      laneWidth = Math.max(laneWidth, x - (participant.position.x + 30));
    }

    participant.size.width = laneWidth + 30;
    const minimumLaneHeight = laneHeights.reduce((total, height) => total + height, 0);
    participant.size.height = Math.max(requestedParticipantHeight, minimumLaneHeight);
    laneHeights[laneHeights.length - 1] += participant.size.height - minimumLaneHeight;
    let y = participant.position.y;
    lanes.forEach((lane, index) => {
      lane.position = { x: participant.position.x + 30, y };
      lane.size = { width: laneWidth, height: laneHeights[index] };
      for (const flowNodeId of lane.flowNodeRefs) {
        const node = context.elements.get(flowNodeId);
        if (node) node.position.y = y + (laneHeights[index] - node.size.height) / 2;
      }
      y += laneHeights[index];
    });

    for (const connection of context.connections.values()) {
      if (movedNodeIds.has(connection.source) || movedNodeIds.has(connection.target)) {
        connection.waypoints = [];
      }
    }
    this.repositionBoundaryEvents(context);
  }

  private defaultFilename(process: ProcessContext): string {
    const metadata = Buffer.from(
      JSON.stringify([process.id, process.name]),
      'utf8'
    ).toString('base64url');
    const encodedFilename = `mcp-bpmn-v1_${metadata}.bpmn`;
    // Leave room for FileManager's atomic-write suffix in the same 255-byte
    // filesystem component.
    return Buffer.byteLength(encodedFilename, 'utf8') <= 200
      ? encodedFilename
      : `${process.id}_${this.sanitizeFilename(process.name)}.bpmn`;
  }

  private metadataFromDefaultFilename(
    filename: string
  ): { processId: string; name: string } | undefined {
    const match = filename.match(/^mcp-bpmn-v1_([A-Za-z0-9_-]+)\.bpmn$/);
    if (!match) return undefined;
    try {
      const metadata: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (!Array.isArray(metadata)
        || metadata.length !== 2
        || typeof metadata[0] !== 'string'
        || metadata[0].length === 0
        || typeof metadata[1] !== 'string') {
        return undefined;
      }
      return { processId: metadata[0], name: metadata[1] };
    } catch {
      return undefined;
    }
  }

  private cloneDocument(document: BpmnDocument): BpmnDocument {
    return {
      definitionsId: document.definitionsId,
      targetNamespace: document.targetNamespace,
      extensionProfile: document.extensionProfile,
      sourceXml: document.sourceXml,
      sourceIds: new Set(document.sourceIds || []),
      managedIds: new Set(document.managedIds || []),
      processes: new Map(Array.from(document.processes, ([id, process]) => [id, { ...process }])),
      collaborations: new Map(Array.from(
        document.collaborations,
        ([id, collaboration]) => [id, { ...collaboration }]
      )),
      laneSets: new Map(Array.from(document.laneSets, ([id, laneSet]) => [id, {
        ...laneSet,
        laneIds: [...laneSet.laneIds]
      }])),
      lanes: new Map(Array.from(document.lanes, ([id, lane]) => [id, {
        ...lane,
        flowNodeRefs: [...lane.flowNodeRefs],
        position: { ...lane.position },
        size: { ...lane.size }
      }])),
      itemDefinitions: new Set(document.itemDefinitions),
      dataObjects: new Map(Array.from(document.dataObjects, ([id, dataObject]) => [id, {
        ...dataObject
      }])),
      elements: new Map(Array.from(document.elements, ([id, element]) => [id, {
        ...element,
        position: { ...element.position },
        size: { ...element.size },
        properties: structuredClone(element.properties)
      }])),
      connections: new Map(Array.from(document.connections, ([id, connection]) => [id, {
        ...connection,
        condition: connection.condition ? { ...connection.condition } : undefined,
        waypoints: connection.waypoints.map(point => ({ ...point })),
        properties: structuredClone(connection.properties)
      }])),
      diagram: {
        id: document.diagram.id,
        planeId: document.diagram.planeId,
        planeElementId: document.diagram.planeElementId,
        shapes: new Map(Array.from(document.diagram.shapes, ([id, shape]) => [id, {
          ...shape,
          bounds: { ...shape.bounds },
          labelBounds: shape.labelBounds ? { ...shape.labelBounds } : undefined
        }])),
        edges: new Map(Array.from(document.diagram.edges, ([id, edge]) => [id, {
          ...edge,
          waypoints: edge.waypoints.map(point => ({ ...point })),
          labelBounds: edge.labelBounds ? { ...edge.labelBounds } : undefined
        }]))
      }
    };
  }

  private assertLayoutSemanticsUnchanged(
    current: BpmnDocument,
    candidate: BpmnDocument
  ): void {
    const snapshot = (document: BpmnDocument): unknown => ({
      definitionsId: document.definitionsId,
      targetNamespace: document.targetNamespace,
      planeElementId: document.diagram.planeElementId,
      processes: Array.from(document.processes.values()).sort((left, right) => left.id.localeCompare(right.id)),
      collaborations: Array.from(document.collaborations.values())
        .sort((left, right) => left.id.localeCompare(right.id)),
      laneSets: Array.from(document.laneSets.values())
        .sort((left, right) => left.id.localeCompare(right.id)),
      lanes: Array.from(document.lanes.values())
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(lane => ({
          id: lane.id,
          name: lane.name,
          processId: lane.processId,
          laneSetId: lane.laneSetId,
          flowNodeRefs: [...lane.flowNodeRefs]
        })),
      itemDefinitions: Array.from(document.itemDefinitions).sort(),
      dataObjects: Array.from(document.dataObjects.values())
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(dataObject => ({
          ...dataObject,
          isCollection: dataObject.isCollection ?? false
        })),
      elements: Array.from(document.elements.values())
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(element => ({
          id: element.id,
          kind: element.kind,
          type: element.type,
          name: element.name,
          ownerId: element.ownerId,
          scopeId: element.scopeId,
          // Expansion is BPMN DI state, while blackBox is the tool-level
          // shorthand for an absent participant processRef. Layout adapters
          // may legitimately add or change either representation detail.
          properties: Object.fromEntries(Object.entries(element.properties)
            .filter(([key]) => key !== 'isExpanded'
              && !(element.kind === 'participant' && key === 'blackBox')
              && !(element.type === 'bpmn:DataObjectReference'
                && (key === 'isCollection' || key === 'itemSubjectRef')))),
          processRef: element.kind === 'participant' ? element.processRef : undefined,
          defaultFlow: element.kind === 'flowNode' ? element.defaultFlow : undefined
        })),
      connections: Array.from(document.connections.values())
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(connection => ({
          id: connection.id,
          type: connection.type,
          source: connection.source,
          target: connection.target,
          ownerId: connection.ownerId,
          scopeId: connection.scopeId,
          label: connection.label,
          condition: connection.condition,
          properties: connection.properties
        }))
    });

    // Layout adapters may execute in another JS realm. Normalize the JSON-like
    // semantic snapshot so prototype identity and absent-vs-undefined fields
    // cannot make unchanged BPMN semantics look different.
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    if (!isDeepStrictEqual(normalize(snapshot(current)), normalize(snapshot(candidate)))) {
      throw new Error('Layout output changed BPMN semantics');
    }
  }

  private safeImportError(error: unknown): Error {
    const message = error instanceof Error ? error.message : '';
    if (/configured element limit/i.test(message)) {
      return new Error('BPMN import rejected: configured element limit exceeded');
    }
    if (/configured flow limit/i.test(message)) {
      return new Error('BPMN import rejected: configured flow limit exceeded');
    }
    if (/configured DI element limit/i.test(message)) {
      return new Error('BPMN import rejected: configured DI element limit exceeded');
    }
    if (/unresolved references/i.test(message)) {
      return new Error('BPMN import rejected: unresolved references');
    }
    if (/unknown type|unsupported BPMN (element|artifact|connection|root)/i.test(message)) {
      return new Error('BPMN import rejected: unknown type or unsupported BPMN construct');
    }
    if (/crosses process|must connect BPMN flow nodes|not contained by its owner|message flow/i.test(message)) {
      return new Error('BPMN import rejected: flow crosses process boundaries or has invalid references');
    }
    if (/No process or collaboration/i.test(message)) {
      return new Error('BPMN import rejected: a process or collaboration root is required');
    }
    return new Error('Failed to parse BPMN XML: malformed or invalid input');
  }

  private defaultProcessOwner(context: ProcessContext): string {
    if (context.type === 'process') {
      return context.id;
    }
    const owners = new Set(
      Array.from(context.elements.values())
        .filter((element): element is Extract<typeof element, { kind: 'participant' }> => element.kind === 'participant')
        .map(element => element.processRef)
        .filter((processRef): processRef is string => processRef !== undefined
          && context.document.processes.has(processRef))
    );
    if (owners.size === 1) {
      return owners.values().next().value!;
    }
    throw new Error(owners.size === 0
      ? 'Flow nodes and artifacts require a process owner; add a white-box pool first'
      : 'Flow nodes and artifacts require an explicit process owner when multiple pools exist');
  }

  private assertFlowScope(document: BpmnDocument, ownerId: string, scopeId: string): void {
    if (!document.processes.has(ownerId)) {
      throw new Error(`Missing BPMN process owner: ${ownerId}`);
    }
    if (scopeId === ownerId) {
      return;
    }
    const scope = document.elements.get(scopeId);
    if (!scope || !['bpmn:SubProcess', 'bpmn:Transaction'].includes(scope.type)
      || scope.ownerId !== ownerId) {
      throw new Error(`Invalid BPMN scope: ${scopeId}`);
    }
    if (scope.properties.isExpanded !== true) {
      throw new Error(`BPMN scope ${scopeId} must be expanded before adding child elements`);
    }
  }

  private assertElementProperties(
    context: ProcessContext,
    type: BpmnElementType,
    properties: Record<string, unknown>,
    ownerId: string,
    scopeId: string
  ): void {
    const supportedProperties = new Set([
      'isExpanded', 'calledElement', 'assignee', 'candidateGroups', 'dueDate',
      'eventDefinition', 'eventDefinitionPayload', 'cancelActivity', 'attachTo',
      'blackBox', 'processRef', 'text', 'textFormat', 'dataObjectRef', 'isCollection', 'itemSubjectRef',
      'multiInstance'
    ]);
    for (const property of Object.keys(properties)) {
      if (!supportedProperties.has(property)) {
        throw new Error(`Unsupported element property: ${property}`);
      }
    }

    const hasTextAnnotationProperty = ['text', 'textFormat']
      .some(property => Object.prototype.hasOwnProperty.call(properties, property));
    if (type !== 'bpmn:TextAnnotation' && hasTextAnnotationProperty) {
      throw new Error('Text annotation properties are only valid on bpmn:TextAnnotation');
    }
    if (type === 'bpmn:TextAnnotation') {
      if (properties.text !== undefined && typeof properties.text !== 'string') {
        throw new Error('Text annotation text must be a string');
      }
      if (properties.textFormat !== undefined
        && (typeof properties.textFormat !== 'string'
          || properties.textFormat.trim().length === 0)) {
        throw new Error('Text annotation textFormat must not be blank');
      }
    }

    const hasDataObjectProperty = ['dataObjectRef', 'isCollection', 'itemSubjectRef']
      .some(property => Object.prototype.hasOwnProperty.call(properties, property));
    if (type !== 'bpmn:DataObjectReference' && hasDataObjectProperty) {
      throw new Error('Data object properties are only valid on bpmn:DataObjectReference');
    }
    if (type === 'bpmn:DataObjectReference') {
      const dataObjectRef = properties.dataObjectRef;
      if (typeof dataObjectRef !== 'string' || dataObjectRef.length === 0) {
        throw new Error('Data object references require a valid dataObjectRef');
      }
      const dataObject = context.document.dataObjects.get(dataObjectRef);
      if (!dataObject) {
        throw new Error(`Data object reference references missing data object ${dataObjectRef}`);
      }
      if (dataObject.ownerId !== ownerId || dataObject.scopeId !== scopeId) {
        throw new Error(`Data object reference cannot cross data object scope ${dataObjectRef}`);
      }
      if (properties.isCollection !== undefined
        && typeof properties.isCollection !== 'boolean') {
        throw new Error('isCollection must be a boolean on bpmn:DataObjectReference');
      }
      const itemSubjectRef = properties.itemSubjectRef;
      if (itemSubjectRef !== undefined && itemSubjectRef !== null
        && (typeof itemSubjectRef !== 'string'
          || !context.document.itemDefinitions.has(itemSubjectRef))) {
        throw new Error(`Invalid data object itemSubjectRef: ${String(itemSubjectRef)}`);
      }
    }

    for (const property of ['assignee', 'candidateGroups', 'dueDate'] as const) {
      if (!Object.prototype.hasOwnProperty.call(properties, property)) continue;
      if (type !== 'bpmn:UserTask') {
        throw new Error(`${property} is only valid on bpmn:UserTask`);
      }
      if (context.extensionProfile !== 'camunda7') {
        throw new Error(`${property} requires extensionProfile "camunda7"`);
      }
    }
    if (properties.assignee !== undefined
      && (typeof properties.assignee !== 'string' || properties.assignee.trim().length === 0)) {
      throw new Error('assignee must be a non-empty string');
    }
    if (properties.dueDate !== undefined
      && (typeof properties.dueDate !== 'string' || properties.dueDate.trim().length === 0)) {
      throw new Error('dueDate must be a non-empty string');
    }
    if (properties.candidateGroups !== undefined
      && (!Array.isArray(properties.candidateGroups)
        || properties.candidateGroups.length === 0
        || properties.candidateGroups.some(group => typeof group !== 'string'
          || group.trim().length === 0 || group.includes(',')))) {
      throw new Error('candidateGroups must be a non-empty string array whose entries contain no commas');
    }
    if (properties.isExpanded !== undefined) {
      if (!['bpmn:SubProcess', 'bpmn:Transaction'].includes(type)
        || typeof properties.isExpanded !== 'boolean') {
        throw new Error('isExpanded is only valid as a boolean on subprocesses and transactions');
      }
    }

    if (properties.multiInstance !== undefined) {
      this.assertMultiInstanceProperties(type, properties.multiInstance);
    }

    const hasCalledElement = Object.prototype.hasOwnProperty.call(properties, 'calledElement');
    if (hasCalledElement) {
      if (type !== 'bpmn:CallActivity') {
        throw new Error('calledElement is only valid on bpmn:CallActivity');
      }
      if (!isBpmnQName(properties.calledElement)) {
        throw new Error('calledElement must be a valid BPMN QName');
      }
    }

    const eventDefinition = properties.eventDefinition;
    if (eventDefinition !== undefined) {
      if (!isBpmnFlowNodeType(type) || typeof eventDefinition !== 'string'
        || !isSupportedEventDefinitionType(eventDefinition)) {
        throw new Error(`Unsupported event definition type: ${String(eventDefinition)}`);
      }
      if (!supportsEventDefinition(type, eventDefinition)) {
        throw new Error(`${eventDefinition} event definitions are not legal on ${type}`);
      }
      if (type === 'bpmn:StartEvent' && scopeId !== ownerId) {
        throw new Error('Start events in regular subprocesses cannot have an event definition');
      }
      this.assertEventDefinitionPayload(context, type, eventDefinition, properties, ownerId);
    } else if (properties.eventDefinitionPayload !== undefined) {
      throw new Error('eventDefinitionPayload requires eventDefinition');
    }

    if (properties.cancelActivity !== undefined) {
      if (type !== 'bpmn:BoundaryEvent' || typeof properties.cancelActivity !== 'boolean') {
        throw new Error('cancelActivity is only valid as a boolean on boundary events');
      }
      if (eventDefinition === 'compensation' && properties.cancelActivity !== false) {
        throw new Error('Compensation boundary events must set cancelActivity to false');
      }
      if (eventDefinition === 'cancel' && properties.cancelActivity !== true) {
        throw new Error('Cancel boundary events must set cancelActivity to true');
      }
    }

    if (type === 'bpmn:BoundaryEvent') {
      const attachTo = properties.attachTo;
      const attachedElement = typeof attachTo === 'string' ? context.elements.get(attachTo) : undefined;
      if (!attachedElement || attachedElement.kind !== 'flowNode'
        || !(/Task$/.test(attachedElement.type)
          || ['bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:CallActivity']
            .includes(attachedElement.type))) {
        throw new Error('Boundary events require attachTo referencing an existing activity');
      }
      if (attachedElement.ownerId !== ownerId || attachedElement.scopeId !== scopeId) {
        throw new Error('Boundary events must share process ownership and scope with their attached activity');
      }
      if (eventDefinition === 'cancel' && attachedElement.type !== 'bpmn:Transaction') {
        throw new Error('Cancel boundary events may only attach to a transaction');
      }
    } else if (properties.attachTo !== undefined) {
      throw new Error('attachTo is only valid on boundary events');
    }
  }

  private assertMultiInstanceProperties(
    type: BpmnElementType,
    value: unknown
  ): asserts value is BpmnMultiInstanceLoopCharacteristics {
    const isActivity = /Task$/.test(type)
      || ['bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:CallActivity'].includes(type);
    if (!isActivity) {
      throw new Error('multiInstance is only valid on BPMN activities');
    }
    if (!this.isRecord(value)) {
      throw new Error('multiInstance must be an object');
    }

    const supported = new Set([
      'isSequential', 'loopCardinality', 'completionCondition',
      'loopDataInputRef', 'loopDataOutputRef'
    ]);
    for (const property of Object.keys(value)) {
      if (!supported.has(property)) {
        throw new Error(`Unsupported multiInstance property: ${property}`);
      }
    }
    if (typeof value.isSequential !== 'boolean') {
      throw new Error('multiInstance.isSequential must be a boolean');
    }

    for (const property of ['loopCardinality', 'completionCondition'] as const) {
      const expression = value[property];
      if (expression === undefined) continue;
      if (!this.isRecord(expression)) {
        throw new Error(`multiInstance.${property} must be an expression object`);
      }
      const expressionProperties = new Set(['body', 'language']);
      for (const key of Object.keys(expression)) {
        if (!expressionProperties.has(key)) {
          throw new Error(`Unsupported multiInstance.${property} property: ${key}`);
        }
      }
      if (typeof expression.body !== 'string' || expression.body.trim().length === 0) {
        throw new Error(`multiInstance.${property}.body must be non-blank text`);
      }
      if (expression.language !== undefined
        && (typeof expression.language !== 'string' || expression.language.trim().length === 0)) {
        throw new Error(`multiInstance.${property}.language must be non-blank text`);
      }
    }

    for (const property of ['loopDataInputRef', 'loopDataOutputRef'] as const) {
      const reference = value[property];
      if (reference !== undefined && (typeof reference !== 'string' || reference.length === 0)) {
        throw new Error(`multiInstance.${property} must be a non-empty BPMN ID`);
      }
    }
  }

  private normalizeEventDefinitionProperties(
    document: BpmnDocument,
    type: BpmnElementType,
    properties: Record<string, unknown>
  ): void {
    const definitionType = properties.eventDefinition;
    if (type === 'bpmn:BoundaryEvent' && properties.cancelActivity === undefined) {
      properties.cancelActivity = definitionType === 'compensation' ? false : true;
    }
    if (typeof definitionType !== 'string' || !isSupportedEventDefinitionType(definitionType)) {
      return;
    }

    const rawPayload = properties.eventDefinitionPayload;
    if (rawPayload !== undefined && !this.isRecord(rawPayload)) {
      throw new Error('eventDefinitionPayload must be an object');
    }
    const payload: EventDefinitionPayload = rawPayload
      ? structuredClone(rawPayload) as EventDefinitionPayload
      : {};
    if (!payload.definitionId) {
      payload.definitionId = this.generateUniqueId(
        document,
        `${this.eventDefinitionPrefix(definitionType)}EventDefinition`
      );
    }

    if (['message', 'signal', 'error', 'escalation'].includes(definitionType)) {
      if (payload.reference !== undefined && !this.isRecord(payload.reference)) {
        throw new Error(`${definitionType} event definition reference must be an object`);
      }
      payload.reference = { ...(payload.reference || {}) };
      if (!payload.reference.id) {
        payload.reference.id = this.generateUniqueId(
          document,
          this.eventDefinitionPrefix(definitionType)
        );
      }
    }

    properties.eventDefinitionPayload = payload;
  }

  private assertEventDefinitionPayload(
    context: ProcessContext,
    eventType: BpmnElementType,
    definitionType: EventDefinitionType,
    properties: Record<string, unknown>,
    ownerId: string
  ): void {
    const payload = properties.eventDefinitionPayload;
    if (!this.isRecord(payload)) {
      throw new Error(`${definitionType} event definition requires eventDefinitionPayload`);
    }
    if (typeof payload.definitionId !== 'string' || payload.definitionId.length === 0) {
      throw new Error(`${definitionType} event definition requires a non-empty definitionId`);
    }
    this.assertBpmnIdentifier(payload.definitionId, 'Event definition ID');

    if (definitionType === 'timer') {
      if (!this.isRecord(payload.timer)
        || !['timeDate', 'timeDuration', 'timeCycle'].includes(String(payload.timer.type))
        || typeof payload.timer.expression !== 'string'
        || payload.timer.expression.length === 0) {
        throw new Error(
          'Timer event definition requires eventDefinitionPayload.timer with type and a non-empty expression'
        );
      }
      if (payload.timer.language !== undefined && typeof payload.timer.language !== 'string') {
        throw new Error('Timer expression language must be a string');
      }
    } else if (payload.timer !== undefined) {
      throw new Error('Timer payload is only valid for timer event definitions');
    }

    if (definitionType === 'conditional') {
      if (!this.isRecord(payload.condition)
        || typeof payload.condition.expression !== 'string'
        || payload.condition.expression.length === 0) {
        throw new Error(
          'Conditional event definition requires eventDefinitionPayload.condition with a non-empty expression'
        );
      }
      if (payload.condition.language !== undefined && typeof payload.condition.language !== 'string') {
        throw new Error('Conditional expression language must be a string');
      }
    } else if (payload.condition !== undefined) {
      throw new Error('Condition payload is only valid for conditional event definitions');
    }

    const usesRootReference = ['message', 'signal', 'error', 'escalation'].includes(definitionType);
    if (usesRootReference) {
      if (!this.isRecord(payload.reference)
        || typeof payload.reference.id !== 'string'
        || payload.reference.id.length === 0) {
        throw new Error(`${definitionType} event definition requires a resolvable root reference`);
      }
      this.assertBpmnIdentifier(payload.reference.id, `${definitionType} root reference ID`);
      for (const property of ['name', 'code'] as const) {
        if (payload.reference[property] !== undefined
          && typeof payload.reference[property] !== 'string') {
          throw new Error(`${definitionType} reference ${property} must be a string`);
        }
      }
      if (!['error', 'escalation'].includes(definitionType) && payload.reference.code !== undefined) {
        throw new Error(`Reference code is not valid for ${definitionType} event definitions`);
      }
    } else if (payload.reference !== undefined) {
      throw new Error(`Root references are not valid for ${definitionType} event definitions`);
    }

    if (definitionType === 'compensation') {
      if ((payload.activityRef !== undefined || payload.waitForCompletion !== undefined)
        && !['bpmn:IntermediateThrowEvent', 'bpmn:EndEvent'].includes(eventType)) {
        throw new Error('Compensation activityRef/waitForCompletion is only valid on throwing events');
      }
      if (payload.waitForCompletion !== undefined
        && typeof payload.waitForCompletion !== 'boolean') {
        throw new Error('Compensation waitForCompletion must be a boolean');
      }
      if (payload.activityRef !== undefined) {
        if (typeof payload.activityRef !== 'string' || payload.activityRef.length === 0) {
          throw new Error('Compensation activityRef must be a non-empty activity ID');
        }
        const activity = context.elements.get(payload.activityRef);
          if (!activity || activity.kind !== 'flowNode'
            || !(/Task$/.test(activity.type)
            || ['bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:CallActivity'].includes(activity.type))
          || activity.ownerId !== ownerId) {
          throw new Error(`Compensation activityRef ${payload.activityRef} must reference an activity`);
        }
      }
    } else if (payload.activityRef !== undefined || payload.waitForCompletion !== undefined) {
      throw new Error('Compensation payload is only valid for compensation event definitions');
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private assertBpmnIdentifier(value: string, label: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(value)) {
      throw new Error(
        `${label} must start with a letter or underscore and contain only letters, digits, dot, underscore, or hyphen`
      );
    }
  }

  private eventDefinitionPrefix(type: EventDefinitionType): string {
    return type === 'compensation'
      ? 'Compensate'
      : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  }

  private normalizeCondition(options: BpmnConnectOptions): BpmnDocumentConnection['condition'] {
    const { condition, conditionLanguage, conditionType } = options;
    if (condition === undefined) {
      if (conditionLanguage !== undefined || conditionType !== undefined) {
        throw new Error('Condition language/type requires a condition expression');
      }
      return undefined;
    }
    if (typeof condition !== 'string' || condition.length === 0) {
      throw new Error('Condition expression must be a non-empty string');
    }
    if (conditionLanguage !== undefined
      && (typeof conditionLanguage !== 'string' || conditionLanguage.length === 0)) {
      throw new Error('Condition language must be a non-empty string');
    }
    const normalizedType = conditionType || 'bpmn:FormalExpression';
    if (normalizedType !== 'bpmn:FormalExpression') {
      throw new Error(`Unsupported condition expression type: ${String(conditionType)}`);
    }
    return {
      body: condition,
      type: normalizedType,
      language: conditionLanguage
    };
  }

  private assertDefaultFlowAssignment(
    context: ProcessContext,
    source: BpmnDocumentElement,
    defaultFlow: unknown
  ): void {
    if (defaultFlow == null) return;
    if (typeof defaultFlow !== 'string' || defaultFlow.length === 0) {
      throw new Error('Default flow must reference a sequence flow ID');
    }
    if (!supportsConditionalOutgoingFlow(source)) {
      throw new Error(`Element ${source.id} cannot own a default sequence flow`);
    }
    const connection = context.connections.get(defaultFlow);
    if (!connection || connection.type !== 'bpmn:SequenceFlow' || connection.source !== source.id) {
      throw new Error(`Element ${source.id} cannot use ${defaultFlow} as its default flow`);
    }
    if (connection.condition) {
      throw new Error('A default sequence flow cannot have a condition');
    }
  }

  private generateUniqueId(document: BpmnDocument | undefined, prefix: string): string {
    let id: string;
    do {
      id = IdGenerator.generate(prefix);
    } while (document && this.hasId(document, id));
    return id;
  }

  private hasId(document: BpmnDocument, id: string): boolean {
    if (document.sourceIds?.has(id) === true
      || document.processes.has(id)
      || document.collaborations.has(id)
      || document.laneSets.has(id)
      || document.lanes.has(id)
      || document.itemDefinitions.has(id)
      || document.dataObjects.has(id)
      || document.elements.has(id)
      || document.connections.has(id)) {
      return true;
    }
    return Array.from(document.elements.values()).some(element => {
      const payload = element.properties.eventDefinitionPayload;
      return this.isRecord(payload)
        && (payload.definitionId === id
          || (this.isRecord(payload.reference) && payload.reference.id === id));
    });
  }

  private connectionPrefix(type: BpmnConnectionType): string {
    switch (type) {
      case 'bpmn:SequenceFlow':
        return 'Flow';
      case 'bpmn:MessageFlow':
        return 'MessageFlow';
      case 'bpmn:Association':
        return 'Association';
    }
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
  }

}
