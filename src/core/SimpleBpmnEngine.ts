import { promises as fs } from 'fs';
import { createHash } from 'node:crypto';
import { extname, join } from 'path';
import { isDeepStrictEqual } from 'util';
import { config, TOOL_INPUT_LIMITS } from '../config/index.js';
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
  BpmnEdgeModel,
  BpmnShapeModel,
  BuildFlowRequest,
  BuildNodeRequest,
  BuildProcessResult,
  ConnectionGeometryState,
  ConnectionGeometryUpdate,
  ConnectionRouteUpdate,
  ConnectionSemanticState,
  ConnectionSemanticUpdate,
  ElementDefinition,
  ElementGeometryState,
  ElementGeometryUpdate,
  GeometryPatchConnectionResult,
  GeometryPatchElementResult,
  GeometryPatchUpdate,
  Position,
  ProcessContext,
  Size
} from '../types/index.js';
import { IdGenerator } from '../utils/IdGenerator.js';
import { assertBpmnId, isBpmnExpression } from '../utils/BpmnId.js';
import {
  BpmnFileTooLargeError,
  FileManager,
  type RenderedArtifactFormat,
  type SaveResult
} from '../utils/FileManager.js';
import {
  assertValidMessageFlowEndpoints,
  BpmnDocumentSerializer,
  calculateConnectionWaypoints,
  createProcessContext,
  getDefaultElementSize,
  isBpmnConnectionType,
  isBpmnElementType,
  isBpmnFlowNodeType,
  BpmnXmlParseError,
  isBpmnQName,
  isActivityType,
  isSupportedEventDefinitionType,
  resolveAssociationOwnership,
  supportsEventDefinition,
  supportsConditionalOutgoingFlow
} from './BpmnDocument.js';
import { BpmnDocumentLayoutAdapter } from './layout/adapters/BpmnDocumentLayoutAdapter.js';
import { applyCollaborationLayoutPolicy } from './layout/CollaborationLayoutPolicy.js';
import { restoreDroppedLayoutEdges } from './layout/LayoutEdgeRestoration.js';
import { applyPinnedElements } from './layout/LayoutPinning.js';
import {
  applyLayoutSpacing,
  assertLayoutSpacing,
  DEFAULT_LAYOUT_SPACING
} from './layout/LayoutSpacing.js';
import {
  ConnectionRouter,
  type ConnectionRouteCandidate,
  type ConnectionRouteScoreBreakdown
} from './layout/ConnectionRouter.js';
import {
  assertLayoutComplexity,
  BpmnAutoLayoutV2Adapter,
  type BpmnLayoutAdapter,
  type BpmnLayoutResult
} from './layout/BpmnLayoutAdapter.js';
import type { LayoutDirection, LayoutModel } from './layout/LayoutModel.js';
import {
  transposeDocumentGeometry,
  type LayoutOrientation
} from './layout/LayoutOrientation.js';
import {
  type GeometryDiagnostic,
  validateBpmnGeometry
} from './BpmnGeometry.js';

/**
 * What `auto_layout` produced. `changed` is false when the layout reproduced
 * the geometry the diagram already had, in which case nothing was committed.
 */
export interface AutoLayoutResult extends BpmnLayoutResult {
  changed: boolean;
}

/** The knobs `auto_layout` offers on top of the layout engine's own ranking. */
export interface AutoLayoutOptions {
  /**
   * Multiplier for the gaps the ranked layout leaves between its ranks, from
   * 0.5 to 4. The layout engine takes no options of its own, so the gaps are
   * stretched afterwards.
   */
  spacing?: number;
  /**
   * Elements whose current bounds the layout must keep. The ranked result is
   * repaired around them, and a pin that cannot be honoured fails the call
   * rather than being dropped.
   */
  pinnedElementIds?: string[];
}

/** Every coordinate a layout is allowed to move, in comparison order. */
function geometrySignature(document: BpmnDocument): string {
  const shapes = [...document.elements.values(), ...document.lanes.values()]
    .map(element => [
      element.id,
      element.position.x,
      element.position.y,
      element.size.width,
      element.size.height
    ].join(':'))
    .sort();
  const edges = Array.from(document.connections.values(), connection => [
    connection.id,
    ...connection.waypoints.map(point => `${point.x},${point.y}`)
  ].join(':')).sort();
  const orientations = Array.from(document.diagram.shapes.values(), shape => (
    `${shape.elementId}:${shape.isHorizontal ?? ''}`
  )).sort();
  return JSON.stringify([shapes, edges, orientations]);
}

/**
 * True when two documents place everything identically. Used to skip the
 * commit for a layout that would rewrite the file with the same bytes.
 */
function sameDocumentGeometry(left: BpmnDocument, right: BpmnDocument): boolean {
  return geometrySignature(left) === geometrySignature(right);
}

export class DocumentRevisionConflictError extends Error {
  readonly code = 'revision_conflict';

  constructor(
    readonly filename: string,
    readonly expectedRevision: string | undefined,
    readonly actualRevision: string | undefined,
    readonly reason: 'revision_mismatch' | 'external_change' | 'target_exists'
  ) {
    super(`Document revision conflict for ${filename}`);
    this.name = 'DocumentRevisionConflictError';
  }
}

export class ElementGeometryConflictError extends Error {
  readonly code = 'geometry_conflict';

  constructor(
    readonly elementId: string,
    readonly expectedBounds: Position & Size,
    readonly actualBounds: Position & Size
  ) {
    super(`Element geometry conflict for ${elementId}`);
    this.name = 'ElementGeometryConflictError';
  }
}

export class ConnectionGeometryConflictError extends Error {
  readonly code = 'geometry_conflict';

  constructor(
    readonly connectionId: string,
    readonly reason: 'waypoints_mismatch' | 'geometry_revision_mismatch',
    readonly actualWaypoints: Position[],
    readonly actualGeometryRevision: string,
    readonly expectedWaypoints?: Position[],
    readonly expectedGeometryRevision?: string
  ) {
    super(`Connection geometry conflict for ${connectionId}`);
    this.name = 'ConnectionGeometryConflictError';
  }
}

export class ConnectionSemanticConflictError extends Error {
  readonly code = 'semantic_conflict';

  constructor(
    readonly connectionId: string,
    readonly expectedSemanticRevision: string,
    readonly actualSemanticRevision: string
  ) {
    super(`Connection semantic conflict for ${connectionId}`);
    this.name = 'ConnectionSemanticConflictError';
  }
}

export class GeometryPatchConflictError extends Error {
  readonly code = 'geometry_conflict';

  constructor(
    readonly objectType: 'element' | 'connection',
    readonly objectId: string,
    readonly field: 'labelBounds',
    readonly expectedValue: (Position & Size) | null,
    readonly actualValue: (Position & Size) | null
  ) {
    super(`Geometry patch conflict for ${objectType} ${objectId} ${field}`);
    this.name = 'GeometryPatchConflictError';
  }
}

export interface RankedConnectionRouteDiagnostic {
  rank: number;
  waypoints: Position[];
  labelBounds: (Position & Size) | null;
  scoreBreakdown: ConnectionRouteScoreBreakdown;
  diagnostics: GeometryDiagnostic[];
}

export class ConnectionRoutingFailureError extends Error {
  readonly code = 'routing_failed';

  constructor(
    readonly connectionId: string,
    readonly rankedDiagnostics: RankedConnectionRouteDiagnostic[]
  ) {
    super(`No collision-free orthogonal route found for ${connectionId}`);
    this.name = 'ConnectionRoutingFailureError';
  }
}

export interface ElementGeometryMutationResult {
  before: ElementGeometryState;
  after: ElementGeometryState;
  diagnostics: GeometryDiagnostic[];
}

export interface ConnectionGeometryMutationResult {
  before: ConnectionGeometryState;
  after: ConnectionGeometryState;
  diagnostics: GeometryDiagnostic[];
  introducedDiagnostics: GeometryDiagnostic[];
}

export interface ConnectionSemanticMutationResult {
  before: ConnectionSemanticState;
  after: ConnectionSemanticState;
  diagnostics: GeometryDiagnostic[];
  introducedDiagnostics: GeometryDiagnostic[];
}

export interface GeometryPatchMutationResult {
  elements: GeometryPatchElementResult[];
  connections: GeometryPatchConnectionResult[];
  diagnostics: GeometryDiagnostic[];
  introducedDiagnostics: GeometryDiagnostic[];
}

export interface ConnectionRouteMutationResult {
  connectionId: string;
  proposedWaypoints: Position[];
  proposedLabelBounds: (Position & Size) | null;
  geometryRevision: string;
  scoreBreakdown: ConnectionRouteScoreBreakdown;
  diagnostics: GeometryDiagnostic[];
  introducedDiagnostics: GeometryDiagnostic[];
  rankedDiagnostics: RankedConnectionRouteDiagnostic[];
  geometryPatch: {
    elementUpdates: GeometryPatchUpdate['elementUpdates'];
    connectionUpdates: Array<{
      connectionId: string;
      waypoints: Position[];
      labelBounds?: Position & Size;
      expectedGeometryRevision: string;
      endpointPolicy: 'exact';
    }>;
    expectedRevision: string;
    collisionPolicy: 'reject-new';
    dryRun: false;
  };
}

/** What a delete_element mutation removed. */
export interface DeleteElementResult {
  /** Connections removed because an endpoint disappeared. */
  removedConnectionCount: number;
  /**
   * Elements removed, requested element first. Empty when a connection was
   * deleted, since connections are not elements and their endpoints survive.
   */
  removedElementIds: string[];
}

/**
 * Revision tokens are compared for equality and never inverted, so half a
 * SHA-256 is ample: 128 bits makes an accidental collision impossible in
 * practice while halving what every mutation result costs an agent to read
 * (mcp-bpmn-8u0.26).
 */
const REVISION_DIGEST_HEX_LENGTH = 32;
const REVISION_DIGEST_PREFIX = 'sha256:';

function revisionDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8')
    .digest('hex')
    .slice(0, REVISION_DIGEST_HEX_LENGTH);
}

export function connectionGeometryRevision(
  connectionId: string,
  edge: {
    id: string | null;
    waypoints: Position[];
    labelBounds?: Position & Size;
  }
): string {
  return REVISION_DIGEST_PREFIX + revisionDigest(JSON.stringify({
    connectionId,
    edgeId: edge.id,
    waypoints: edge.waypoints,
    labelBounds: edge.labelBounds ?? null
  }));
}

export function connectionSemanticState(
  document: BpmnDocument,
  connection: BpmnDocumentConnection
): ConnectionSemanticState {
  const source = document.elements.get(connection.source);
  const defaultOwnerId = connection.type === 'bpmn:SequenceFlow'
    && source?.kind === 'flowNode'
    && source.defaultFlow === connection.id
    ? source.id
    : undefined;
  const value = {
    connectionId: connection.id,
    type: connection.type,
    ownerId: connection.ownerId,
    scopeId: connection.scopeId,
    sourceId: connection.source,
    targetId: connection.target,
    label: connection.label,
    condition: connection.condition ? { ...connection.condition } : undefined,
    isDefault: defaultOwnerId !== undefined,
    defaultOwnerId,
    associationDirection: connection.associationDirection
  };
  const semanticRevision = REVISION_DIGEST_PREFIX + revisionDigest(JSON.stringify({
    ...value,
    label: value.label ?? null,
    condition: value.condition ?? null,
    defaultOwnerId: value.defaultOwnerId ?? null,
    associationDirection: value.associationDirection ?? null
  }));
  return { ...value, semanticRevision };
}

/**
 * Stateful BPMN engine backed by one typed document model and bpmn-moddle.
 * Existing flat-template files are migrated into the model during import;
 * unsupported semantic types are rejected instead of being coerced to tasks.
 */
