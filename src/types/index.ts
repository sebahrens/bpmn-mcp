export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export type BpmnExtensionProfile = 'portable' | 'camunda7';

export type SafeJsonPrimitive = string | number | boolean | null;
export type SafeJsonValue = SafeJsonPrimitive | SafeJsonObject | SafeJsonValue[];
export interface SafeJsonObject {
  [key: string]: SafeJsonValue;
}

export const BPMN_FLOW_NODE_TYPES = [
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
  'bpmn:CallActivity',
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway',
  'bpmn:ComplexGateway'
] as const;

export const BPMN_ARTIFACT_TYPES = [
  'bpmn:DataObjectReference',
  'bpmn:DataStoreReference',
  'bpmn:TextAnnotation',
  'bpmn:Group'
] as const;

export const BPMN_CONNECTION_TYPES = [
  'bpmn:SequenceFlow',
  'bpmn:MessageFlow',
  'bpmn:Association'
] as const;

export type BpmnFlowNodeType = typeof BPMN_FLOW_NODE_TYPES[number];
export type BpmnArtifactType = typeof BPMN_ARTIFACT_TYPES[number];
export type BpmnConnectionType = typeof BPMN_CONNECTION_TYPES[number];
export type BpmnElementType = BpmnFlowNodeType | BpmnArtifactType | 'bpmn:Participant';
export type AssociationDirection = 'None' | 'One' | 'Both';

export interface ElementDefinition {
  id?: string;
  type: BpmnElementType;
  name?: string;
  position?: Position;
  size?: Size;
  properties?: Record<string, unknown>;
  ownerId?: string;
  scopeId?: string;
}

/**
 * An expression authored for a multi-instance loop. The body and language are
 * opaque to this server; execution semantics belong to the consuming engine.
 */
export interface BpmnLoopExpression {
  body: string;
  language?: string;
}

/** Portable BPMN multi-instance loop characteristics. */
export interface BpmnMultiInstanceLoopCharacteristics {
  isSequential: boolean;
  loopCardinality?: BpmnLoopExpression;
  completionCondition?: BpmnLoopExpression;
  /** Existing ItemAwareElement used as the iteration collection/input. */
  loopDataInputRef?: string;
  /** Existing ItemAwareElement receiving the aggregate loop output. */
  loopDataOutputRef?: string;
}

interface BpmnElementBase {
  id: string;
  type: BpmnElementType;
  name?: string;
  ownerId: string;
  scopeId: string;
  position: Position;
  size: Size;
  properties: Record<string, unknown>;
}

export interface BpmnFlowNodeElement extends BpmnElementBase {
  kind: 'flowNode';
  type: BpmnFlowNodeType;
  /** Sequence flow owned by this activity/gateway as its BPMN default. */
  defaultFlow?: string;
  /** Whether the typed model owns (including explicitly clears) the default. */
  defaultFlowManaged?: boolean;
}

export interface BpmnArtifactElement extends BpmnElementBase {
  kind: 'artifact';
  type: BpmnArtifactType;
}

export interface BpmnParticipantElement extends BpmnElementBase {
  kind: 'participant';
  type: 'bpmn:Participant';
  processRef?: string;
}

export type BpmnDocumentElement = BpmnFlowNodeElement | BpmnArtifactElement | BpmnParticipantElement;

export interface BpmnConditionExpression {
  body: string;
  /** Moddle expression type; new conditions use bpmn:FormalExpression. */
  type: string;
  language?: string;
  evaluatesToTypeRef?: string;
}

export interface BpmnConnectOptions {
  condition?: string;
  conditionLanguage?: string;
  conditionType?: 'bpmn:FormalExpression';
  isDefault?: boolean;
  /** BPMN association arrow direction. Associations default to None. */
  associationDirection?: AssociationDirection;
}

export interface BpmnElementUpdate {
  name?: string;
  properties?: Record<string, unknown>;
  /** Outgoing sequence-flow ID, or null to clear source default ownership. */
  defaultFlow?: string | null;
}

export interface BpmnDocumentConnection {
  id: string;
  type: BpmnConnectionType;
  source: string;
  target: string;
  ownerId: string;
  scopeId: string;
  label?: string;
  condition?: BpmnConditionExpression;
  /** Present for bpmn:Association; BPMN's default is None. */
  associationDirection?: AssociationDirection;
  waypoints: Position[];
  properties: Record<string, unknown>;
}

export interface BpmnProcessRoot {
  id: string;
  name?: string;
  isExecutable?: boolean;
}

/** Non-rendered data definition referenced by a bpmn:DataObjectReference. */
export interface BpmnDataObject {
  id: string;
  name?: string;
  ownerId: string;
  scopeId: string;
  isCollection?: boolean;
  /** Local bpmn:ItemDefinition ID; null records an explicit update-time clear. */
  itemSubjectRef?: string | null;
}

export interface BpmnCollaborationRoot {
  id: string;
  name?: string;
}

export interface BpmnLaneSet {
  id: string;
  processId: string;
  /** Present for a nested lane set owned by this lane. */
  parentLaneId?: string;
  laneIds: string[];
}

export interface BpmnLane {
  id: string;
  name?: string;
  processId: string;
  laneSetId: string;
  flowNodeRefs: string[];
  position: Position;
  size: Size;
}