export class SimpleBpmnEngine {
  private readonly processes = new Map<string, ProcessContext>();
  private diagramsPath: string;
  private readonly serializer = new BpmnDocumentSerializer();
  private fileManager: FileManager;
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
      || !Number.isSafeInteger(this.resourceLimits.maxArtifactBytes)
      || !Number.isSafeInteger(this.resourceLimits.maxLayoutElements)
      || !Number.isSafeInteger(this.resourceLimits.maxLayoutConnections)
      || !Number.isSafeInteger(this.resourceLimits.maxLayoutBytes)
      || !Number.isSafeInteger(this.resourceLimits.maxConcurrentLayouts)
      || !Number.isSafeInteger(this.resourceLimits.maxListingItems)
      || !Number.isSafeInteger(this.resourceLimits.maxListingMetadataBytes)
      || !Number.isSafeInteger(this.resourceLimits.layoutTimeoutMs)
      || !Number.isFinite(this.resourceLimits.maxLayoutDensity)
      || Object.values(this.resourceLimits).some(limit => limit <= 0)) {
      throw new Error('Invalid BPMN resource limits');
    }
  }

  async createProcess(
    name: string,
    type: 'process' | 'collaboration' = 'process',
    extensionProfile: BpmnExtensionProfile = 'portable',
    filename?: string
  ): Promise<ProcessContext> {
    if (type !== 'process' && type !== 'collaboration') {
      throw new Error(`Unsupported BPMN root type: ${String(type)}`);
    }

    // A diagram created from scratch numbers its elements from one, so the
    // same modelling steps always produce the same ids and two runs of an agent
    // script diff cleanly. Opening a file must not reset: those ids are already
    // allocated and the generator has to keep clear of them.
    IdGenerator.resetElementCounters();
    const rootId = this.generateUniqueRootId(type === 'process' ? 'Process' : 'Collaboration');
    const context = createProcessContext(rootId, name, type, extensionProfile);
    this.assignInitialFilename(context, filename);

    await this.commitMutation(context, () => undefined, undefined, false, true);
    this.processes.set(rootId, context);
    return context;
  }

  async createElement(
    processId: string,
    definition: ElementDefinition,
    expectedRevision?: string
  ): Promise<BpmnDocumentElement> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      if (!isBpmnElementType(definition.type)) {
        throw new Error(`Unsupported BPMN element type: ${String(definition.type)}`);
      }

      const type = definition.type;
      const elementId = definition.id !== undefined
        ? definition.id
        : this.generateUniqueId(working.document, type.slice('bpmn:'.length));
      assertBpmnId(elementId, 'element.id');
      if (this.hasId(working.document, elementId)) {
        throw new Error(`BPMN ID already exists: ${elementId}`);
      }
      const position = definition.position || {
        x: 100 + working.elements.size * 50,
        y: 200
      };
      const size = definition.size || getDefaultElementSize(type);
      // Record whether the caller actually asked for this size. Auto-layout
      // honours a requested size as a lower bound, so a type default must not
      // masquerade as intent.
      const sizeManaged = definition.size === undefined;
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
        if (requestedProcessRef !== undefined) {
          assertBpmnId(requestedProcessRef, 'element.properties.processRef');
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
          sizeManaged,
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
              position, size, sizeManaged, properties
            }
          : {
              kind: 'artifact', id: elementId, type, name: definition.name, ownerId, scopeId,
              position, size, sizeManaged, properties
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
    }, undefined, true, false, expectedRevision);
  }

  /**
   * Create many elements and the flows between them as one transaction.
   *
   * Nodes are addressed by caller-chosen refs so a flow can name an element the
   * same request is creating; a flow endpoint that is not a ref is treated as
   * the id of an element already in the diagram. Every step runs through the
   * ordinary creation paths, so the same validation applies as when the tools
   * are called one at a time. Nothing is written unless all of it succeeds.
   */
  async buildProcess(
    processId: string,
    plan: { nodes: BuildNodeRequest[]; flows: BuildFlowRequest[] },
    expectedRevision?: string
  ): Promise<BuildProcessResult> {
    const context = this.getProcess(processId);

    const duplicateRef = plan.nodes
      .map(node => node.ref)
      .find((ref, index, refs) => refs.indexOf(ref) !== index);
    if (duplicateRef !== undefined) {
      throw new Error(`Duplicate node ref "${duplicateRef}"`);
    }
    const collidingRef = plan.nodes.find(node => context.elements.has(node.ref));
    if (collidingRef) {
      throw new Error(
        `Node ref "${collidingRef.ref}" is also the id of an existing element; `
        + 'choose a ref that is not an existing element id'
      );
    }

    return this.runBatch(context, async () => {
      const idByRef = new Map<string, string>();
      const elements: BuildProcessResult['elements'] = [];

      for (const [index, node] of plan.nodes.entries()) {
        const { ref, ...definition } = node;
        // A boundary event names its host, and that host is usually created in
        // the same request. Resolve it like a flow endpoint so a caller does
        // not have to split the build in two just to attach an event.
        const attachTo = definition.properties?.attachTo;
        const resolvedAttachTo = typeof attachTo === 'string'
          ? idByRef.get(attachTo)
          : undefined;
        const resolvedDefinition = resolvedAttachTo === undefined
          ? definition
          : { ...definition, properties: { ...definition.properties, attachTo: resolvedAttachTo } };
        let created: BpmnDocumentElement;
        try {
          created = await this.createElement(processId, resolvedDefinition);
        } catch (error) {
          throw new Error(
            `nodes[${index}] (ref "${ref}"): ${error instanceof Error ? error.message : String(error)}`
          );
        }
        idByRef.set(ref, created.id);
        elements.push({ ref, elementId: created.id, type: created.type });
      }

      const resolve = (endpoint: string, index: number, side: 'source' | 'target'): string => {
        const byRef = idByRef.get(endpoint);
        if (byRef) return byRef;
        if (context.elements.has(endpoint)) return endpoint;
        throw new Error(
          `flows[${index}].${side} "${endpoint}" is neither a ref in this request `
          + 'nor the id of an existing element'
        );
      };

      const connections: BuildProcessResult['connections'] = [];
      for (const [index, flow] of plan.flows.entries()) {
        const { source, target, label, ...options } = flow;
        const sourceId = resolve(source, index, 'source');
        const targetId = resolve(target, index, 'target');
        let connection: BpmnDocumentConnection;
        try {
          connection = await this.connect(processId, sourceId, targetId, label, options);
        } catch (error) {
          throw new Error(
            `flows[${index}] (${source} -> ${target}): `
            + `${error instanceof Error ? error.message : String(error)}`
          );
        }
        connections.push({
          connectionId: connection.id,
          type: connection.type,
          sourceId: connection.source,
          targetId: connection.target
        });
      }

      return { elements, connections };
    }, expectedRevision);
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
      expectedRevision?: string;
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
    }, undefined, true, false, options.expectedRevision);
  }

  async addTextAnnotation(
    processId: string,
    text: string,
    options: {
      textFormat?: string;
      position?: BpmnDocumentElement['position'];
      size?: BpmnDocumentElement['size'];
      associatedElementId?: string;
      expectedRevision?: string;
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
    return this.commitMutation(context, working => {
      const associatedElement = options.associatedElementId === undefined
        ? undefined
        : working.elements.get(options.associatedElementId);
      if (options.associatedElementId !== undefined && !associatedElement) {
        throw new Error(`Associated element ${options.associatedElementId} not found`);
      }

      const ownerId = associatedElement?.ownerId
        || (working.type === 'collaboration' ? working.id : this.defaultProcessOwner(working));
      const scopeId = associatedElement?.scopeId || ownerId;
      const isCollaborationArtifact = working.type === 'collaboration'
        && ownerId === working.id
        && scopeId === working.id;
      if (!isCollaborationArtifact) {
        this.assertFlowScope(working.document, ownerId, scopeId);
      }

      const properties = {
        text,
        ...(options.textFormat === undefined ? {} : { textFormat: options.textFormat })
      };
      const annotation: BpmnDocumentElement = {
        kind: 'artifact',
        id: this.generateUniqueId(working.document, 'TextAnnotation'),
        type: 'bpmn:TextAnnotation',
        ownerId,
        scopeId,
        position: options.position || {
          x: 100 + working.elements.size * 50,
          y: 200
        },
        size: options.size || getDefaultElementSize('bpmn:TextAnnotation'),
        properties
      };
      this.assertElementProperties(
        working,
        annotation.type,
        annotation.properties,
        ownerId,
        scopeId
      );
      if (!options.position && scopeId !== ownerId) {
        const scope = working.elements.get(scopeId)!;
        const siblingIndex = Array.from(working.elements.values())
          .filter(candidate => candidate.scopeId === scopeId).length;
        annotation.position = {
          x: scope.position.x + 40 + siblingIndex * 150,
          y: scope.position.y + 60
        };
      }
      working.elements.set(annotation.id, annotation);
      if (scopeId !== ownerId) {
        this.fitExpandedFlowContainers(working, scopeId);
      }

      let association: BpmnDocumentConnection | undefined;
      if (associatedElement) {
        const ownership = resolveAssociationOwnership(
          working.document,
          annotation,
          associatedElement
        );
        association = {
          id: this.generateUniqueId(working.document, 'Association'),
          source: annotation.id,
          target: associatedElement.id,
          type: 'bpmn:Association',
          ownerId: ownership.ownerId,
          scopeId: ownership.scopeId,
          associationDirection: 'None',
          waypoints: calculateConnectionWaypoints(annotation, associatedElement),
          properties: {}
        };
        working.connections.set(association.id, association);
      }

      return { annotation, association };
    }, undefined, true, false, options.expectedRevision);
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
    const expectedRevision = typeof typeOrOptions === 'string'
      ? options.expectedRevision
      : (typeOrOptions || options).expectedRevision;
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
      if (!source) throw missingEndpointError(working, 'Source', sourceId);
      if (!target) throw missingEndpointError(working, 'Target', targetId);

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
      if (resolvedType === 'bpmn:SequenceFlow'
        && source.type === 'bpmn:EventBasedGateway'
        && !isEventBasedGatewayTarget(target)) {
        throw new Error(
          `Element ${target.id} cannot follow an event-based gateway; targets must be `
          + 'receive tasks or intermediate catch events with a message, timer, signal '
          + 'or conditional definition'
        );
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
        waypoints: calculateConnectionWaypoints(source, target),
        properties: connectionOptions.documentation === undefined
          ? {}
          : { documentation: connectionOptions.documentation }
      };
      working.connections.set(flowId, connection);
      if (isDefault && source.kind === 'flowNode') {
        source.defaultFlow = flowId;
        source.defaultFlowManaged = true;
      }
      return connection;
    }, undefined, true, false, expectedRevision);
  }

  /** Create a BPMN artifact association. The BPMN direction defaults to None. */
  async addAssociation(
    processId: string,
    sourceId: string,
    targetId: string,
    associationDirection: BpmnConnectOptions['associationDirection'] = 'None',
    expectedRevision?: string
  ): Promise<BpmnDocumentConnection> {
    return this.connect(
      processId,
      sourceId,
      targetId,
      undefined,
      'bpmn:Association',
      { associationDirection, expectedRevision }
    );
  }

  async addLane(
    processId: string,
    poolId: string,
    name: string | undefined,
    flowNodeIds: string[],
    position: 'top' | 'bottom' = 'bottom',
    expectedRevision?: string,
    laneId?: string
  ): Promise<BpmnLane> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      if (working.type !== 'collaboration') {
        throw new Error('Lanes can only be added to pools in collaboration diagrams');
      }
      const participant = working.elements.get(poolId);
      if (!participant || participant.kind !== 'participant') {
        throw new Error(`Participant ${poolId} not found. ${poolHint(working.document, poolId)}`);
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
      if (flowNodeIds.length > TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems) {
        throw new Error(
          `A lane accepts at most ${TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems} flowNodeIds`
        );
      }
      if (new Set(flowNodeIds).size !== flowNodeIds.length) {
        throw new Error('Lane flowNodeIds must be unique');
      }

      const processRef = participant.processRef;
      for (const memberId of flowNodeIds) {
        const member = working.elements.get(memberId);
        // Missing and wrong-kind are different problems with different fixes,
        // and saying "is not a flow node" about an id that does not exist sends
        // the caller looking for an element that was never there.
        if (!member) {
          throw new Error(`Lane member "${memberId}" not found`);
        }
        if (member.kind !== 'flowNode') {
          throw new Error(
            `Lane member ${memberId} is a ${member.type}, which is not a flow node`
          );
        }
        if (member.ownerId !== processRef || member.scopeId !== processRef) {
          throw new Error(`Lane member ${memberId} is not in participant ${poolId}'s process scope`);
        }
      }

      // Adding to a lane that already exists is the common case once elements
      // are created after the lanes, so it is an explicit argument rather than
      // a second lane that happens to share a name.
      const existingLane = laneId === undefined ? undefined : working.document.lanes.get(laneId);
      if (laneId !== undefined) {
        if (!existingLane) {
          throw new Error(`Lane "${laneId}" not found`);
        }
        if (existingLane.processId !== processRef) {
          throw new Error(`Lane ${laneId} does not belong to participant ${poolId}`);
        }
      } else if (name !== undefined) {
        const duplicate = Array.from(working.document.lanes.values())
          .find(lane => lane.processId === processRef && lane.name === name);
        if (duplicate) {
          throw new Error(
            `Participant ${poolId} already has a lane named "${name}" (${duplicate.id}). `
            + `Pass laneId "${duplicate.id}" to add these nodes to it, or choose another name.`
          );
        }
      }
      if (!existingLane && (name === undefined || name.length === 0)) {
        throw new Error('A new lane requires a name');
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

      if (existingLane) {
        existingLane.flowNodeRefs = [...existingLane.flowNodeRefs, ...flowNodeIds];
        if (name !== undefined) existingLane.name = name;
        this.layoutPoolLanes(working, participant.id);
        return existingLane;
      }

      const lane: BpmnLane = {
        id: this.generateUniqueId(working.document, 'Lane'),
        name: name!,
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
    }, undefined, true, false, expectedRevision);
  }

  async updateElement(
    processId: string,
    elementId: string,
    update: BpmnElementUpdate,
    expectedRevision?: string
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
    }, undefined, true, false, expectedRevision, false, false, true);
  }

  async updateElementGeometry(
    processId: string,
    elementId: string,
    update: ElementGeometryUpdate
  ): Promise<ElementGeometryMutationResult> {
    this.assertGeometryBounds(update.bounds, 'bounds');
    if (update.labelBounds) this.assertGeometryBounds(update.labelBounds, 'labelBounds');
    if (update.expectedBounds) this.assertGeometryBounds(update.expectedBounds, 'expectedBounds');

    const context = this.getProcess(processId);
    return this.commitMutation(context, async working => {
      const shape = this.shapeForElement(working.document, elementId);
      const modelElement = working.elements.get(elementId);
      const modelLane = working.document.lanes.get(elementId);
      if (!shape || (!modelElement && !modelLane)) {
        throw new Error(`Rendered element ${elementId} not found`);
      }

      const before = this.elementGeometryState(elementId, shape);
      if (update.expectedBounds && !this.geometryBoundsEqual(update.expectedBounds, before.bounds)) {
        throw new ElementGeometryConflictError(
          elementId,
          { ...update.expectedBounds },
          { ...before.bounds }
        );
      }

      const boundsChanged = !this.geometryBoundsEqual(before.bounds, update.bounds);
      const incident = Array.from(working.connections.values()).filter(
        connection => connection.source === elementId || connection.target === elementId
      );
      if (boundsChanged && incident.length > 0) {
        if (!update.incidentConnectionPolicy) {
          throw new Error(
            `Element ${elementId} has ${incident.length} incident connection(s); `
            + 'incidentConnectionPolicy is required when changing its bounds'
          );
        }
        if (update.incidentConnectionPolicy === 'reject') {
          throw new Error(
            `Element ${elementId} has ${incident.length} incident connection(s); `
            + 'use snap-endpoints or an atomic geometry patch'
          );
        }
      }

      const beforeXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      shape.bounds = { ...update.bounds };
      if (Object.prototype.hasOwnProperty.call(update, 'labelBounds')) {
        shape.labelBounds = update.labelBounds ? { ...update.labelBounds } : undefined;
        shape.labelBoundsCleared = update.labelBounds === null;
      }
      const target = modelElement ?? modelLane!;
      target.position = { x: update.bounds.x, y: update.bounds.y };
      target.size = { width: update.bounds.width, height: update.bounds.height };

      if (boundsChanged && update.incidentConnectionPolicy === 'snap-endpoints') {
        for (const connection of incident) {
          if (!Array.from(working.document.diagram.edges.values()).some(
            edge => edge.connectionId === connection.id
          )) {
            throw new Error(`Incident connection ${connection.id} has no rendered BPMNEdge`);
          }
          this.snapIncidentConnection(working.document, connection, elementId, update.bounds);
        }
      }

      const afterXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const validationOptions = {
        elementIds: [elementId],
        maxShapes: this.resourceLimits.maxLayoutElements,
        maxEdges: this.resourceLimits.maxLayoutConnections,
        maxDiagnostics: this.resourceLimits.maxListingItems
      };
      const [beforeReport, afterReport] = await Promise.all([
        validateBpmnGeometry(beforeXml, validationOptions),
        validateBpmnGeometry(afterXml, validationOptions)
      ]);
      this.assertSafeElementGeometry(
        elementId,
        beforeReport.diagnostics,
        afterReport.diagnostics,
        update.collisionPolicy
      );

      return {
        before,
        after: this.elementGeometryState(elementId, shape),
        diagnostics: afterReport.diagnostics
      };
    }, undefined, true, false, update.expectedRevision, update.dryRun);
  }

  async updateConnectionGeometry(
    processId: string,
    connectionId: string,
    update: ConnectionGeometryUpdate
  ): Promise<ConnectionGeometryMutationResult> {
    this.assertBpmnIdentifier(connectionId, 'connectionId');
    this.assertGeometryWaypoints(update.waypoints, 'waypoints');
    if (update.expectedWaypoints) {
      this.assertGeometryWaypoints(update.expectedWaypoints, 'expectedWaypoints');
    }
    if (update.labelBounds) this.assertGeometryBounds(update.labelBounds, 'labelBounds');

    const context = this.getProcess(processId);
    return this.commitMutation(context, async working => {
      const connection = working.connections.get(connectionId);
      if (!connection) throw new Error(`Connection ${connectionId} not found`);
      const edge = this.edgeForConnection(working.document, connectionId);
      if (!edge) throw new Error(`Rendered connection ${connectionId} has no BPMNEdge`);

      const before = this.connectionGeometryState(connectionId, edge);
      if (update.expectedWaypoints
        && !this.geometryWaypointsEqual(update.expectedWaypoints, before.waypoints)) {
        throw new ConnectionGeometryConflictError(
          connectionId,
          'waypoints_mismatch',
          before.waypoints.map(point => ({ ...point })),
          before.geometryRevision,
          update.expectedWaypoints.map(point => ({ ...point })),
          update.expectedGeometryRevision
        );
      }
      if (update.expectedGeometryRevision
        && update.expectedGeometryRevision !== before.geometryRevision) {
        throw new ConnectionGeometryConflictError(
          connectionId,
          'geometry_revision_mismatch',
          before.waypoints.map(point => ({ ...point })),
          before.geometryRevision,
          update.expectedWaypoints?.map(point => ({ ...point })),
          update.expectedGeometryRevision
        );
      }

      const beforeXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const waypoints = update.waypoints.map(point => ({ ...point }));
      if (update.endpointPolicy === 'snap-to-boundary') {
        const sourceShape = this.shapeForElement(working.document, connection.source);
        const targetShape = this.shapeForElement(working.document, connection.target);
        if (!sourceShape || !targetShape) {
          throw new Error(
            `Connection ${connectionId} requires rendered source and target BPMNShapes`
          );
        }
        waypoints[0] = this.pointOnBounds(sourceShape.bounds, waypoints[1]);
        waypoints[waypoints.length - 1] = this.pointOnBounds(
          targetShape.bounds,
          waypoints[waypoints.length - 2]
        );
      }

      connection.waypoints = waypoints.map(point => ({ ...point }));
      edge.waypoints = waypoints.map(point => ({ ...point }));
      if (Object.prototype.hasOwnProperty.call(update, 'labelBounds')) {
        edge.labelBounds = update.labelBounds ? { ...update.labelBounds } : undefined;
        edge.labelBoundsCleared = update.labelBounds === null;
      }

      const afterXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const validationOptions = {
        connectionIds: [connectionId],
        maxShapes: this.resourceLimits.maxLayoutElements,
        maxEdges: this.resourceLimits.maxLayoutConnections,
        maxDiagnostics: this.resourceLimits.maxListingItems
      };
      const [beforeReport, afterReport] = await Promise.all([
        validateBpmnGeometry(beforeXml, validationOptions),
        validateBpmnGeometry(afterXml, validationOptions)
      ]);
      const introducedDiagnostics = this.assertSafeConnectionGeometry(
        connectionId,
        beforeReport.diagnostics,
        afterReport.diagnostics,
        update.collisionPolicy
      );

      return {
        before,
        after: this.connectionGeometryState(connectionId, edge),
        diagnostics: afterReport.diagnostics,
        introducedDiagnostics
      };
    }, undefined, true, false, update.expectedRevision, update.dryRun);
  }

  async updateConnection(
    processId: string,
    connectionId: string,
    update: ConnectionSemanticUpdate
  ): Promise<ConnectionSemanticMutationResult> {
    this.assertBpmnIdentifier(connectionId, 'connectionId');
    if (update.sourceId) this.assertBpmnIdentifier(update.sourceId, 'sourceId');
    if (update.targetId) this.assertBpmnIdentifier(update.targetId, 'targetId');
    // Both guards are optional, as they are on every other mutation. Supplying
    // one still makes the update conditional; requiring one turned a label
    // change into a forced get_connection round trip (mcp-bpmn-8u0.7).

    const context = this.getProcess(processId);
    return this.commitMutation(context, async working => {
      const connection = working.connections.get(connectionId);
      if (!connection) throw new Error(`Connection ${connectionId} not found`);
      const before = connectionSemanticState(working.document, connection);
      if (update.expectedSemanticRevision
        && update.expectedSemanticRevision !== before.semanticRevision) {
        throw new ConnectionSemanticConflictError(
          connectionId,
          update.expectedSemanticRevision,
          before.semanticRevision
        );
      }

      const sourceId = update.sourceId ?? connection.source;
      const targetId = update.targetId ?? connection.target;
      const source = working.elements.get(sourceId);
      const target = working.elements.get(targetId);
      if (!source) throw missingEndpointError(working, 'Source', sourceId);
      if (!target) throw missingEndpointError(working, 'Target', targetId);
      const endpointsChanged = sourceId !== connection.source || targetId !== connection.target;
      if (endpointsChanged && update.endpointPolicy !== 'snap-to-boundary') {
        throw new Error('Endpoint changes require endpointPolicy "snap-to-boundary"');
      }

      let ownerId: string;
      let scopeId: string;
      if (connection.type === 'bpmn:SequenceFlow') {
        if (source.kind !== 'flowNode' || target.kind !== 'flowNode') {
          throw new Error('Sequence flows can only connect BPMN flow nodes');
        }
        if (source.ownerId !== target.ownerId || source.scopeId !== target.scopeId) {
          throw new Error('Sequence flows cannot cross process or nested-scope boundaries');
        }
        ownerId = source.ownerId;
        scopeId = source.scopeId;
      } else if (connection.type === 'bpmn:MessageFlow') {
        if (working.type !== 'collaboration') {
          throw new Error('Message flows can only belong to collaboration diagrams');
        }
        assertValidMessageFlowEndpoints(working.document, working.id, source, target);
        ownerId = working.id;
        scopeId = working.id;
      } else {
        ({ ownerId, scopeId } = resolveAssociationOwnership(working.document, source, target));
      }

      if (Object.prototype.hasOwnProperty.call(update, 'associationDirection')
        && connection.type !== 'bpmn:Association') {
        throw new Error('associationDirection can only be set for associations');
      }
      if (Object.prototype.hasOwnProperty.call(update, 'condition')
        && connection.type !== 'bpmn:SequenceFlow') {
        throw new Error('Conditions can only be set on sequence flows');
      }
      if (Object.prototype.hasOwnProperty.call(update, 'isDefault')
        && connection.type !== 'bpmn:SequenceFlow') {
        throw new Error('Only sequence flows can be default flows');
      }
      // bpmn:Association has no name attribute, so a label set here used to be
      // accepted, reported back, and then silently discarded on save. Reject it
      // instead of losing it.
      if (Object.prototype.hasOwnProperty.call(update, 'label')
        && update.label !== null
        && connection.type === 'bpmn:Association') {
        throw new Error(
          'Labels are only valid on sequence flows and message flows; '
          + 'BPMN associations have no name. Use add_text_annotation to annotate one.'
        );
      }

      let condition = connection.condition ? { ...connection.condition } : undefined;
      if (Object.prototype.hasOwnProperty.call(update, 'condition')) {
        if (update.condition === null) {
          condition = undefined;
        } else {
          const body = update.condition?.body;
          if (typeof body !== 'string' || body.trim().length === 0) {
            throw new Error('Condition expression must be a non-empty string');
          }
          const language = update.condition?.language;
          if (language !== undefined && language !== null && language.trim().length === 0) {
            throw new Error('Condition language must be a non-empty string or null');
          }
          condition = {
            body,
            type: condition?.type || 'bpmn:FormalExpression',
            ...(language === null ? {} : { language: language ?? condition?.language }),
            ...(condition?.evaluatesToTypeRef
              ? { evaluatesToTypeRef: condition.evaluatesToTypeRef }
              : {})
          };
        }
      }
      if (condition && !supportsConditionalOutgoingFlow(source)) {
        throw new Error(`Element ${source.id} cannot own a conditional sequence flow`);
      }

      const shouldBeDefault = update.isDefault ?? before.isDefault;
      if (shouldBeDefault && connection.type !== 'bpmn:SequenceFlow') {
        throw new Error('Only sequence flows can be default flows');
      }
      if (shouldBeDefault && !supportsConditionalOutgoingFlow(source)) {
        throw new Error(`Element ${source.id} cannot own a default sequence flow`);
      }
      if (shouldBeDefault && condition) {
        throw new Error('A default sequence flow cannot have a condition');
      }
      if (shouldBeDefault && source.kind === 'flowNode'
        && source.defaultFlow && source.defaultFlow !== connection.id) {
        throw new Error(`Element ${source.id} already owns default flow ${source.defaultFlow}`);
      }

      const beforeXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const previousSource = working.elements.get(connection.source);
      if (previousSource?.kind === 'flowNode' && previousSource.defaultFlow === connection.id
        && (!shouldBeDefault || previousSource.id !== source.id)) {
        previousSource.defaultFlow = undefined;
        previousSource.defaultFlowManaged = true;
      }
      if (shouldBeDefault && source.kind === 'flowNode') {
        source.defaultFlow = connection.id;
        source.defaultFlowManaged = true;
      }

      connection.source = sourceId;
      connection.target = targetId;
      connection.ownerId = ownerId;
      connection.scopeId = scopeId;
      connection.condition = condition;
      if (Object.prototype.hasOwnProperty.call(update, 'label')) {
        connection.label = update.label === null ? undefined : update.label;
      }
      if (connection.type === 'bpmn:Association'
        && update.associationDirection !== undefined) {
        connection.associationDirection = update.associationDirection;
      }

      if (endpointsChanged) {
        const edge = this.edgeForConnection(working.document, connection.id);
        const sourceShape = this.shapeForElement(working.document, source.id);
        const targetShape = this.shapeForElement(working.document, target.id);
        if (!edge || !sourceShape || !targetShape || edge.waypoints.length < 2) {
          throw new Error(
            `Connection ${connection.id} requires rendered edge and endpoint BPMNShapes for rewiring`
          );
        }
        const waypoints = edge.waypoints.map(point => ({ ...point }));
        waypoints[0] = this.pointOnBounds(sourceShape.bounds, waypoints[1]);
        waypoints[waypoints.length - 1] = this.pointOnBounds(
          targetShape.bounds,
          waypoints[waypoints.length - 2]
        );
        edge.waypoints = waypoints.map(point => ({ ...point }));
        connection.waypoints = waypoints.map(point => ({ ...point }));
      }

      const afterXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const validationOptions = {
        connectionIds: [connectionId],
        maxShapes: this.resourceLimits.maxLayoutElements,
        maxEdges: this.resourceLimits.maxLayoutConnections,
        maxDiagnostics: this.resourceLimits.maxListingItems
      };
      const [beforeReport, afterReport] = await Promise.all([
        validateBpmnGeometry(beforeXml, validationOptions),
        validateBpmnGeometry(afterXml, validationOptions)
      ]);
      const introducedDiagnostics = this.assertSafeConnectionGeometry(
        connectionId,
        beforeReport.diagnostics,
        afterReport.diagnostics,
        update.collisionPolicy,
        !endpointsChanged
      );
      return {
        before,
        after: connectionSemanticState(working.document, connection),
        diagnostics: afterReport.diagnostics,
        introducedDiagnostics
      };
    }, undefined, true, false, update.expectedRevision);
  }

  async applyGeometryPatch(
    processId: string,
    patch: GeometryPatchUpdate
  ): Promise<GeometryPatchMutationResult> {
    const updateCount = patch.elementUpdates.length + patch.connectionUpdates.length;
    if (updateCount < 1 || updateCount > 256) {
      throw new Error('Geometry patch must contain between 1 and 256 object updates');
    }

    const elementIds = new Set<string>();
    for (const update of patch.elementUpdates) {
      this.assertBpmnIdentifier(update.elementId, 'elementId');
      if (elementIds.has(update.elementId)) {
        throw new Error(`Geometry patch contains duplicate element ${update.elementId}`);
      }
      elementIds.add(update.elementId);
      if (!Object.prototype.hasOwnProperty.call(update, 'bounds')
        && !Object.prototype.hasOwnProperty.call(update, 'labelBounds')) {
        throw new Error(`Geometry patch element ${update.elementId} has no update fields`);
      }
      if (update.bounds) this.assertGeometryBounds(update.bounds, 'bounds');
      if (update.labelBounds) this.assertGeometryBounds(update.labelBounds, 'labelBounds');
      if (update.expectedBounds) this.assertGeometryBounds(update.expectedBounds, 'expectedBounds');
      if (update.expectedLabelBounds) {
        this.assertGeometryBounds(update.expectedLabelBounds, 'expectedLabelBounds');
      }
      if (!patch.expectedRevision && !update.expectedBounds) {
        throw new Error(
          `Geometry patch element ${update.elementId} requires expectedBounds when expectedRevision is omitted`
        );
      }
      if (!patch.expectedRevision
        && Object.prototype.hasOwnProperty.call(update, 'labelBounds')
        && !Object.prototype.hasOwnProperty.call(update, 'expectedLabelBounds')) {
        throw new Error(
          `Geometry patch element ${update.elementId} requires expectedLabelBounds when changing its label without expectedRevision`
        );
      }
    }

    const connectionIds = new Set<string>();
    for (const update of patch.connectionUpdates) {
      this.assertBpmnIdentifier(update.connectionId, 'connectionId');
      if (connectionIds.has(update.connectionId)) {
        throw new Error(`Geometry patch contains duplicate connection ${update.connectionId}`);
      }
      connectionIds.add(update.connectionId);
      if (!Object.prototype.hasOwnProperty.call(update, 'waypoints')
        && !Object.prototype.hasOwnProperty.call(update, 'labelBounds')) {
        throw new Error(`Geometry patch connection ${update.connectionId} has no update fields`);
      }
      if (update.waypoints) this.assertGeometryWaypoints(update.waypoints, 'waypoints');
      if (update.expectedWaypoints) {
        this.assertGeometryWaypoints(update.expectedWaypoints, 'expectedWaypoints');
      }
      if (update.labelBounds) this.assertGeometryBounds(update.labelBounds, 'labelBounds');
      if (!patch.expectedRevision && !update.expectedGeometryRevision) {
        throw new Error(
          `Geometry patch connection ${update.connectionId} requires expectedGeometryRevision when expectedRevision is omitted`
        );
      }
    }

    const context = this.getProcess(processId);
    return this.commitMutation(context, async working => {
      const elementTargets = patch.elementUpdates.map(update => {
        const shape = this.shapeForElement(working.document, update.elementId);
        const modelElement = working.elements.get(update.elementId);
        const modelLane = working.document.lanes.get(update.elementId);
        if (!shape || (!modelElement && !modelLane)) {
          throw new Error(`Rendered element ${update.elementId} not found`);
        }
        const before = this.elementGeometryState(update.elementId, shape);
        if (update.expectedBounds
          && !this.geometryBoundsEqual(update.expectedBounds, before.bounds)) {
          throw new ElementGeometryConflictError(
            update.elementId,
            { ...update.expectedBounds },
            { ...before.bounds }
          );
        }
        if (Object.prototype.hasOwnProperty.call(update, 'expectedLabelBounds')
          && !this.optionalGeometryBoundsEqual(update.expectedLabelBounds, before.labelBounds)) {
          throw new GeometryPatchConflictError(
            'element',
            update.elementId,
            'labelBounds',
            update.expectedLabelBounds ?? null,
            before.labelBounds ?? null
          );
        }
        return { update, shape, target: modelElement ?? modelLane!, before };
      });

      const connectionTargets = patch.connectionUpdates.map(update => {
        const connection = working.connections.get(update.connectionId);
        if (!connection) throw new Error(`Connection ${update.connectionId} not found`);
        const edge = this.edgeForConnection(working.document, update.connectionId);
        if (!edge) {
          throw new Error(`Rendered connection ${update.connectionId} has no BPMNEdge`);
        }
        const before = this.connectionGeometryState(update.connectionId, edge);
        if (update.expectedWaypoints
          && !this.geometryWaypointsEqual(update.expectedWaypoints, before.waypoints)) {
          throw new ConnectionGeometryConflictError(
            update.connectionId,
            'waypoints_mismatch',
            before.waypoints.map(point => ({ ...point })),
            before.geometryRevision,
            update.expectedWaypoints.map(point => ({ ...point })),
            update.expectedGeometryRevision
          );
        }
        if (update.expectedGeometryRevision
          && update.expectedGeometryRevision !== before.geometryRevision) {
          throw new ConnectionGeometryConflictError(
            update.connectionId,
            'geometry_revision_mismatch',
            before.waypoints.map(point => ({ ...point })),
            before.geometryRevision,
            update.expectedWaypoints?.map(point => ({ ...point })),
            update.expectedGeometryRevision
          );
        }
        return { update, connection, edge, before };
      });

      const beforeXml = await this.serializer.serialize(this.cloneDocument(working.document), true);

      for (const { update, shape, target } of elementTargets) {
        if (update.bounds) {
          shape.bounds = { ...update.bounds };
          target.position = { x: update.bounds.x, y: update.bounds.y };
          target.size = { width: update.bounds.width, height: update.bounds.height };
        }
        if (Object.prototype.hasOwnProperty.call(update, 'labelBounds')) {
          shape.labelBounds = update.labelBounds ? { ...update.labelBounds } : undefined;
          shape.labelBoundsCleared = update.labelBounds === null;
        }
      }

      for (const { update, connection, edge } of connectionTargets) {
        if (update.waypoints) {
          const waypoints = update.waypoints.map(point => ({ ...point }));
          if (update.endpointPolicy === 'snap-to-boundary') {
            const sourceShape = this.shapeForElement(working.document, connection.source);
            const targetShape = this.shapeForElement(working.document, connection.target);
            if (!sourceShape || !targetShape) {
              throw new Error(
                `Connection ${update.connectionId} requires rendered source and target BPMNShapes`
              );
            }
            waypoints[0] = this.pointOnBounds(sourceShape.bounds, waypoints[1]);
            waypoints[waypoints.length - 1] = this.pointOnBounds(
              targetShape.bounds,
              waypoints[waypoints.length - 2]
            );
          }
          connection.waypoints = waypoints.map(point => ({ ...point }));
          edge.waypoints = waypoints.map(point => ({ ...point }));
        }
        if (Object.prototype.hasOwnProperty.call(update, 'labelBounds')) {
          edge.labelBounds = update.labelBounds ? { ...update.labelBounds } : undefined;
          edge.labelBoundsCleared = update.labelBounds === null;
        }
      }

      const afterXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const validationOptions = {
        maxShapes: this.resourceLimits.maxLayoutElements,
        maxEdges: this.resourceLimits.maxLayoutConnections,
        maxDiagnostics: this.resourceLimits.maxListingItems
      };
      const [beforeReport, afterReport] = await Promise.all([
        validateBpmnGeometry(beforeXml, validationOptions),
        validateBpmnGeometry(afterXml, validationOptions)
      ]);
      const introducedDiagnostics = this.assertSafeGeometryPatch(
        beforeReport.diagnostics,
        afterReport.diagnostics,
        patch.collisionPolicy
      );

      return {
        elements: elementTargets.map(({ update, shape, before }) => ({
          elementId: update.elementId,
          before,
          after: this.elementGeometryState(update.elementId, shape)
        })),
        connections: connectionTargets.map(({ update, edge, before }) => ({
          connectionId: update.connectionId,
          before,
          after: this.connectionGeometryState(update.connectionId, edge),
          endpointPolicy: update.endpointPolicy
        })),
        diagnostics: afterReport.diagnostics,
        introducedDiagnostics
      };
    }, undefined, true, false, patch.expectedRevision, patch.dryRun);
  }

  async routeConnection(
    processId: string,
    connectionId: string,
    update: ConnectionRouteUpdate
  ): Promise<ConnectionRouteMutationResult> {
    this.assertBpmnIdentifier(connectionId, 'connectionId');
    for (const elementId of update.avoidElementIds) {
      this.assertBpmnIdentifier(elementId, 'avoidElementIds');
    }
    for (const avoidedConnectionId of update.avoidConnectionIds) {
      this.assertBpmnIdentifier(avoidedConnectionId, 'avoidConnectionIds');
    }
    if (!Number.isFinite(update.clearance) || update.clearance < 0) {
      throw new Error('Connection routing clearance must be a non-negative finite number');
    }
    if (update.preserveOtherGeometry !== true) {
      throw new Error('route_connection requires preserveOtherGeometry to be true');
    }

    const context = this.getProcess(processId);
    return this.commitMutation(context, async working => {
      const connection = working.connections.get(connectionId);
      if (!connection) throw new Error(`Connection ${connectionId} not found`);
      const edge = this.edgeForConnection(working.document, connectionId);
      if (!edge) throw new Error(`Rendered connection ${connectionId} has no BPMNEdge`);
      const before = this.connectionGeometryState(connectionId, edge);
      if (update.expectedGeometryRevision
        && update.expectedGeometryRevision !== before.geometryRevision) {
        throw new ConnectionGeometryConflictError(
          connectionId,
          'geometry_revision_mismatch',
          before.waypoints.map(point => ({ ...point })),
          before.geometryRevision,
          undefined,
          update.expectedGeometryRevision
        );
      }

      const beforeXml = await this.serializer.serialize(this.cloneDocument(working.document), true);
      const validationOptions = {
        connectionIds: [connectionId],
        clearance: update.clearance,
        requireOrthogonal: true,
        maxShapes: this.resourceLimits.maxLayoutElements,
        maxEdges: this.resourceLimits.maxLayoutConnections,
        maxDiagnostics: this.resourceLimits.maxListingItems
      };
      const beforeReport = await validateBpmnGeometry(beforeXml, validationOptions);
      const router = new ConnectionRouter();
      const candidates = router.route(working.document, connectionId, {
        avoidElementIds: update.avoidElementIds,
        avoidConnectionIds: update.avoidConnectionIds,
        clearance: update.clearance,
        maxCoordinate: TOOL_INPUT_LIMITS.coordinate.max
      });
      const originalWaypoints = edge.waypoints.map(point => ({ ...point }));
      const originalLabelBounds = edge.labelBounds ? { ...edge.labelBounds } : undefined;
      const originalLabelBoundsCleared = edge.labelBoundsCleared;
      const rankedDiagnostics: RankedConnectionRouteDiagnostic[] = [];
      const requestedAvoidIds = new Set([
        ...update.avoidElementIds,
        ...update.avoidConnectionIds
      ]);
      let selected: {
        candidate: ConnectionRouteCandidate;
        diagnostics: GeometryDiagnostic[];
        introducedDiagnostics: GeometryDiagnostic[];
      } | undefined;

      for (const [index, candidate] of candidates.entries()) {
        let diagnostics = candidate.diagnostics;
        let introducedDiagnostics = candidate.diagnostics;
        let terminalDiagnosticFailure = false;
        if (candidate.diagnostics.length === 0) {
          connection.waypoints = candidate.waypoints.map(point => ({ ...point }));
          edge.waypoints = candidate.waypoints.map(point => ({ ...point }));
          if (candidate.labelBounds) {
            edge.labelBounds = { ...candidate.labelBounds };
            edge.labelBoundsCleared = false;
          }
          const candidateXml = await this.serializer.serialize(
            this.cloneDocument(working.document),
            true
          );
          const report = await validateBpmnGeometry(candidateXml, validationOptions);
          diagnostics = report.diagnostics;
          introducedDiagnostics = this.introducedGeometryDiagnostics(
            beforeReport.diagnostics,
            report.diagnostics
          );
          terminalDiagnosticFailure = report.diagnostics.some(item =>
            item.code === 'DIAGNOSTICS_TRUNCATED'
              || item.code === 'RESOURCE_LIMIT_EXCEEDED');
          const requestedAvoidFailure = report.diagnostics.some(item =>
            item.ids.includes(connectionId)
              && item.ids.some(id => requestedAvoidIds.has(id))
              && [
                'EDGE_SHAPE_COLLISION',
                'EDGE_EDGE_CROSSING',
                'LABEL_OVERLAP',
                'MINIMUM_CLEARANCE'
              ].includes(item.code));
          const rejected = terminalDiagnosticFailure
            || requestedAvoidFailure
            || introducedDiagnostics.some(item => item.severity === 'error'
            || item.code === 'MINIMUM_CLEARANCE'
            || item.code === 'NON_ORTHOGONAL_ROUTE'
            || item.code === 'DIAGNOSTICS_TRUNCATED'
            || item.code === 'RESOURCE_LIMIT_EXCEEDED');
          if (!rejected) {
            selected = { candidate, diagnostics, introducedDiagnostics };
          }
        }
        rankedDiagnostics.push({
          rank: index + 1,
          waypoints: candidate.waypoints.map(point => ({ ...point })),
          labelBounds: candidate.labelBounds ? { ...candidate.labelBounds } : null,
          scoreBreakdown: { ...candidate.score },
          diagnostics
        });
        if (selected || terminalDiagnosticFailure) break;
      }

      if (!selected) {
        connection.waypoints = originalWaypoints.map(point => ({ ...point }));
        edge.waypoints = originalWaypoints.map(point => ({ ...point }));
        edge.labelBounds = originalLabelBounds ? { ...originalLabelBounds } : undefined;
        edge.labelBoundsCleared = originalLabelBoundsCleared;
        throw new ConnectionRoutingFailureError(
          connectionId,
          rankedDiagnostics.slice(0, Math.min(10, this.resourceLimits.maxListingItems))
        );
      }

      const proposed = this.connectionGeometryState(connectionId, edge);
      const connectionUpdate = {
        connectionId,
        waypoints: proposed.waypoints.map(point => ({ ...point })),
        ...(proposed.labelBounds ? { labelBounds: { ...proposed.labelBounds } } : {}),
        expectedGeometryRevision: before.geometryRevision,
        endpointPolicy: 'exact' as const
      };
      return {
        connectionId,
        proposedWaypoints: proposed.waypoints.map(point => ({ ...point })),
        proposedLabelBounds: proposed.labelBounds ? { ...proposed.labelBounds } : null,
        geometryRevision: proposed.geometryRevision,
        scoreBreakdown: { ...selected.candidate.score },
        diagnostics: selected.diagnostics,
        introducedDiagnostics: selected.introducedDiagnostics,
        rankedDiagnostics,
        geometryPatch: {
          elementUpdates: [],
          connectionUpdates: [connectionUpdate],
          expectedRevision: working.revision,
          collisionPolicy: 'reject-new',
          dryRun: false
        }
      };
    }, undefined, true, false, undefined, !update.apply);
  }

  async deleteElement(
    processId: string,
    elementId: string,
    expectedRevision?: string
  ): Promise<DeleteElementResult> {
    const context = this.getProcess(processId);
    return this.commitMutation(context, working => {
      const connection = working.connections.get(elementId);
      if (connection) {
        if (!isBpmnConnectionType(connection.type)) {
          throw new Error(
            `Connection ${elementId} has unsupported type ${String(connection.type)}`
          );
        }
        working.connections.delete(elementId);
        for (const candidate of working.elements.values()) {
          if (candidate.kind === 'flowNode' && candidate.defaultFlow === elementId) {
            candidate.defaultFlow = undefined;
            candidate.defaultFlowManaged = true;
          }
        }
        return { removedConnectionCount: 1, removedElementIds: [] };
      }
      const lane = working.document.lanes.get(elementId);
      if (lane) {
        const processRef = lane.processId;
        this.deleteLaneHierarchy(working.document, lane.id);
        const participant = Array.from(working.elements.values()).find(
          candidate => candidate.kind === 'participant' && candidate.processRef === processRef
        );
        if (participant?.kind === 'participant') this.layoutPoolLanes(working, participant.id);
        return { removedConnectionCount: 0, removedElementIds: [] };
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
      this.clearReferencesToDeletedElements(working, idsToDelete);
      return {
        removedConnectionCount: connectionsToDelete.length,
        // Every element the cascade removed, the requested one first, so a
        // caller can report exactly what disappeared instead of only counting
        // connections.
        removedElementIds: [
          elementId,
          ...Array.from(idsToDelete).filter(id => id !== elementId).sort(compareStableText)
        ]
      };
    }, undefined, true, false, expectedRevision);
  }

  /**
   * Drop property-level references from surviving elements to elements that
   * were just deleted.
   *
   * Sequence-flow and containment references are cascaded elsewhere, but a
   * compensation event's activityRef and a multi-instance activity's loop data
   * references point at arbitrary elements. Left dangling, they serialize into
   * unresolvable references and the whole mutation is rolled back with an
   * error that never names the element holding the stale reference. Both
   * properties are optional in BPMN, so clearing them leaves a valid model.
   */
  private clearReferencesToDeletedElements(
    working: ProcessContext,
    deletedIds: ReadonlySet<string>
  ): void {
    for (const candidate of working.elements.values()) {
      const payload = candidate.properties.eventDefinitionPayload as
        Record<string, unknown> | undefined;
      if (payload && typeof payload.activityRef === 'string'
        && deletedIds.has(payload.activityRef)) {
        const { activityRef: _removed, ...retained } = payload;
        candidate.properties = {
          ...candidate.properties,
          eventDefinitionPayload: retained
        };
      }

      const multiInstance = candidate.properties.multiInstance as
        Record<string, unknown> | undefined;
      if (!multiInstance) continue;
      const staleLoopReferences = (['loopDataInputRef', 'loopDataOutputRef'] as const)
        .filter(property => typeof multiInstance[property] === 'string'
          && deletedIds.has(multiInstance[property] as string));
      if (staleLoopReferences.length === 0) continue;
      const retained = { ...multiInstance };
      for (const property of staleLoopReferences) delete retained[property];
      candidate.properties = { ...candidate.properties, multiInstance: retained };
    }
  }

  async deleteAssociation(
    processId: string,
    associationId: string,
    expectedRevision?: string
  ): Promise<void> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, working => {
      const connection = working.connections.get(associationId);
      if (!connection || connection.type !== 'bpmn:Association') {
        throw new Error(`Association ${associationId} not found`);
      }
      working.connections.delete(associationId);
    }, undefined, true, false, expectedRevision);
  }

  async exportXml(processId: string, formatted = true): Promise<string> {
    const context = this.getProcess(processId);
    return this.withProcessLock(processId, () => {
      if (this.processes.get(processId) !== context) {
        throw new Error(`Process ${processId} not found`);
      }
      return this.serializer.serialize(this.cloneDocument(context.document), formatted);
    });
  }

  async save(processId: string, expectedRevision?: string): Promise<string> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, () => undefined, undefined, true, false, expectedRevision);
    return context.filename!;
  }

  async saveAs(
    processId: string,
    filename: string,
    expectedRevision?: string,
    overwrite = false
  ): Promise<string> {
    const context = this.getProcess(processId);
    const normalizedFilename = normalizeBpmnFilename(filename);
    const previousFilename = context.filename;
    const previousWasPlaceholder = context.filenameManaged === true;
    await this.commitMutation(
      context,
      working => {
        working.filename = normalizedFilename;
        working.filenameManaged = false;
      },
      normalizedFilename,
      false,
      false,
      expectedRevision,
      false,
      overwrite
    );
    // The old file was a server-generated placeholder for this same diagram,
    // so keeping it would leave two files claiming to be the same process.
    // A name the caller chose is never removed on their behalf.
    if (previousWasPlaceholder && previousFilename && previousFilename !== normalizedFilename) {
      await this.deleteDiagram(previousFilename).catch(() => undefined);
    }
    return normalizedFilename;
  }

  getActiveFilename(processId: string): string {
    const context = this.getProcess(processId);
    if (!context.filename) {
      throw new Error(`Process ${processId} has no active filename`);
    }
    return context.filename;
  }

  getRevision(processId: string): string {
    return this.getProcess(processId).revision;
  }

  async importXml(
    xml: string,
    name?: string,
    authoredProfile?: BpmnExtensionProfile,
    requestedFilename?: string
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
    this.assignInitialFilename(context, requestedFilename);
    await this.commitMutation(context, () => undefined, undefined, false, true);
    this.processes.set(context.id, context);
    return context;
  }

  /**
   * Give a freshly created diagram its autosave target, recording whether the
   * caller chose the name. A generated name is normalized the same way
   * save_as normalizes one, so both paths produce a `.bpmn` file.
   */
  private assignInitialFilename(context: ProcessContext, requested?: string): void {
    if (requested === undefined) {
      context.filename = this.defaultFilename(context);
      context.filenameManaged = true;
      return;
    }
    context.filename = normalizeBpmnFilename(requested);
    context.filenameManaged = false;
  }

  getProcess(processId: string): ProcessContext {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }
    return process;
  }

  async listDiagrams(): Promise<DiagramListing[]>;
  async listDiagrams(options: DiagramListingOptions): Promise<DiagramListingPage>;
  async listDiagrams(
    options?: DiagramListingOptions
  ): Promise<DiagramListing[] | DiagramListingPage> {
    if (options && (!Number.isSafeInteger(options.limit)
      || options.limit <= 0
      || !Number.isSafeInteger(options.offset)
      || options.offset < 0)) {
      throw new Error('Invalid diagram listing pagination');
    }

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
      filenames.sort(compareStableText);
      const selectedFilenames = options
        ? filenames.slice(options.offset, options.offset + options.limit)
        : filenames;
      const diagrams: DiagramListing[] = [];
      let metadataBytesRead = 0;
      for (const filename of selectedFilenames) {
        const encodedMetadata = this.metadataFromDefaultFilename(filename);
        const match = filename.match(/^(.+?)_(.+)\.bpmn$/);
        let processId = encodedMetadata?.processId
          ?? (match ? match[1] : filename.replace('.bpmn', ''));
        let name = encodedMetadata?.name
          ?? (match ? match[2].replace(/_/g, ' ') : filename.replace('.bpmn', ''));
        if (!encodedMetadata) {
          const remainingMetadataBytes = this.resourceLimits.maxListingMetadataBytes
            - metadataBytesRead;
          if (remainingMetadataBytes <= 0) {
            throw this.metadataListingLimitError();
          }
          const readLimit = Math.min(this.importLimits.maxBytes, remainingMetadataBytes);
          try {
            const xml = await this.fileManager.readBpmnFile(filename, readLimit);
            metadataBytesRead += Buffer.byteLength(xml, 'utf8');
            const context = await this.serializer.parse(xml, this.importLimits);
            processId = context.id;
            name = context.name;
          } catch (error) {
            if (error instanceof BpmnFileTooLargeError
              && readLimit < this.importLimits.maxBytes) {
              throw this.metadataListingLimitError();
            }
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
      if (!options) return diagrams;
      return {
        count: filenames.length,
        hasMore: options.offset + diagrams.length < filenames.length,
        diagrams
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return options ? { count: 0, hasMore: false, diagrams: [] } : [];
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
    context.persistedXml = xml;
    context.mutationVersion = 0;
    context.revision = this.revisionFor(xml, 0);
    this.processes.set(context.id, context);
    return context;
  }

  /**
   * Stop retaining a context after all operations already queued for it have
   * settled. The identity check prevents releasing a newer context that reused
   * the same BPMN process ID.
   */
  async releaseProcess(context: ProcessContext): Promise<void> {
    await this.withProcessLock(context.id, async () => {
      if (this.processes.get(context.id) === context) {
        this.processes.delete(context.id);
      }
    });
  }

  async readMermaidFile(filename: string, maxBytes: number): Promise<string> {
    return this.fileManager.readMermaidFile(filename, maxBytes);
  }

  async saveRenderedArtifact(
    content: string | Buffer,
    filename: string,
    format: RenderedArtifactFormat,
    overwrite: boolean,
    maxBytes: number
  ): Promise<SaveResult> {
    return this.fileManager.saveRenderedArtifact(
      content,
      filename,
      format,
      overwrite,
      maxBytes
    );
  }

  async deleteDiagram(filename: string): Promise<void> {
    const processIds = Array.from(this.processes.values())
      .filter(context => context.filename === filename)
      .map(context => context.id);
    await this.withProcessLocks(processIds, async () => {
      try {
        await this.fileManager.deleteBpmnFile(filename);
      } catch {
        throw new Error('Unable to delete BPMN file');
      }
      for (const [processId, context] of this.processes) {
        if (context.filename === filename) {
          this.processes.delete(processId);
        }
      }
    });
  }

  getDiagramsPath(): string {
    return this.diagramsPath;
  }

  selectDiagramsPath(diagramsPath: string): void {
    if (this.processLocks.size > 0 || this.processes.size > 0) {
      throw new Error('Close the active diagram before selecting another workspace');
    }
    this.diagramsPath = diagramsPath;
    this.fileManager = new FileManager(diagramsPath);
  }

  /**
   * Rank the diagram with the external layout engine and adopt the result.
   *
   * `orientation` reflects a left-to-right ranking into a top-to-bottom one and
   * `options.spacing` stretches the gaps the ranking left between ranks; the
   * layout engine has no options of its own, so both are applied to its output.
   * A layout that reproduces the geometry already on disk is not committed at
   * all, so a second `auto_layout` call neither bumps the revision nor rewrites
   * the file.
   */
  async applyAutoLayout(
    processId: string,
    expectedRevision?: string,
    orientation: LayoutOrientation = 'left-to-right',
    options: AutoLayoutOptions = {}
  ): Promise<AutoLayoutResult> {
    const spacing = options.spacing ?? DEFAULT_LAYOUT_SPACING;
    assertLayoutSpacing(spacing);
    const pinnedElementIds = options.pinnedElementIds ?? [];
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
      const preview = this.cloneDocument(context.document);
      applyCollaborationLayoutPolicy(this.cloneDocument(context.document), preview);
      if (orientation === 'top-to-bottom') transposeDocumentGeometry(preview);
      applyLayoutSpacing(preview, spacing);
      if (pinnedElementIds.length > 0) {
        applyPinnedElements(context.document, preview, pinnedElementIds);
      }
      if (sameDocumentGeometry(context.document, preview)) {
        return { xml: context.xml!, warnings: [], changed: false };
      }
      await this.commitMutation(context, working => {
        const requested = this.cloneDocument(working.document);
        applyCollaborationLayoutPolicy(requested, working.document);
        if (orientation === 'top-to-bottom') {
          transposeDocumentGeometry(working.document);
          this.repositionBoundaryEvents(working);
        }
        applyLayoutSpacing(working.document, spacing);
        if (pinnedElementIds.length > 0) {
          applyPinnedElements(requested, working.document, pinnedElementIds);
        }
      }, undefined, true, false, expectedRevision);
      return { xml: context.xml!, warnings: [], changed: true };
    }
    const result = await this.layoutAdapter.layout(snapshot.xml);
    const laidOut = await this.parseLayoutXml(result.xml);
    applyCollaborationLayoutPolicy(snapshot.document, laidOut.document);
    if (orientation === 'top-to-bottom') {
      transposeDocumentGeometry(laidOut.document);
      // Reflection moves a boundary event to the reflected point on its host's
      // outline, which is no longer on the outline once the host keeps its own
      // proportions. Re-attach before the geometry is compared or committed.
      this.repositionBoundaryEvents(laidOut);
    }
    // The gaps come last: they are stretched around whatever the ranking, the
    // collaboration policy and the reflection settled on.
    applyLayoutSpacing(laidOut.document, spacing);
    // Pinning is last: it puts hand-placed bounds back and repairs the ranked
    // result around them, so it has to see the geometry everything else agreed.
    if (pinnedElementIds.length > 0) {
      applyPinnedElements(snapshot.document, laidOut.document, pinnedElementIds);
    }

    const current = this.getProcess(processId);
    if (sameDocumentGeometry(current.document, laidOut.document)) {
      return { ...result, changed: false };
    }
    await this.adoptLayoutDocument(processId, laidOut, expectedRevision);
    return { ...result, changed: true };
  }

  getLayoutModel(
    processId: string,
    direction: LayoutDirection = 'left-to-right'
  ): LayoutModel {
    return BpmnDocumentLayoutAdapter.fromContext(this.getProcess(processId), direction);
  }

  async applyLayoutModel(
    processId: string,
    layout: LayoutModel,
    expectedRevision?: string
  ): Promise<void> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, working => {
      BpmnDocumentLayoutAdapter.applyToContext(layout, working);
      this.repositionBoundaryEvents(working);
    }, undefined, true, false, expectedRevision);
  }

  /**
   * Atomically adopt XML returned by a successful external layout adapter.
   * Adapter warnings are handled before this boundary; this method accepts
   * only XML whose semantics still match the active mutable document.
   */
  async applyLayoutXml(
    processId: string,
    xml: string,
    requestedLayout?: BpmnDocument,
    expectedRevision?: string
  ): Promise<void> {
    const laidOut = await this.parseLayoutXml(xml);
    if (requestedLayout) {
      applyCollaborationLayoutPolicy(requestedLayout, laidOut.document);
    }
    await this.adoptLayoutDocument(processId, laidOut, expectedRevision);
  }

  /** Parse adapter output under the same limits that guard ordinary imports. */
  private async parseLayoutXml(xml: string): Promise<ProcessContext> {
    if (typeof xml !== 'string') {
      throw new Error('Layout XML must be text');
    }
    if (Buffer.byteLength(xml, 'utf8') > this.importLimits.maxBytes) {
      throw new Error('Layout XML exceeds the configured byte limit');
    }
    try {
      return await this.serializer.parse(xml, this.importLimits);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse layout XML: ${message}`);
    }
  }

  /** Swap a parsed layout in for the live document under one commit. */
  private async adoptLayoutDocument(
    processId: string,
    laidOut: ProcessContext,
    expectedRevision?: string
  ): Promise<void> {
    const context = this.getProcess(processId);
    await this.commitMutation(context, working => {
      // The adapter's plane never carries boundary events in a lane, while the
      // live document does (mcp-bpmn-3g8.17). Reconcile before the guard, which
      // compares lane membership and rightly forbids layout from changing it.
      this.synchronizeBoundaryEventLanes(laidOut);
      this.assertLayoutSemanticsUnchanged(working.document, laidOut.document);
      // A layout engine only renders what it ranks. Anything it left without a
      // BPMNEdge - an association anchored on a boundary event, for one - is
      // taken back from the document being replaced instead of disappearing
      // with its plane (mcp-bpmn-3g8.15).
      restoreDroppedLayoutEdges(working.document, laidOut.document);
      working.document = laidOut.document;
      working.elements = laidOut.document.elements;
      working.connections = laidOut.document.connections;
    }, undefined, true, false, expectedRevision);
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
  /**
   * Working copies of diagrams currently inside a batch, keyed by process id.
   *
   * While a batch is open, nested mutations join it instead of taking the
   * process lock and writing on their own. That is what makes a multi-element
   * build one transaction: one lock, one serialization, one file write, and no
   * partially built diagram left behind if a later step fails.
   */
  private readonly activeBatches = new Map<string, ProcessContext>();

  /**
   * Run several mutations as one transaction.
   *
   * The body may call the ordinary mutation methods on this engine; each will
   * detect the open batch and apply itself to the shared working copy. Nothing
   * is persisted until the body returns, and a throw anywhere inside leaves the
   * diagram exactly as it was.
   */
  private async runBatch<T>(
    context: ProcessContext,
    body: () => Promise<T>,
    expectedRevision?: string
  ): Promise<T> {
    if (this.activeBatches.has(context.id)) {
      throw new Error(`A batch is already open for process ${context.id}`);
    }
    return this.commitMutation(context, async working => {
      this.activeBatches.set(context.id, working);
      try {
        return await body();
      } finally {
        this.activeBatches.delete(context.id);
      }
    }, undefined, true, false, expectedRevision);
  }

  private async commitMutation<T>(
    context: ProcessContext,
    mutation: (working: ProcessContext) => T | Promise<T>,
    filename?: string,
    overwrite = true,
    allowUnregistered = false,
    expectedRevision?: string,
    dryRun = false,
    /**
     * Write over an existing file that is not this diagram's current one. Used
     * only by save_as, where replacing the target is the caller's explicit
     * request rather than a compare-and-set rewrite of the active file.
     */
    replaceTarget = false,
    /**
     * Treat a mutation whose serialized result is byte-identical to the
     * persisted document as a no-op: keep the in-memory working state, but
     * neither rewrite the file nor advance the revision. A request that changes
     * nothing should not invalidate every revision token the agent is holding.
     */
    skipUnchangedWrite = false
  ): Promise<T> {
    const batch = this.activeBatches.get(context.id);
    if (batch) {
      // Join the enclosing transaction. Persistence arguments belong to the
      // outer commit; a nested optimistic guard would compare against a
      // revision that cannot change mid-batch, so it is rejected rather than
      // silently ignored.
      if (expectedRevision !== undefined && expectedRevision !== context.revision) {
        throw new DocumentRevisionConflictError(
          context.filename ?? '',
          expectedRevision,
          context.revision || undefined,
          'revision_mismatch'
        );
      }
      if (dryRun) throw new Error('Dry-run mutations cannot run inside a batch');
      return await mutation(batch);
    }
    return this.withProcessLock(context.id, async () => {
      if (!allowUnregistered && this.processes.get(context.id) !== context) {
        throw new Error(`Process ${context.id} not found`);
      }
      const targetFilename = filename || context.filename;
      if (!targetFilename) {
        throw new Error(`Process ${context.id} has no active filename`);
      }
      let expectedContent: string | null = null;
      if (overwrite) {
        if (context.persistedXml === undefined || context.filename !== targetFilename) {
          throw new Error(`Process ${context.id} has no persistence baseline for ${targetFilename}`);
        }
        expectedContent = context.persistedXml;
      }
      if (expectedRevision !== undefined && expectedRevision !== context.revision) {
        if (!overwrite) {
          throw new DocumentRevisionConflictError(
            targetFilename,
            expectedRevision,
            context.revision || undefined,
            'revision_mismatch'
          );
        }
        const disk = await this.readDiskRevision(targetFilename, context.mutationVersion);
        if (disk.revision !== expectedRevision || disk.content === undefined) {
          throw new DocumentRevisionConflictError(
            targetFilename,
            expectedRevision,
            disk.revision ?? (context.revision || undefined),
            'revision_mismatch'
          );
        }
        // Supplying the revision reported for the current disk bytes explicitly
        // acknowledges that version and rebases this one commit onto it.
        expectedContent = disk.content;
      }
      if (overwrite && expectedContent === context.persistedXml) {
        const disk = await this.readDiskRevision(targetFilename, context.mutationVersion);
        if (disk.content !== expectedContent) {
          throw new DocumentRevisionConflictError(
            targetFilename,
            expectedRevision ?? (context.revision || undefined),
            disk.revision,
            'external_change'
          );
        }
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
        persistedXml: context.persistedXml,
        mutationVersion: context.mutationVersion,
        revision: context.revision,
      };

      const value = await mutation(working);
      this.synchronizeBoundaryEventLanes(working);
      const xml = await this.serializer.serialize(working.document);
      if (dryRun) return value;
      // Only when this commit is not rebasing onto a different disk version:
      // there, the bytes have to be written even though this document is
      // unchanged.
      if (skipUnchangedWrite
        && xml === context.persistedXml
        && expectedContent === context.persistedXml) {
        context.document = working.document;
        context.elements = working.elements;
        context.connections = working.connections;
        return value;
      }
      const saveResult = await this.fileManager.saveBpmnFile(xml, {
        filename: targetFilename,
        overwrite: overwrite || replaceTarget,
        ...(overwrite ? { expectedContent } : {})
      });
      if (!saveResult.success) {
        if (saveResult.conflict) {
          const disk = await this.readDiskRevision(targetFilename, context.mutationVersion);
          throw new DocumentRevisionConflictError(
            targetFilename,
            expectedRevision ?? (context.revision || undefined),
            disk.revision,
            overwrite ? 'external_change' : 'target_exists'
          );
        }
        throw new Error(saveResult.error || 'Unable to save BPMN file');
      }
      const nextVersion = context.mutationVersion + 1;
      context.document = working.document;
      context.extensionProfile = working.document.extensionProfile;
      context.elements = working.elements;
      context.connections = working.connections;
      context.xml = xml;
      context.filename = working.filename;
      context.persistedXml = xml;
      context.mutationVersion = nextVersion;
      context.revision = this.revisionFor(xml, nextVersion);
      return value;
    });
  }

  private revisionFor(content: string, mutationVersion: number): string {
    return `${REVISION_DIGEST_PREFIX}${revisionDigest(content)}:v${mutationVersion}`;
  }

  private async readDiskRevision(
    filename: string,
    mutationVersion: number
  ): Promise<{ content?: string; revision?: string }> {
    try {
      const content = await this.fileManager.readBpmnFile(filename, this.importLimits.maxBytes);
      return { content, revision: this.revisionFor(content, mutationVersion) };
    } catch {
      return {};
    }
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

  private async withProcessLocks<T>(
    processIds: string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const uniqueIds = Array.from(new Set(processIds)).sort();
    const acquire = (index: number): Promise<T> => index === uniqueIds.length
      ? operation()
      : this.withProcessLock(uniqueIds[index], () => acquire(index + 1));
    return acquire(0);
  }

  private shapeForElement(document: BpmnDocument, elementId: string): BpmnShapeModel | undefined {
    const matches = Array.from(document.diagram.shapes.values()).filter(
      shape => shape.elementId === elementId
    );
    if (matches.length > 1) {
      throw new Error(`Rendered element ${elementId} has multiple BPMNShapes`);
    }
    return matches[0];
  }

  private edgeForConnection(
    document: BpmnDocument,
    connectionId: string
  ): BpmnEdgeModel | undefined {
    const matches = Array.from(document.diagram.edges.values()).filter(
      edge => edge.connectionId === connectionId
    );
    if (matches.length > 1) {
      throw new Error(`Rendered connection ${connectionId} has multiple BPMNEdges`);
    }
    return matches[0];
  }

  private elementGeometryState(
    elementId: string,
    shape: BpmnShapeModel
  ): ElementGeometryState {
    return {
      elementId,
      shapeId: shape.id,
      bounds: { ...shape.bounds },
      ...(shape.labelBounds ? { labelBounds: { ...shape.labelBounds } } : {})
    };
  }

  private connectionGeometryState(
    connectionId: string,
    edge: BpmnEdgeModel
  ): ConnectionGeometryState {
    return {
      connectionId,
      edgeId: edge.id,
      waypoints: edge.waypoints.map(point => ({ ...point })),
      ...(edge.labelBounds ? { labelBounds: { ...edge.labelBounds } } : {}),
      geometryRevision: connectionGeometryRevision(connectionId, edge)
    };
  }

  private assertGeometryBounds(bounds: Position & Size, field: string): void {
    const values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (!values.every(Number.isFinite)
      || bounds.x < TOOL_INPUT_LIMITS.coordinate.min
      || bounds.y < TOOL_INPUT_LIMITS.coordinate.min
      || bounds.x > TOOL_INPUT_LIMITS.coordinate.max
      || bounds.y > TOOL_INPUT_LIMITS.coordinate.max
      || bounds.width < TOOL_INPUT_LIMITS.dimension.min
      || bounds.height < TOOL_INPUT_LIMITS.dimension.min
      || bounds.width > TOOL_INPUT_LIMITS.dimension.max
      || bounds.height > TOOL_INPUT_LIMITS.dimension.max) {
      throw new Error(`${field} must contain bounded finite coordinates and positive dimensions`);
    }
  }

  private assertGeometryWaypoints(waypoints: Position[], field: string): void {
    if (waypoints.length < 2 || waypoints.length > 256) {
      throw new Error(`${field} must contain between 2 and 256 waypoints`);
    }
    if (!waypoints.every(point => Number.isFinite(point.x)
      && Number.isFinite(point.y)
      && point.x >= TOOL_INPUT_LIMITS.coordinate.min
      && point.y >= TOOL_INPUT_LIMITS.coordinate.min
      && point.x <= TOOL_INPUT_LIMITS.coordinate.max
      && point.y <= TOOL_INPUT_LIMITS.coordinate.max)) {
      throw new Error(`${field} must contain bounded finite coordinates`);
    }
  }

  private geometryBoundsEqual(left: Position & Size, right: Position & Size): boolean {
    return left.x === right.x
      && left.y === right.y
      && left.width === right.width
      && left.height === right.height;
  }

  private optionalGeometryBoundsEqual(
    expected: (Position & Size) | null | undefined,
    actual: (Position & Size) | undefined
  ): boolean {
    if (expected == null || actual === undefined) {
      return expected == null && actual === undefined;
    }
    return this.geometryBoundsEqual(expected, actual);
  }

  private geometryWaypointsEqual(left: Position[], right: Position[]): boolean {
    return left.length === right.length
      && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
  }

  private snapIncidentConnection(
    document: BpmnDocument,
    connection: BpmnDocumentConnection,
    elementId: string,
    bounds: Position & Size
  ): void {
    const source = document.elements.get(connection.source);
    const target = document.elements.get(connection.target);
    if (!source || !target) {
      throw new Error(`Connection ${connection.id} references a missing source or target`);
    }
    const waypoints = connection.waypoints.length >= 2
      ? connection.waypoints.map(point => ({ ...point }))
      : calculateConnectionWaypoints(source, target);
    if (connection.source === elementId) {
      waypoints[0] = this.pointOnBounds(bounds, waypoints[1]);
    }
    if (connection.target === elementId) {
      waypoints[waypoints.length - 1] = this.pointOnBounds(
        bounds,
        waypoints[waypoints.length - 2]
      );
    }
    connection.waypoints = waypoints;
    const edge = Array.from(document.diagram.edges.values()).find(
      candidate => candidate.connectionId === connection.id
    );
    if (edge) edge.waypoints = waypoints.map(point => ({ ...point }));
  }

  private pointOnBounds(bounds: Position & Size, toward: Position): Position {
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2
    };
    const deltaX = toward.x - center.x;
    const deltaY = toward.y - center.y;
    if (deltaX === 0 && deltaY === 0) {
      return { x: bounds.x + bounds.width, y: center.y };
    }
    const horizontalScale = deltaX === 0
      ? Number.POSITIVE_INFINITY
      : (bounds.width / 2) / Math.abs(deltaX);
    const verticalScale = deltaY === 0
      ? Number.POSITIVE_INFINITY
      : (bounds.height / 2) / Math.abs(deltaY);
    const scale = Math.min(horizontalScale, verticalScale);
    return {
      x: center.x + deltaX * scale,
      y: center.y + deltaY * scale
    };
  }

  private assertSafeElementGeometry(
    elementId: string,
    before: GeometryDiagnostic[],
    after: GeometryDiagnostic[],
    collisionPolicy: ElementGeometryUpdate['collisionPolicy']
  ): void {
    const invariantCodes = new Set([
      'NON_FINITE_GEOMETRY',
      'INVALID_BOUNDS',
      'CONTAINMENT_FAILURE',
      'ENDPOINT_GAP'
    ]);
    const invariantFailure = after.find(
      item => item.code === 'RESOURCE_LIMIT_EXCEEDED'
        || (invariantCodes.has(item.code) && item.ids.includes(elementId))
    );
    if (invariantFailure) {
      throw new Error(`Unsafe geometry for ${elementId}: ${invariantFailure.message}`);
    }

    if (collisionPolicy === 'allow') return;
    const collisionCodes = new Set([
      'SHAPE_OVERLAP',
      'LABEL_OVERLAP',
      'EDGE_SHAPE_COLLISION',
      'EDGE_EDGE_CROSSING',
      'MINIMUM_CLEARANCE'
    ]);
    const key = (item: GeometryDiagnostic): string => `${item.code}\0${item.ids.join('\0')}`;
    const existing = new Set(before.filter(item => collisionCodes.has(item.code)).map(key));
    const introduced = after.find(
      item => collisionCodes.has(item.code) && !existing.has(key(item))
    );
    if (introduced) {
      throw new Error(`Geometry collision rejected for ${elementId}: ${introduced.message}`);
    }
  }

  private assertSafeConnectionGeometry(
    connectionId: string,
    before: GeometryDiagnostic[],
    after: GeometryDiagnostic[],
    collisionPolicy: ConnectionGeometryUpdate['collisionPolicy'],
    allowExistingMissingDi = false
  ): GeometryDiagnostic[] {
    const introduced = this.introducedGeometryDiagnostics(before, after);
    const key = (item: GeometryDiagnostic): string =>
      `${item.code}\0${item.severity}\0${item.ids.join('\0')}`;
    const existing = new Set(before.map(key));
    const invariantCodes = new Set([
      'INVALID_XML',
      'MISSING_DI',
      'MISSING_EDGE',
      'NON_FINITE_GEOMETRY',
      'INSUFFICIENT_WAYPOINTS',
      'ENDPOINT_GAP',
      'UNKNOWN_CONNECTION_ID'
    ]);
    const resourceFailure = after.find(item =>
      item.code === 'RESOURCE_LIMIT_EXCEEDED' || item.code === 'DIAGNOSTICS_TRUNCATED'
    );
    if (resourceFailure) {
      throw new Error(
        `Connection geometry resource limit exceeded for ${connectionId}: ${resourceFailure.message}`
      );
    }
    const invariantFailure = after.find(item => invariantCodes.has(item.code)
      && (item.ids.length === 0 || item.ids.includes(connectionId))
      && !(allowExistingMissingDi
        && item.code === 'MISSING_DI'
        && existing.has(key(item))));
    if (invariantFailure) {
      throw new Error(`Unsafe geometry for ${connectionId}: ${invariantFailure.message}`);
    }

    if (collisionPolicy === 'reject-new') {
      const introducedError = introduced.find(item => item.severity === 'error');
      if (introducedError) {
        throw new Error(
          `Geometry collision rejected for ${connectionId}: ${introducedError.message}`
        );
      }
    }
    return introduced;
  }

  private introducedGeometryDiagnostics(
    before: GeometryDiagnostic[],
    after: GeometryDiagnostic[]
  ): GeometryDiagnostic[] {
    const key = (item: GeometryDiagnostic): string =>
      `${item.code}\0${item.severity}\0${item.ids.join('\0')}`;
    const existing = new Set(before.map(key));
    return after.filter(item => !existing.has(key(item)));
  }

  private assertSafeGeometryPatch(
    before: GeometryDiagnostic[],
    after: GeometryDiagnostic[],
    collisionPolicy: GeometryPatchUpdate['collisionPolicy']
  ): GeometryDiagnostic[] {
    const key = (item: GeometryDiagnostic): string =>
      `${item.code}\0${item.severity}\0${item.ids.join('\0')}`;
    const existing = new Set(before.map(key));
    const introduced = after.filter(item => !existing.has(key(item)));
    const invariantCodes = new Set([
      'INVALID_XML',
      'MISSING_DI',
      'MISSING_SHAPE',
      'MISSING_EDGE',
      'NON_FINITE_GEOMETRY',
      'INVALID_BOUNDS',
      'INSUFFICIENT_WAYPOINTS',
      'ENDPOINT_GAP',
      'CONTAINMENT_FAILURE',
      'UNKNOWN_ELEMENT_ID',
      'UNKNOWN_CONNECTION_ID'
    ]);
    const resourceFailure = after.find(item =>
      item.code === 'RESOURCE_LIMIT_EXCEEDED' || item.code === 'DIAGNOSTICS_TRUNCATED'
    );
    if (resourceFailure) {
      throw new Error(`Geometry patch resource limit exceeded: ${resourceFailure.message}`);
    }
    const invariantFailure = introduced.find(item => invariantCodes.has(item.code));
    if (invariantFailure) {
      throw new Error(`Unsafe geometry patch: ${invariantFailure.message}`);
    }
    if (collisionPolicy === 'reject-new') {
      const introducedError = introduced.find(item => item.severity === 'error');
      if (introducedError) {
        throw new Error(`Geometry patch rejected: ${introducedError.message}`);
      }
    }
    return introduced;
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
          const minimumX = children.reduce(
            (minimum, child) => Math.min(minimum, child.position.x),
            Infinity
          );
          const minimumY = children.reduce(
            (minimum, child) => Math.min(minimum, child.position.y),
            Infinity
          );
          const maximumX = children.reduce(
            (maximum, child) => Math.max(maximum, child.position.x + child.size.width),
            -Infinity
          );
          const maximumY = children.reduce(
            (maximum, child) => Math.max(maximum, child.position.y + child.size.height),
            -Infinity
          );
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

  /**
   * Put every boundary event in the lane of the activity it is attached to.
   *
   * A boundary event is drawn on its host's outline, so if the host sits in a
   * lane band the event overlaps that band no matter where a layout puts it.
   * The geometry oracle derives a shape's ancestry from lane flowNodeRef, so
   * without this the overlap reads as an error that no layout can clear
   * (mcp-bpmn-3g8.17). bpmn-js records the same membership on save.
   */
  private synchronizeBoundaryEventLanes(context: ProcessContext): void {
    const lanes = Array.from(context.document.lanes.values());
    if (lanes.length === 0) return;

    const laneByMember = new Map<string, BpmnLane>();
    for (const lane of lanes) {
      for (const memberId of lane.flowNodeRefs) laneByMember.set(memberId, lane);
    }

    for (const element of context.elements.values()) {
      if (element.type !== 'bpmn:BoundaryEvent') continue;
      const hostId = element.properties.attachTo;
      if (typeof hostId !== 'string') continue;
      const hostLane = laneByMember.get(hostId);
      const currentLane = laneByMember.get(element.id);
      if (currentLane === hostLane) continue;
      if (currentLane) {
        currentLane.flowNodeRefs = currentLane.flowNodeRefs.filter(id => id !== element.id);
      }
      if (hostLane) {
        hostLane.flowNodeRefs = [...hostLane.flowNodeRefs, element.id];
        laneByMember.set(element.id, hostLane);
      } else {
        laneByMember.delete(element.id);
      }
    }
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
    const laneHeights = lanes.map(lane => lane.flowNodeRefs.reduce(
      (height, id) => Math.max(height, (context.elements.get(id)?.size.height || 0) + 40),
      100
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
    const storageId = IdGenerator.generateUuid();
    const metadata = Buffer.from(
      JSON.stringify([process.id, process.name, storageId]),
      'utf8'
    ).toString('base64url');
    const encodedFilename = `mcp-bpmn-v1_${metadata}.bpmn`;
    // Leave room for FileManager's atomic-write suffix in the same 255-byte
    // filesystem component.
    return Buffer.byteLength(encodedFilename, 'utf8') <= 200
      ? encodedFilename
      : `${process.id}_${this.sanitizeFilename(process.name)}_${storageId}.bpmn`;
  }

  private metadataFromDefaultFilename(
    filename: string
  ): { processId: string; name: string } | undefined {
    const match = filename.match(/^mcp-bpmn-v1_([A-Za-z0-9_-]+)\.bpmn$/);
    if (!match) return undefined;
    try {
      const metadata: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (!Array.isArray(metadata)
        || (metadata.length !== 2 && metadata.length !== 3)
        || typeof metadata[0] !== 'string'
        || metadata[0].length === 0
        || typeof metadata[1] !== 'string'
        || (metadata.length === 3
          && (typeof metadata[2] !== 'string' || metadata[2].length === 0))) {
        return undefined;
      }
      return { processId: metadata[0], name: metadata[1] };
    } catch {
      return undefined;
    }
  }

  private metadataListingLimitError(): Error {
    return new Error(
      `Diagram listing rejected: metadata byte limit ${this.resourceLimits.maxListingMetadataBytes} exceeded`
    );
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

  /**
   * Compare the BPMN semantics a layout pass must leave untouched. Layout
   * runs by serializing, laying out, and re-parsing, so this comparison has to
   * ignore differences that the round trip itself introduces rather than
   * differences the layout engine caused.
   */
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
          properties: comparableElementProperties(element),
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
    const before = normalize(snapshot(current));
    const after = normalize(snapshot(candidate));
    if (!isDeepStrictEqual(before, after)) {
      const difference = describeSemanticDifference(before, after);
      throw new Error(
        `Layout output changed BPMN semantics${difference ? ` at ${difference}` : ''}`
      );
    }
  }

  /**
   * Turn an import failure into something an agent can act on.
   *
   * Structural problems this code base detects itself name BPMN ids the agent
   * already works with, so they are forwarded verbatim: telling someone their
   * well-formed file is "malformed" when the real problem is one bad reference
   * leaves them no way forward. Only XML-level parser failures, whose messages
   * can quote document content, are replaced with a generic one.
   */
  private safeImportError(error: unknown): Error {
    const message = error instanceof Error ? error.message : '';
    const identifierError = message.match(/(?:Invalid|Duplicate) BPMN xsd:ID at [\s\S]+$/u);
    if (identifierError) return new Error(identifierError[0]);
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
    if (error instanceof BpmnXmlParseError || message.length === 0) {
      return new Error('Failed to parse BPMN XML: malformed or invalid input');
    }
    return new Error(`BPMN import rejected: ${message}`);
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
      throw new Error(
        `Missing BPMN process owner: ${ownerId}. ${ownerHint(document, ownerId)}`
      );
    }
    if (scopeId === ownerId) {
      return;
    }
    const scope = document.elements.get(scopeId);
    if (!scope || !['bpmn:SubProcess', 'bpmn:Transaction'].includes(scope.type)
      || scope.ownerId !== ownerId) {
      throw new Error(
        `Invalid BPMN scope: ${scopeId}. ${scopeHint(document, ownerId, scopeId, scope)}`
      );
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
      // Authored through add_activity/update_element and read back from
      // imported documents.
      'multiInstance', 'triggeredByEvent', 'documentation', 'isForCompensation'
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

    // Both flags name a BPMN construct rather than a decoration, so they are
    // rejected on an element type that cannot carry the construct.
    if (Object.prototype.hasOwnProperty.call(properties, 'triggeredByEvent')
      && properties.triggeredByEvent !== undefined) {
      if (typeof properties.triggeredByEvent !== 'boolean') {
        throw new Error('triggeredByEvent must be a boolean');
      }
      if (type !== 'bpmn:SubProcess') {
        throw new Error(
          'triggeredByEvent is only valid on bpmn:SubProcess, which is what an '
          + 'event subprocess is'
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(properties, 'isForCompensation')
      && properties.isForCompensation !== undefined) {
      if (typeof properties.isForCompensation !== 'boolean') {
        throw new Error('isForCompensation must be a boolean');
      }
      if (!isActivityType(type)) {
        throw new Error('isForCompensation is only valid on an activity');
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
        || properties.candidateGroups.length > TOOL_INPUT_LIMITS.candidateGroups.maxItems
        || properties.candidateGroups.some(group => typeof group !== 'string'
          || group.trim().length === 0 || group.includes(',')))) {
      throw new Error(
        `candidateGroups must contain 1-${TOOL_INPUT_LIMITS.candidateGroups.maxItems} strings whose entries contain no commas`
      );
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

    if (properties.documentation !== undefined
      && (typeof properties.documentation !== 'string'
        || properties.documentation.trim().length === 0)) {
      throw new Error('documentation must be a non-empty string');
    }

    const hasCalledElement = Object.prototype.hasOwnProperty.call(properties, 'calledElement');
    if (hasCalledElement) {
      if (type !== 'bpmn:CallActivity') {
        throw new Error('calledElement is only valid on bpmn:CallActivity');
      }
      // A QName is the portable form. Camunda 7 additionally binds the
      // callable process late through an expression, so accept that only when
      // the document actually uses the camunda7 profile.
      const allowsExpression = context.extensionProfile === 'camunda7';
      if (!isBpmnQName(properties.calledElement)
        && !(allowsExpression && isBpmnExpression(properties.calledElement))) {
        throw new Error(allowsExpression
          ? 'calledElement must be a valid BPMN QName or a ${...} expression'
          : 'calledElement must be a valid BPMN QName; ${...} expressions require extensionProfile camunda7');
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
      if (type === 'bpmn:StartEvent' && scopeId !== ownerId
        && context.elements.get(scopeId)?.properties.triggeredByEvent !== true) {
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
    if (payload.definitionId === undefined) {
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
      if (payload.reference.id === undefined) {
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
    if (typeof payload.definitionId !== 'string') {
      throw new Error(`${definitionType} event definition requires a non-empty definitionId`);
    }
    this.assertBpmnIdentifier(
      payload.definitionId,
      'eventDefinitionPayload.definitionId'
    );

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
        || typeof payload.reference.id !== 'string') {
        throw new Error(`${definitionType} event definition requires a resolvable root reference`);
      }
      this.assertBpmnIdentifier(
        payload.reference.id,
        'eventDefinitionPayload.reference.id'
      );
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
    assertBpmnId(value, label);
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

  /**
   * A root id no diagram still held in memory is using. The counter restarts
   * for every new diagram, so the previous one — which lives on until its
   * handler releases it — would otherwise be overwritten in the process map.
   */
  private generateUniqueRootId(prefix: string): string {
    let id: string;
    do {
      id = IdGenerator.generate(prefix);
      assertBpmnId(id, `generated ${prefix}.id`);
    } while (this.processes.has(id));
    return id;
  }

  private generateUniqueId(document: BpmnDocument | undefined, prefix: string): string {
    let id: string;
    do {
      id = IdGenerator.generate(prefix);
      assertBpmnId(id, `generated ${prefix}.id`);
    } while (document && this.hasId(document, id));
    return id;
  }

  private hasId(document: BpmnDocument, id: string): boolean {
    if (document.sourceIds?.has(id) === true
      || document.definitionsId === id
      || document.processes.has(id)
      || document.collaborations.has(id)
      || document.laneSets.has(id)
      || document.lanes.has(id)
      || document.itemDefinitions.has(id)
      || document.dataObjects.has(id)
      || document.elements.has(id)
      || document.connections.has(id)
      || document.diagram.id === id
      || document.diagram.planeId === id
      || document.diagram.shapes.has(id)
      || document.diagram.edges.has(id)) {
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

export interface DiagramListing {
  filename: string;
  path: string;
  name: string;
  processId: string;
}

export interface DiagramListingOptions {
  limit: number;
  offset: number;
}

export interface DiagramListingPage {
  count: number;
  hasMore: boolean;
  diagrams: DiagramListing[];
}

/** Append the .bpmn extension when a caller-supplied name carries none. */
function normalizeBpmnFilename(filename: string): string {
  return extname(filename) === '' && !filename.toLowerCase().endsWith('.bpmn')
    ? `${filename}.bpmn`
    : filename;
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Explain a missing connection endpoint.
 *
 * A stale or mistyped id is the most common mistake at this boundary, and the
 * old message named neither which end was wrong nor the id itself, so the
 * caller had to bisect. When the id turns out to name a connection rather than
 * an element, say so: that is a different mistake with a different fix.
 */
function missingEndpointError(
  context: ProcessContext,
  side: 'Source' | 'Target',
  elementId: string
): Error {
  const connection = context.connections.get(elementId);
  if (connection) {
    return new Error(
      `${side} "${elementId}" is a ${connection.type}, not an element; `
      + 'connections cannot be endpoints of another connection'
    );
  }
  return new Error(`${side} element "${elementId}" not found`);
}

/** Event definitions that can hold an event-based gateway's decision open. */
const EVENT_BASED_GATEWAY_TARGET_DEFINITIONS = new Set([
  'message', 'timer', 'signal', 'conditional'
]);

/**
 * Whether an element can sit downstream of an event-based gateway. The gateway
 * defers its choice to whichever target occurs first, so every target has to be
 * something that waits for an event.
 */
function isEventBasedGatewayTarget(target: BpmnDocumentElement): boolean {
  if (target.type === 'bpmn:ReceiveTask') return true;
  if (target.type !== 'bpmn:IntermediateCatchEvent') return false;
  const definition = target.properties.eventDefinition;
  return typeof definition === 'string'
    && EVENT_BASED_GATEWAY_TARGET_DEFINITIONS.has(definition);
}

/** BPMN's default for bpmn:TextAnnotation textFormat (BPMN 2.0 §10.4.1). */
const DEFAULT_TEXT_ANNOTATION_FORMAT = 'text/plain';

/**
 * Element properties reduced to the parts a layout pass must preserve.
 *
 * Two kinds of noise are removed. Representation details that layout adapters
 * may legitimately rewrite (DI expansion state, the blackBox shorthand for an
 * absent participant processRef, data-object reference bookkeeping) are
 * dropped. Schema defaults that bpmn-moddle materializes on parse are applied
 * to both sides, so an annotation authored without an explicit textFormat
 * still compares equal to the same annotation read back carrying the BPMN
 * default. A genuinely different textFormat is still detected.
 */
function comparableElementProperties(element: BpmnDocumentElement): Record<string, unknown> {
  const properties: Record<string, unknown> = Object.fromEntries(
    Object.entries(element.properties).filter(([key]) => key !== 'isExpanded'
      && !(element.kind === 'participant' && key === 'blackBox')
      && !(element.type === 'bpmn:DataObjectReference'
        && (key === 'isCollection' || key === 'itemSubjectRef')))
  );
  if (element.type === 'bpmn:TextAnnotation' && properties.textFormat === undefined) {
    properties.textFormat = DEFAULT_TEXT_ANNOTATION_FORMAT;
  }
  return properties;
}

/**
 * Locate the first differing path between two JSON-normalized snapshots so a
 * layout rejection can name the element and field that changed instead of
 * failing opaquely. Returns undefined when the values are equal.
 */
function describeSemanticDifference(left: unknown, right: unknown, path = ''): string | undefined {
  if (isDeepStrictEqual(left, right)) return undefined;

  const describe = (value: unknown): string => {
    if (value === undefined) return 'absent';
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${path || 'snapshot'} (${left.length} entries before, ${right.length} after)`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const nested = describeSemanticDifference(left[index], right[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return path || 'snapshot';
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
  if (isPlainObject(left) && isPlainObject(right)) {
    // An id field identifies the owning object far better than an array index.
    const label = typeof left.id === 'string' ? `${path}(${left.id})` : path;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const nested = describeSemanticDifference(left[key], right[key], label ? `${label}.${key}` : key);
      if (nested) return nested;
    }
    return label || 'snapshot';
  }

  return `${path || 'snapshot'}: ${describe(left)} became ${describe(right)}`;
}

/**
 * Owner/scope rejections used to name only the id the caller passed, which is
 * exactly the id that was wrong. Pools, their processes, and subprocesses are
 * easy to confuse, so each hint says which id belongs in which argument.
 */
function ownerHint(document: BpmnDocument, ownerId: string): string {
  const element = document.elements.get(ownerId);
  if (element?.kind === 'participant') {
    return element.processRef
      ? `${ownerId} is a pool; pass its process id ${element.processRef} as ownerId.`
      : `${ownerId} is a black-box pool and has no process; give it a process, or pass `
        + 'the process id of a white-box pool as ownerId.';
  }
  if (element && ['bpmn:SubProcess', 'bpmn:Transaction'].includes(element.type)) {
    return `${ownerId} is a ${element.type}; pass ${element.ownerId} as ownerId and `
      + `${ownerId} as scopeId.`;
  }
  if (element) {
    return `${ownerId} is a ${element.type}, not a process; pass ${element.ownerId} as ownerId.`;
  }
  const known = Array.from(document.processes.keys()).sort();
  return `ownerId must be a process id${known.length > 0 ? `, one of: ${known.join(', ')}` : ''}. `
    + 'add_pool returns the processId of the pool it creates.';
}

function scopeHint(
  document: BpmnDocument,
  ownerId: string,
  scopeId: string,
  scope: BpmnDocumentElement | undefined
): string {
  if (!scope) {
    return document.processes.has(scopeId)
      ? `${scopeId} is a process; pass it as ownerId and omit scopeId.`
      : `No element ${scopeId} exists; scopeId names an expanded subprocess or transaction `
        + 'inside ownerId, and defaults to ownerId itself.';
  }
  if (scope.kind === 'participant') {
    return scope.processRef
      ? `${scopeId} is a pool; pass its process id ${scope.processRef} as ownerId and omit scopeId.`
      : `${scopeId} is a black-box pool and cannot contain elements.`;
  }
  if (!['bpmn:SubProcess', 'bpmn:Transaction'].includes(scope.type)) {
    return `${scopeId} is a ${scope.type}; only an expanded subprocess or transaction `
      + 'can be a scopeId.';
  }
  return `${scopeId} belongs to process ${scope.ownerId}, not ${ownerId}; pass `
    + `${scope.ownerId} as ownerId.`;
}

function poolHint(document: BpmnDocument, poolId: string): string {
  const owningParticipant = Array.from(document.elements.values()).find(
    element => element.kind === 'participant' && element.processRef === poolId
  );
  if (owningParticipant) {
    return `${poolId} is a process id; add_lane takes the pool elementId, which is `
      + `${owningParticipant.id}.`;
  }
  const element = document.elements.get(poolId);
  if (element) {
    return `${poolId} is a ${element.type}; add_lane takes a pool (bpmn:Participant) elementId.`;
  }
  const pools = Array.from(document.elements.values())
    .filter(candidate => candidate.kind === 'participant')
    .map(candidate => candidate.id)
    .sort();
  return pools.length > 0
    ? `add_lane takes a pool elementId, one of: ${pools.join(', ')}.`
    : 'This diagram has no pools; add one with add_pool first.';
}