export interface BpmnShapeModel {
  id: string;
  elementId: string;
  bounds: Position & Size;
  /** Optional BPMNLabel bounds emitted by an external layout engine. */
  labelBounds?: Position & Size;
  isHorizontal?: boolean;
  /** Whether a subprocess or transaction is rendered with its contents visible. */
  isExpanded?: boolean;
}

export interface BpmnEdgeModel {
  id: string;
  connectionId: string;
  waypoints: Position[];
  /** Optional BPMNLabel bounds emitted by an external layout engine. */
  labelBounds?: Position & Size;
}

export interface BpmnDiagramModel {
  id: string;
  planeId: string;
  planeElementId: string;
  shapes: Map<string, BpmnShapeModel>;
  edges: Map<string, BpmnEdgeModel>;
}

export interface BpmnDocument {
  definitionsId: string;
  targetNamespace: string;
  extensionProfile: BpmnExtensionProfile;
  /** Canonical source for lossless edits of imported moddle content. */
  sourceXml?: string;
  /** All imported IDs, including constructs not exposed by the mutation API. */
  sourceIds?: Set<string>;
  /** IDs owned by the typed mutation API rather than retained opaquely. */
  managedIds?: Set<string>;
  processes: Map<string, BpmnProcessRoot>;
  collaborations: Map<string, BpmnCollaborationRoot>;
  laneSets: Map<string, BpmnLaneSet>;
  lanes: Map<string, BpmnLane>;
  /** Imported ItemDefinition IDs available to ItemAwareElement.itemSubjectRef. */
  itemDefinitions: Set<string>;
  dataObjects: Map<string, BpmnDataObject>;
  elements: Map<string, BpmnDocumentElement>;
  connections: Map<string, BpmnDocumentConnection>;
  diagram: BpmnDiagramModel;
}

export interface ProcessContext {
  id: string;
  name: string;
  type: 'process' | 'collaboration';
  extensionProfile: BpmnExtensionProfile;
  /** The sole file updated by autosave for this in-memory diagram. */
  filename?: string;
  document: BpmnDocument;
  elements: Map<string, BpmnDocumentElement>;
  connections: Map<string, BpmnDocumentConnection>;
  xml?: string;
}

export interface BpmnElement {
  id: string;
  type: string;
  businessObject: any;
  di?: any;
}

export interface Connection {
  id: string;
  source: string;
  target: string;
  type: BpmnConnectionType;
  waypoints?: Position[];
}

export type ValidationLevel = 'syntax' | 'semantic' | 'full';
export type ValidationSeverity = 'error' | 'warning';

export interface BpmnValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  elementId?: string;
}

export interface ValidationResult {
  level: ValidationLevel;
  valid: boolean;
  issues: BpmnValidationIssue[];
  errors: Array<BpmnValidationIssue & { severity: 'error' }>;
  warnings: Array<BpmnValidationIssue & { severity: 'warning' }>;
  summary: string;
}

export type ValidationError = BpmnValidationIssue & { severity: 'error' };
export type ValidationWarning = BpmnValidationIssue & { severity: 'warning' };

export type EventType = 'start' | 'end' | 'intermediate-throw' | 'intermediate-catch' | 'boundary';
export type EventDefinitionType = 'message' | 'timer' | 'error' | 'signal' | 'conditional' | 'escalation' | 'compensation' | 'cancel' | 'terminate';
export type EventTimerType = 'timeDate' | 'timeDuration' | 'timeCycle';

export interface EventDefinitionReference {
  /** Root-element ID. Generated when omitted for newly-created events. */
  id?: string;
  name?: string;
  /** errorCode for errors or escalationCode for escalations. */
  code?: string;
}

export interface EventExpressionPayload {
  expression: string;
  language?: string;
}

export interface EventTimerPayload extends EventExpressionPayload {
  type: EventTimerType;
}

export interface EventDefinitionPayload {
  /** Child event-definition ID. Generated when omitted. */
  definitionId?: string;
  /** Root message, signal, error, or escalation definition. */
  reference?: EventDefinitionReference;
  /** Required by timer event definitions. */
  timer?: EventTimerPayload;
  /** Required by conditional event definitions. */
  condition?: EventExpressionPayload;
  /** Optional activity targeted by a compensation throw. */
  activityRef?: string;
  /** Compensation throw behavior; defaults to true in BPMN. */
  waitForCompletion?: boolean;
}

export type ActivityType = 'task' | 'userTask' | 'serviceTask' | 'scriptTask' | 'businessRuleTask' | 'manualTask' | 'receiveTask' | 'sendTask' | 'subProcess' | 'transaction' | 'callActivity';
export type GatewayType = 'exclusive' | 'parallel' | 'inclusive' | 'eventBased' | 'complex';

export interface ExportOptions {
  format?: 'xml' | 'svg';
  formatted?: boolean;
  preamble?: boolean;
}

export type {
  LayoutBounds,
  LayoutContainer,
  LayoutContainerKind,
  LayoutDirection,
  LayoutEdge,
  LayoutEdgeSegment,
  LayoutEndpoint,
  LayoutLabel,
  LayoutLabelOwnerKind,
  LayoutModel,
  LayoutNode,
  LayoutPoint,
  LayoutPort,
  LayoutPortRole,
  LayoutPortSide,
  LayoutValidationResult,
  LayoutWarning,
  NormalizedLayoutModel
} from '../core/layout/LayoutModel.js';
