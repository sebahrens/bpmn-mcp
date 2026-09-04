import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { jsonDescription, zodToJsonSchema } from 'zod-to-json-schema';
import {
  MAX_INPUT_ARRAY_ITEMS,
  MAX_PNG_SCALE,
  TOOL_INPUT_LIMITS
} from '../config/index.js';
import {
  BPMN_ARTIFACT_TYPES,
  BPMN_FLOW_NODE_TYPES
} from '../types/index.js';
import { isBpmnId } from '../utils/BpmnId.js';

interface ToolDefinition {
  annotations: Required<Pick<
    ToolAnnotations,
    'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'
  >>;
  description: string;
  schema: z.ZodTypeAny;
  outputSchema: z.AnyZodObject;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;
const ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;
const IDEMPOTENT_UPDATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;
const DESTRUCTIVE_UPDATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const;
const DESTRUCTIVE_NON_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
} as const;

const strictEmptyObject = () => z.object({}).strict();

/**
 * Every BPMN type list_elements can return, so the filter is self-documenting
 * and a value the server cannot match is rejected instead of silently yielding
 * an empty page.
 */
const LISTABLE_ELEMENT_TYPES = [
  ...BPMN_FLOW_NODE_TYPES,
  ...BPMN_ARTIFACT_TYPES,
  'bpmn:Participant',
  'bpmn:Lane',
  'bpmn:Association'
] as const;
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/**
 * Request-boundary limits keep generated XML, diagnostics, and geometry math
 * within practical bounds. BPMN DI coordinates are decimal values, so finite
 * fractions are accepted; positions must be non-negative and dimensions must
 * be positive. One million diagram units is intentionally far beyond normal
 * canvas use while preventing extreme values from destabilizing renderers.
 * String limits bound untrusted allocation while leaving room for expressions
 * and other structured text that legitimately exceeds a display name.
 */
export { TOOL_INPUT_LIMITS };

const boundedTrimmedString = (limits: { minLength: number; maxLength: number }) =>
  z.string().trim().min(limits.minLength).max(limits.maxLength);
const name = () => boundedTrimmedString(TOOL_INPUT_LIMITS.name);
const label = () => boundedTrimmedString(TOOL_INPUT_LIMITS.label);
const filename = () => boundedTrimmedString(TOOL_INPUT_LIMITS.filename).refine(
  value => Buffer.byteLength(value, 'utf8') <= TOOL_INPUT_LIMITS.filename.maxUtf8Bytes,
  `Filename must not exceed ${TOOL_INPUT_LIMITS.filename.maxUtf8Bytes} UTF-8 bytes`
);
const artifactFilename = (extension: 'svg' | 'png') => filename().refine(
  value => value.toLowerCase().endsWith(`.${extension}`),
  `Filename must use the .${extension} extension`
);
const annotationText = () => z.string()
  .min(TOOL_INPUT_LIMITS.annotationText.minLength)
  .max(TOOL_INPUT_LIMITS.annotationText.maxLength)
  .refine(value => value.trim().length > 0, 'Annotation text must not be blank');
const expression = () => boundedTrimmedString(TOOL_INPUT_LIMITS.expression);
const language = () => boundedTrimmedString(TOOL_INPUT_LIMITS.language);
const opaqueExpressionBody = () => z.string()
  .min(1)
  .max(TOOL_INPUT_LIMITS.expression.maxLength)
  .refine(value => value.trim().length > 0, 'Expression body must not be blank');
const extensionProfile = z.enum(['portable', 'camunda7']);
const DOCUMENT_REVISION_FORMAT = 'Document revision must be a token returned by a prior '
  + 'result, of the form "sha256:<32 lowercase hex characters>:v<number>"';
const GEOMETRY_REVISION_FORMAT = 'Geometry revision must be a token returned by a prior '
  + 'result, of the form "sha256:<32 lowercase hex characters>"';
const SEMANTIC_REVISION_FORMAT = 'Semantic revision must be a token returned by a prior '
  + 'result, of the form "sha256:<32 lowercase hex characters>"';
const revision = z.string()
  .max(64)
  .regex(/^sha256:[a-f0-9]{32}:v\d+$/, DOCUMENT_REVISION_FORMAT)
  .describe('Opaque document revision token for optimistic concurrency');
const expectedRevisionField = {
  expectedRevision: revision.optional().describe(
    'Revision returned by a prior query or mutation; stale values produce a structured conflict'
  )
};
const extensionString = () => z.string()
  .min(1)
  .max(TOOL_INPUT_LIMITS.expression.maxLength)
  .refine(value => value.trim().length > 0, 'Value must not be blank');
const candidateGroups = () => z.array(
  extensionString().refine(value => !value.includes(','), 'Group names must not contain commas')
).min(TOOL_INPUT_LIMITS.candidateGroups.minItems)
  .max(TOOL_INPUT_LIMITS.candidateGroups.maxItems);
const paginationFields = {
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(`Maximum results to return (default ${DEFAULT_PAGE_LIMIT}, max ${MAX_PAGE_LIMIT})`),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe('Zero-based offset in the stable result order')
};
const withJsonSchemaMetadata = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  metadata: Record<string, unknown>
): Schema => schema.describe(JSON.stringify(metadata));

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find(value => seen.size === seen.add(value).size);
}

const position = z.object({
  x: z.number().finite()
    .min(TOOL_INPUT_LIMITS.coordinate.min)
    .max(TOOL_INPUT_LIMITS.coordinate.max),
  y: z.number().finite()
    .min(TOOL_INPUT_LIMITS.coordinate.min)
    .max(TOOL_INPUT_LIMITS.coordinate.max)
}).strict().describe(
  `Complete finite decimal coordinates from ${TOOL_INPUT_LIMITS.coordinate.min} to ${TOOL_INPUT_LIMITS.coordinate.max}; fractional values are allowed`
);
const size = z.object({
  width: z.number().finite()
    .min(TOOL_INPUT_LIMITS.dimension.min)
    .max(TOOL_INPUT_LIMITS.dimension.max),
  height: z.number().finite()
    .min(TOOL_INPUT_LIMITS.dimension.min)
    .max(TOOL_INPUT_LIMITS.dimension.max)
}).strict().describe(
  `Complete finite decimal dimensions from ${TOOL_INPUT_LIMITS.dimension.min} to ${TOOL_INPUT_LIMITS.dimension.max}; fractional values are allowed`
);
const geometryBounds = position.merge(size).describe(
  'Complete bounded BPMN DI bounds with finite coordinates and positive dimensions'
);
// Validated with a refinement rather than .regex() on purpose. The XML
// NCName production expands to a ~400 byte character-class regex, and
// emitting it as a JSON Schema `pattern` on every id-valued field made
// tools/list roughly a third larger than the tool surface it describes.
// The refinement enforces exactly the same rule at runtime while staying
// invisible to the advertised schema. Advertising a shortened ASCII pattern
// instead was rejected: it would wrongly reject the Unicode NCNames the
// server itself accepts.
const bpmnId = () => z.string()
  .min(TOOL_INPUT_LIMITS.identifier.minLength)
  .max(TOOL_INPUT_LIMITS.identifier.maxLength)
  .refine(isBpmnId, 'Invalid BPMN xsd:ID; expected an XML NCName');
const geometryPatchElementUpdate = z.object({
  elementId: bpmnId().describe('Semantic ID owning the BPMNShape to update'),
  bounds: geometryBounds.optional().describe('Replacement BPMNShape bounds'),
  labelBounds: geometryBounds.nullable().optional().describe(
    'Replacement BPMNLabel bounds; null removes them and omission preserves them'
  ),
  expectedBounds: geometryBounds.optional().describe(
    'Compare-and-set guard for the current BPMNShape bounds'
  ),
  expectedLabelBounds: geometryBounds.nullable().optional().describe(
    'Compare-and-set guard for current BPMNLabel bounds; null expects no bounds'
  )
}).strict().refine(
  update => update.bounds !== undefined
    || Object.prototype.hasOwnProperty.call(update, 'labelBounds'),
  { message: 'Each element update must replace bounds or labelBounds' }
);
const geometryPatchConnectionUpdate = z.object({
  connectionId: bpmnId().describe('Semantic ID owning the BPMNEdge to update'),
  waypoints: z.array(position).min(2).max(MAX_INPUT_ARRAY_ITEMS).optional().describe(
    'Complete replacement route containing 2 to 256 bounded finite BPMN DI waypoints'
  ),
  labelBounds: geometryBounds.nullable().optional().describe(
    'Replacement BPMNLabel bounds; null removes them and omission preserves them'
  ),
  expectedWaypoints: z.array(position).min(2).max(MAX_INPUT_ARRAY_ITEMS).optional().describe(
    'Optional additional compare-and-set guard for current BPMNEdge waypoints'
  ),
  expectedGeometryRevision: z.string()
    .regex(/^sha256:[a-f0-9]{32}$/, GEOMETRY_REVISION_FORMAT).optional().describe(
    'Compare-and-set guard for the complete current BPMNEdge geometry'
  ),
  endpointPolicy: z.enum(['exact', 'snap-to-boundary']).default('exact').describe(
    'Keep submitted endpoints exactly or snap them to final source and target bounds'
  )
}).strict().refine(
  update => update.waypoints !== undefined
    || Object.prototype.hasOwnProperty.call(update, 'labelBounds'),
  { message: 'Each connection update must replace waypoints or labelBounds' }
);
const loopExpression = z.object({
  body: opaqueExpressionBody().describe(
    'Opaque expression text preserved exactly; this server does not evaluate it'
  ),
  language: language().optional().describe(
    'Optional language URI or identifier understood by the consuming BPMN engine'
  )
}).strict();
const multiInstance = z.object({
  isSequential: z.boolean().describe(
    'false for parallel instances; true for sequential instances'
  ),
  loopCardinality: loopExpression.optional().describe(
    'Optional standard BPMN FormalExpression defining the number of instances'
  ),
  completionCondition: loopExpression.optional().describe(
    'Optional standard BPMN FormalExpression controlling early completion'
  ),
  loopDataInputRef: bpmnId().optional().describe(
    'ID of an existing BPMN ItemAwareElement used as the loop collection/input'
  ),
  loopDataOutputRef: bpmnId().optional().describe(
    'ID of an existing BPMN ItemAwareElement receiving the aggregate loop output'
  )
}).strict();
/**
 * Details an event definition needs beyond its type. Shared by add_event and
 * build_process: a timer or conditional definition is rejected without it, so a
 * tool that accepts `eventDefinition` must accept this too.
 */
const eventDefinitionPayload = z.object({
  definitionId: bpmnId().optional().describe(
    'Stable child event-definition ID (generated when omitted)'
  ),
  reference: z.object({
    id: bpmnId().optional(),
    name: name().optional(),
    code: expression().optional()
  }).strict().optional().describe(
    'Root message, signal, error, or escalation definition; id is generated when omitted'
  ),
  timer: z.object({
    type: z.enum(['timeDate', 'timeDuration', 'timeCycle']),
    expression: expression(),
    language: language().optional()
  }).strict().optional(),
  condition: z.object({
    expression: expression(),
    language: language().optional()
  }).strict().optional(),
  activityRef: bpmnId().optional().describe(
    'Activity targeted by a compensation throw'
  ),
  waitForCompletion: z.boolean().optional().describe('Compensation throw behavior')
}).strict().optional().describe(
  'Definition details. Timer requires timer; conditional requires condition. '
  + 'Message/signal/error/escalation roots are generated and may be named or '
  + 'assigned a stable ID here.'
);

const activityProperties = z.object({
  isExpanded: z.boolean().optional(),
  calledElement: extensionString().optional(),
  assignee: extensionString().optional(),
  candidateGroups: candidateGroups().optional(),
  dueDate: extensionString().optional(),
  multiInstance: multiInstance.optional(),
  isForCompensation: z.boolean().optional().describe(
    'Marks a compensation handler: the activity runs only when compensation is '
    + 'thrown, so it sits outside the normal flow and takes no sequence flows'
  ),
  triggeredByEvent: z.boolean().optional().describe(
    'Marks a subProcess as an event subprocess, triggered by its own start '
    + 'event rather than by an incoming sequence flow'
  )
}).strict();
const elementUpdateProperties = z.object({
  isExpanded: z.boolean().optional(),
  text: annotationText().optional().describe(
    'Replacement text for a bpmn:TextAnnotation, preserved exactly'
  ),
  textFormat: boundedTrimmedString(TOOL_INPUT_LIMITS.language).optional()
    .describe('Text media type for a bpmn:TextAnnotation; BPMN defaults to text/plain'),
  calledElement: extensionString().optional(),
  assignee: extensionString().nullable().optional(),
  candidateGroups: candidateGroups().nullable().optional(),
  dueDate: extensionString().nullable().optional(),
  multiInstance: multiInstance.optional(),
  isForCompensation: z.boolean().optional().describe(
    'Marks a compensation handler: the activity runs only when compensation is '
    + 'thrown, so it sits outside the normal flow and takes no sequence flows'
  ),
  triggeredByEvent: z.boolean().optional().describe(
    'Marks a subProcess as an event subprocess, triggered by its own start '
    + 'event rather than by an incoming sequence flow'
  ),
  isCollection: z.boolean().optional(),
  itemSubjectRef: bpmnId().nullable().optional()
}).strict();

/**
 * A caller-side handle for a node inside one build request. It never becomes a
 * BPMN id, so it is deliberately looser than an NCName; the server assigns the
 * real id and returns the mapping.
 */
const buildRef = () => z.string().trim().min(1).max(TOOL_INPUT_LIMITS.identifier.maxLength)
  .describe('Caller-chosen handle for this node, referenced by flows in the same request');

const buildOwnership = {
  ownerId: bpmnId().optional().describe('Owning process ID (required in a collaboration)'),
  scopeId: bpmnId().optional().describe('Containing process or subprocess ID (defaults to ownerId)'),
  position: position.optional().describe('Optional position; auto_layout replaces it')
};

const buildNode = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    ref: buildRef(),
    eventType: z.enum(['start', 'end', 'intermediate-throw', 'intermediate-catch', 'boundary']),
    name: name().optional(),
    eventDefinition: z.enum([
      'message', 'timer', 'error', 'signal', 'conditional',
      'escalation', 'compensation', 'cancel', 'terminate'
    ]).optional(),
    eventDefinitionPayload: eventDefinitionPayload,
    attachTo: bpmnId().optional().describe('Required activity ID for boundary events'),
    cancelActivity: z.boolean().optional(),
    ...buildOwnership
  }).strict(),
  z.object({
    kind: z.literal('activity'),
    ref: buildRef(),
    activityType: z.enum([
      'task', 'userTask', 'serviceTask', 'scriptTask', 'businessRuleTask',
      'manualTask', 'receiveTask', 'sendTask', 'subProcess', 'transaction', 'callActivity'
    ]),
    name: name(),
    properties: activityProperties.optional(),
    ...buildOwnership
  }).strict(),
  z.object({
    kind: z.literal('gateway'),
    ref: buildRef(),
    gatewayType: z.enum(['exclusive', 'parallel', 'inclusive', 'eventBased', 'complex']),
    name: name().optional(),
    ...buildOwnership
  }).strict()
]);

const buildFlow = z.object({
  source: buildRef().describe('A node ref from this request, or an existing element ID'),
  target: buildRef().describe('A node ref from this request, or an existing element ID'),
  label: label().optional(),
  condition: expression().optional().describe('Sequence-flow condition; excludes isDefault'),
  conditionLanguage: language().optional(),
  isDefault: z.boolean().optional().describe('Make this the source node default flow')
}).strict();

const outputFilename = z.string().min(1).describe('Active BPMN filename');
const outputBpmnId = z.string()
  .min(1)
  .refine(isBpmnId, 'Invalid BPMN xsd:ID; expected an XML NCName')
  .describe('Stable generated or existing BPMN ID');
const outputCount = z.number().int().min(0);
/**
 * Opening or creating a diagram replaces whatever was current. The replaced
 * diagram is reported here, and named in the result text, so an agent that had
 * unsaved work in it learns immediately instead of writing into the new one.
 */
const outputReplacedDiagram = z.object({
  name: z.string(),
  filename: outputFilename.optional()
}).strict();
const outputDiagram = z.object({
  processId: outputBpmnId,
  name: z.string(),
  type: z.enum(['process', 'collaboration']),
  extensionProfile,
  filename: outputFilename,
  replacedDiagram: outputReplacedDiagram.optional(),
  revision
}).strict();
const outputMutationRevisions = {
  beforeRevision: revision,
  afterRevision: revision
};
const outputPage = {
  count: outputCount,
  returnedCount: outputCount,
  offset: outputCount,
  limit: z.number().int().min(1),
  hasMore: z.boolean()
};
const outputPosition = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).strict();
const outputSize = z.object({
  width: z.number().finite(),
  height: z.number().finite()
}).strict();
const outputGeometryBounds = outputPosition.extend({
  width: z.number().finite(),
  height: z.number().finite()
}).strict();
const outputGeometryRevision = z.string()
  .regex(/^sha256:[a-f0-9]{32}$/, GEOMETRY_REVISION_FORMAT)
  .describe('Opaque revision of this connection BPMNEdge geometry');
const outputSemanticRevision = z.string()
  .regex(/^sha256:[a-f0-9]{32}$/, SEMANTIC_REVISION_FORMAT)
  .describe('Opaque revision of this connection semantic state');
const outputGeometryLabel = z.object({
  id: z.string().min(1),
  ownerId: outputBpmnId,
  planeId: z.string().min(1),
  bounds: outputGeometryBounds
}).strict();
const outputGeometryShape = z.object({
  id: outputBpmnId,
  diId: z.string().min(1),
  type: z.string().min(1),
  planeId: z.string().min(1),
  bounds: outputGeometryBounds,
  label: outputGeometryLabel.optional(),
  parentId: outputBpmnId.optional(),
  attachedToId: outputBpmnId.optional(),
  isExpanded: z.boolean().optional()
}).strict();
const outputElementGeometryState = z.object({
  elementId: outputBpmnId,
  shapeId: z.string().min(1),
  bounds: outputGeometryBounds,
  labelBounds: outputGeometryBounds.optional()
}).strict();
const outputConnectionGeometryState = z.object({
  connectionId: outputBpmnId,
  edgeId: z.string().min(1),
  waypoints: z.array(outputPosition).min(2).max(MAX_INPUT_ARRAY_ITEMS),
  labelBounds: outputGeometryBounds.optional(),
  geometryRevision: outputGeometryRevision
}).strict();
const outputGeometryEdge = z.object({
  id: outputBpmnId,
  diId: z.string().min(1),
  type: z.string().min(1),
  planeId: z.string().min(1),
  sourceId: outputBpmnId.optional(),
  targetId: outputBpmnId.optional(),
  waypoints: z.array(outputPosition),
  label: outputGeometryLabel.optional()
}).strict();
const outputGeometryDiagnostic = z.object({
  code: z.string().min(1),
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
  ids: z.array(z.string())
}).strict();
const outputGeometryDiagnosticSummary = z.object({
  total: outputCount,
  errors: outputCount,
  warnings: outputCount,
  byCode: z.record(outputCount)
}).strict();
const outputConnectionRouteScore = z.object({
  shapeCollisions: outputCount,
  labelCollisions: outputCount,
  clearanceFailures: outputCount,
  connectionCrossings: outputCount,
  bends: outputCount,
  length: z.number().finite().min(0),
  total: z.number().finite().min(0)
}).strict();
const outputRankedConnectionRoute = z.object({
  rank: z.number().int().positive(),
  // Omitted for the entry named by selectedRank: that route is reported once,
  // in proposedWaypoints, rather than three times in the same result.
  waypoints: z.array(outputPosition).min(2).max(MAX_INPUT_ARRAY_ITEMS).optional(),
  labelBounds: outputGeometryBounds.nullable(),
  scoreBreakdown: outputConnectionRouteScore,
  diagnostics: z.array(outputGeometryDiagnostic)
}).strict();
const outputQueryBase = z.object({
  id: outputBpmnId,
  type: z.string().min(1),
  name: z.string().optional(),
  // Required on every row: participants, lanes, flow nodes, artifacts and
  // associations are all listed together, and only the kind tells them apart
  // without a lookup table of BPMN type strings.
  kind: z.enum(['flowNode', 'artifact', 'participant', 'lane', 'association']),
  ownerId: outputBpmnId.optional(),
  scopeId: outputBpmnId.optional(),
  processRef: outputBpmnId.optional(),
  sourceId: outputBpmnId.optional(),
  targetId: outputBpmnId.optional(),
  associationDirection: z.enum(['None', 'One', 'Both']).optional(),
  position: outputPosition.optional(),
  size: outputSize.optional(),
  waypoints: z.array(outputPosition).optional(),
  defaultFlow: outputBpmnId.optional(),
  shapeId: z.string().min(1).optional(),
  bounds: outputGeometryBounds.optional(),
  labelBounds: outputGeometryBounds.optional()
}).strict();
const outputListElement = outputQueryBase.extend({
  incoming: outputCount.optional(),
  outgoing: outputCount.optional()
}).strict();
const outputElementDetails = outputQueryBase.extend({
  incoming: z.array(z.object({ id: outputBpmnId, source: outputBpmnId }).strict()).optional(),
  outgoing: z.array(z.object({
      id: outputBpmnId,
      type: z.string().min(1),
      target: outputBpmnId,
      label: z.string().optional(),
      condition: z.object({
        body: z.string(),
        language: z.string().optional(),
        type: z.string().optional(),
        evaluatesToTypeRef: outputBpmnId.optional()
      }).strict().optional(),
      isDefault: z.boolean()
    }).strict()).optional(),
  properties: z.record(z.unknown()).optional()
}).strict();
const outputConnectionCondition = z.object({
  body: z.string(),
  type: z.string().min(1),
  language: z.string().optional(),
  evaluatesToTypeRef: outputBpmnId.optional()
}).strict();
const outputConnectionSemanticState = z.object({
  connectionId: outputBpmnId,
  type: z.enum(['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association']),
  ownerId: outputBpmnId,
  scopeId: outputBpmnId,
  sourceId: outputBpmnId,
  targetId: outputBpmnId,
  label: z.string().optional(),
  condition: outputConnectionCondition.optional(),
  isDefault: z.boolean(),
  defaultOwnerId: outputBpmnId.optional(),
  associationDirection: z.enum(['None', 'One', 'Both']).optional(),
  semanticRevision: outputSemanticRevision
}).strict();
const outputConnection = z.object({
  id: outputBpmnId,
  type: z.enum(['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association']),
  ownerId: outputBpmnId,
  scopeId: outputBpmnId,
  sourceId: outputBpmnId,
  targetId: outputBpmnId,
  label: z.string().optional(),
  condition: outputConnectionCondition.optional(),
  isDefault: z.boolean(),
  defaultOwnerId: outputBpmnId.optional(),
  associationDirection: z.enum(['None', 'One', 'Both']).optional(),
  waypoints: z.array(outputPosition),
  edgeId: z.string().min(1).optional(),
  labelBounds: outputGeometryBounds.optional(),
  geometryRevision: outputGeometryRevision,
  semanticRevision: outputSemanticRevision
}).strict();
const outputValidationIssue = z.object({
  code: z.string().min(1),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  elementId: z.string().optional()
}).strict();
const outputLayoutWarning = z.object({
  code: z.string().min(1),
  message: z.string(),
  elementId: z.string().optional(),
  relatedElementIds: z.array(z.string()).optional()
}).strict();

const outputSchemas = {
  new_bpmn: outputDiagram,
  new_from_mermaid: outputDiagram.extend({
    nodeCount: outputCount,
    flowCount: outputCount,
    warnings: z.array(z.string())
  }).strict(),
  preview_mermaid: z.object({
    processName: z.string(),
    nodeCount: outputCount,
    flowCount: outputCount,
    nodes: z.array(z.object({
      mermaidId: z.string().min(1),
      elementId: outputBpmnId,
      type: z.string().min(1),
      name: z.string().optional(),
      eventDefinition: z.string().min(1).optional(),
      ownerId: outputBpmnId
    }).strict()).max(MAX_INPUT_ARRAY_ITEMS),
    flows: z.array(z.object({
      connectionId: outputBpmnId,
      type: z.enum(['bpmn:SequenceFlow', 'bpmn:MessageFlow']),
      sourceId: outputBpmnId,
      targetId: outputBpmnId,
      label: z.string().optional()
    }).strict()).max(MAX_INPUT_ARRAY_ITEMS),
    pools: z.array(z.object({
      elementId: outputBpmnId,
      name: z.string()
    }).strict()).max(MAX_INPUT_ARRAY_ITEMS),
    warnings: z.array(z.string())
  }).strict(),
  open_bpmn: outputDiagram.extend({
    elementCount: outputCount,
    connectionCount: outputCount,
    laneCount: outputCount
  }).strict(),
  open_mermaid_file: outputDiagram.extend({
    sourceFilename: z.string().min(1),
    nodeCount: outputCount,
    flowCount: outputCount,
    warnings: z.array(z.string())
  }).strict(),
  save: z.object({
    processId: outputBpmnId,
    name: z.string(),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  save_as: z.object({
    processId: outputBpmnId,
    name: z.string(),
    filename: outputFilename,
    previousFilename: outputFilename.optional()
      .describe('Prior filename; a server-generated placeholder is removed, a chosen name is kept'),
    removedPreviousFile: z.boolean()
      .describe('Whether the prior file was a placeholder this call deleted'),
    ...outputMutationRevisions
  }).strict(),
  close: z.object({
    processId: outputBpmnId,
    name: z.string(),
    filename: outputFilename,
    revision
  }).strict(),
  current: z.object({
    current: z.boolean(),
    diagram: outputDiagram.extend({
      elementCount: outputCount,
      connectionCount: outputCount
    }).strict().optional()
  }).strict(),
  add_event: z.object({
    elementId: outputBpmnId,
    elementType: z.string().min(1),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_activity: z.object({
    elementId: outputBpmnId,
    elementType: z.string().min(1),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_gateway: z.object({
    elementId: outputBpmnId,
    elementType: z.string().min(1),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_data_object: z.object({
    referenceId: outputBpmnId,
    dataObjectId: outputBpmnId,
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_text_annotation: z.object({
    annotationId: outputBpmnId,
    associationId: outputBpmnId.optional(),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  connect: z.object({
    connectionId: outputBpmnId,
    connectionType: z.string().min(1),
    sourceId: outputBpmnId,
    targetId: outputBpmnId,
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_association: z.object({
    associationId: outputBpmnId,
    sourceId: outputBpmnId,
    targetId: outputBpmnId,
    associationDirection: z.enum(['None', 'One', 'Both']),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_pool: z.object({
    elementId: outputBpmnId,
    processId: outputBpmnId.optional(),
    blackBox: z.boolean(),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  add_lane: z.object({
    laneId: outputBpmnId,
    poolId: outputBpmnId,
    created: z.boolean(),
    assignedFlowNodeCount: outputCount,
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  list_elements: z.object({
    ...outputPage,
    elements: z.array(outputListElement),
    revision
  }).strict(),
  get_element: outputElementDetails.extend({ revision }).strict(),
  list_connections: z.object({
    ...outputPage,
    connections: z.array(outputConnection),
    revision
  }).strict(),
  get_connection: outputConnection.extend({ revision }).strict(),
  update_element: z.object({
    elementId: outputBpmnId,
    changed: z.boolean()
      .describe('False when the requested values already matched; the revision then stands'),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  update_connection: z.object({
    connectionId: outputBpmnId,
    before: outputConnectionSemanticState,
    after: outputConnectionSemanticState,
    diagnostics: z.array(outputGeometryDiagnostic),
    introducedDiagnostics: z.array(outputGeometryDiagnostic),
    endpointPolicy: z.literal('snap-to-boundary').optional(),
    collisionPolicy: z.enum(['reject-new', 'warn', 'allow']),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  update_element_geometry: z.object({
    elementId: outputBpmnId,
    before: outputElementGeometryState,
    after: outputElementGeometryState,
    diagnostics: z.array(outputGeometryDiagnostic),
    dryRun: z.boolean(),
    applied: z.boolean(),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  update_connection_geometry: z.object({
    connectionId: outputBpmnId,
    before: outputConnectionGeometryState,
    after: outputConnectionGeometryState,
    diagnostics: z.array(outputGeometryDiagnostic),
    introducedDiagnostics: z.array(outputGeometryDiagnostic),
    endpointPolicy: z.enum(['exact', 'snap-to-boundary']),
    collisionPolicy: z.enum(['reject-new', 'warn', 'allow']),
    dryRun: z.boolean(),
    applied: z.boolean(),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  apply_geometry_patch: z.object({
    elements: z.array(z.object({
      elementId: outputBpmnId,
      before: outputElementGeometryState,
      after: outputElementGeometryState
    }).strict()).max(MAX_INPUT_ARRAY_ITEMS),
    connections: z.array(z.object({
      connectionId: outputBpmnId,
      before: outputConnectionGeometryState,
      after: outputConnectionGeometryState,
      endpointPolicy: z.enum(['exact', 'snap-to-boundary'])
    }).strict()).max(MAX_INPUT_ARRAY_ITEMS),
    diagnostics: z.array(outputGeometryDiagnostic),
    introducedDiagnostics: z.array(outputGeometryDiagnostic),
    summary: outputGeometryDiagnosticSummary,
    collisionPolicy: z.enum(['reject-new', 'warn', 'allow']),
    dryRun: z.boolean(),
    applied: z.boolean(),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  route_connection: z.object({
    connectionId: outputBpmnId,
    proposedWaypoints: z.array(outputPosition).min(2).max(MAX_INPUT_ARRAY_ITEMS),
    proposedLabelBounds: outputGeometryBounds.nullable(),
    geometryRevision: outputGeometryRevision,
    scoreBreakdown: outputConnectionRouteScore,
    diagnostics: z.array(outputGeometryDiagnostic),
    introducedDiagnostics: z.array(outputGeometryDiagnostic),
    rankedDiagnostics: z.array(outputRankedConnectionRoute).max(MAX_INPUT_ARRAY_ITEMS),
    selectedRank: z.number().int().positive().optional()
      .describe('Rank of the proposed route; that entry omits its waypoints, which are '
        + 'reported once in proposedWaypoints'),
    geometryPatch: z.object({
      elementUpdates: z.array(z.unknown()).max(0),
      connectionUpdates: z.array(z.object({
        connectionId: outputBpmnId,
        waypoints: z.array(outputPosition).min(2).max(MAX_INPUT_ARRAY_ITEMS),
        labelBounds: outputGeometryBounds.optional(),
        expectedGeometryRevision: outputGeometryRevision,
        endpointPolicy: z.literal('exact')
      }).strict()).length(1),
      expectedRevision: revision,
      collisionPolicy: z.literal('reject-new'),
      dryRun: z.literal(false)
    }).strict(),
    clearance: z.number().finite().min(0),
    preserveOtherGeometry: z.literal(true),
    apply: z.boolean(),
    applied: z.boolean(),
    filename: outputFilename,
    revision,
    ...outputMutationRevisions
  }).strict(),
  build_process: z.object({
    elements: z.array(z.object({
      ref: z.string(),
      elementId: outputBpmnId,
      type: z.string()
    }).strict()),
    connections: z.array(z.object({
      connectionId: outputBpmnId,
      type: z.string(),
      sourceId: outputBpmnId,
      targetId: outputBpmnId
    }).strict()),
    elementCount: outputCount,
    connectionCount: outputCount,
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  delete_element: z.object({
    elementId: outputBpmnId,
    deletedKind: z.enum(['element', 'connection']),
    removedConnectionCount: outputCount,
    removedElementCount: outputCount,
    removedElementIds: z.array(outputBpmnId),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  export: z.object({
    processId: outputBpmnId,
    filename: outputFilename,
    format: z.enum(['xml', 'svg']),
    mimeType: z.enum(['application/xml', 'image/svg+xml']),
    byteLength: outputCount,
    uri: z.string().optional()
  }).strict(),
  save_svg: z.object({
    processId: outputBpmnId,
    filename: outputFilename,
    format: z.literal('svg'),
    mimeType: z.literal('image/svg+xml'),
    byteLength: outputCount
  }).strict(),
  save_png: z.object({
    processId: outputBpmnId,
    filename: outputFilename,
    format: z.literal('png'),
    mimeType: z.literal('image/png'),
    byteLength: outputCount,
    width: outputCount,
    height: outputCount,
    scale: z.number().finite().positive(),
    downscaled: z.boolean()
  }).strict(),
  validate: z.object({
    level: z.enum(['syntax', 'semantic', 'full']),
    valid: z.boolean(),
    // One list, not three: errors and warnings were the severity partition of
    // issues, and every issue carries its own severity.
    issues: z.array(outputValidationIssue),
    summary: z.string(),
    filename: outputFilename
  }).strict(),
  analyze_geometry: z.object({
    valid: z.boolean(),
    diagnostics: z.array(outputGeometryDiagnostic),
    summary: outputGeometryDiagnosticSummary,
    scope: z.object({
      elementIds: z.array(outputBpmnId),
      connectionIds: z.array(outputBpmnId),
      clearance: z.number().finite().min(0),
      tolerance: z.number().finite().positive(),
      requireOrthogonal: z.boolean()
    }).strict(),
    geometry: z.object({
      shapes: z.array(outputGeometryShape),
      edges: z.array(outputGeometryEdge),
      labels: z.array(outputGeometryLabel)
    }).strict().optional(),
    filename: outputFilename,
    revision
  }).strict(),
  auto_layout: z.object({
    algorithm: z.literal('horizontal'),
    direction: z.enum(['left-to-right', 'top-to-bottom']),
    spacing: z.number().finite().positive(),
    pinnedElementIds: z.array(outputBpmnId),
    changed: z.boolean(),
    elementCount: outputCount,
    connectionCount: outputCount,
    warnings: z.array(outputLayoutWarning),
    filename: outputFilename,
    ...outputMutationRevisions
  }).strict(),
  list_diagrams: z.object({
    ...outputPage,
    diagrams: z.array(z.object({
      filename: z.string().min(1),
      path: z.string().min(1),
      name: z.string(),
      processId: z.string()
    }).strict()),
    path: z.string().min(1)
  }).strict(),
  delete_diagram_file: z.object({
    filename: z.string().min(1),
    closedCurrent: z.boolean()
  }).strict(),
  get_diagrams_path: z.object({
    path: z.string().min(1)
  }).strict(),
  get_workspace: z.object({
    launchCwd: z.string().min(1),
    startupBoundary: z.string().min(1),
    workspace: z.string().min(1),
    source: z.enum(['environment', 'repository_config', 'launch_cwd', 'selection']),
    configPath: z.string().min(1).optional(),
    startupFailure: z.string().min(1).optional()
  }).strict(),
  select_workspace: z.object({
    launchCwd: z.string().min(1),
    startupBoundary: z.string().min(1),
    workspace: z.string().min(1),
    source: z.literal('selection'),
    configPath: z.string().min(1).optional(),
    changed: z.boolean()
  }).strict()
} as const;

/**
 * The single source of truth for tool advertisement, runtime validation, and
 * tool argument types. All object schemas are strict at the request boundary.
 */
export const toolDefinitions = {
  new_bpmn: {
    annotations: ADDITIVE,
    description: 'Create a new BPMN diagram and set it as current context, replacing and closing whatever diagram was current (unsaved changes in it are discarded)',
    outputSchema: outputSchemas.new_bpmn,
    schema: z.object({
      name: name().describe('Name of the diagram'),
      filename: filename().optional().describe(
        'Filename for the new diagram. When omitted the server generates a placeholder '
        + 'name, which save_as later replaces rather than leaving a duplicate behind.'
      ),
      type: z.enum(['process', 'collaboration'])
        .default('process')
        .describe('Type of diagram to create'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile; portable emits no vendor attributes')
    }).strict()
  },
  new_from_mermaid: {
    annotations: ADDITIVE,
    description: 'Create a new BPMN diagram from Mermaid code and set it as current context, replacing and closing whatever diagram was current (unsaved changes in it are discarded)',
    outputSchema: outputSchemas.new_from_mermaid,
    schema: z.object({
      name: name().describe('Name for the new diagram'),
      filename: filename().optional().describe(
        'Filename for the new diagram. When omitted the server generates a placeholder '
        + 'name, which save_as later replaces rather than leaving a duplicate behind.'
      ),
      mermaidCode: boundedTrimmedString(TOOL_INPUT_LIMITS.mermaidCode)
        .describe('Mermaid flowchart code to convert'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile for the authored document')
    }).strict()
  },
  preview_mermaid: {
    annotations: READ_ONLY,
    description: 'Dry-run a Mermaid flowchart: convert it in memory and report the BPMN type '
      + 'chosen for every node, the sequence/message classification of every edge, the pools, '
      + 'and any diagnostics, without creating a diagram, writing a file, or replacing the '
      + 'current context. Run it before new_from_mermaid to check the mapping. Supported '
      + 'subset: "flowchart"/"graph" with direction TD, TB, LR, RL or BT; ID[Label] becomes '
      + 'bpmn:Task; ID{Label} becomes bpmn:ExclusiveGateway; ID[/Label/] becomes '
      + 'bpmn:SubProcess; ID[[Label]] becomes bpmn:DataObjectReference; ID((Label)) becomes an '
      + 'event, resolved to bpmn:StartEvent when it has no incoming edge, bpmn:EndEvent when '
      + 'it has no outgoing edge, and bpmn:IntermediateThrowEvent otherwise; a node labelled '
      + 'start/begin or end/stop/finish becomes that event whatever its shape; -->, -.-> and '
      + 'labelled edges become sequence flows, and an edge crossing subgraphs becomes a '
      + 'message flow; each subgraph becomes a pool. Any other shape is reported as a '
      + 'diagnostic instead of being guessed. A :::class suffix on a node refines what its '
      + 'shape decided, matched ignoring case, - and _: on ID[Label], :::user, :::service, '
      + ':::script, :::businessRule, :::manual, :::receive or :::send selects that typed '
      + 'task; on ID{Label}, :::parallel, :::inclusive, :::eventBased or :::complex selects '
      + 'that gateway; on ID((Label)), :::message, :::timer, :::error, :::signal, '
      + ':::conditional, :::escalation, :::compensation, :::cancel or :::terminate adds that '
      + 'event definition, and an intermediate event carrying one becomes '
      + 'bpmn:IntermediateCatchEvent where BPMN allows the definition to be caught. :::task '
      + 'and :::exclusive name the defaults. A class BPMN does not allow on that node is '
      + 'reported as INVALID_NODE_SUBTYPE naming the legal placements; an unrecognized class '
      + 'is ignored with a warning, and classDef/class statements remain styling that steers '
      + 'nothing. Boundary attachment, event-definition payloads (timer expressions, message '
      + 'names), conditions, default flows, lanes and black-box pools still have no Mermaid '
      + 'form: import first, then use add_event, add_activity, add_gateway and update_element.',
    outputSchema: outputSchemas.preview_mermaid,
    schema: z.object({
      mermaidCode: boundedTrimmedString(TOOL_INPUT_LIMITS.mermaidCode)
        .describe('Mermaid flowchart code to classify')
    }).strict()
  },
  open_bpmn: {
    annotations: IDEMPOTENT_UPDATE,
    description: 'Open an existing BPMN file and set it as current context, replacing and closing whatever diagram was current (unsaved changes in it are discarded). elementCount counts flow nodes and pools; lanes are reported separately and associations count as connections, so list_elements returns a larger total',
    outputSchema: outputSchemas.open_bpmn,
    schema: z.object({
      filename: filename().describe('Filename of the BPMN diagram to open')
    }).strict()
  },
  open_mermaid_file: {
    annotations: ADDITIVE,
    description: 'Open a Mermaid file, convert it to BPMN, and set as current context, replacing and closing whatever diagram was current (unsaved changes in it are discarded)',
    outputSchema: outputSchemas.open_mermaid_file,
    schema: z.object({
      filename: filename().describe('Filename of the Mermaid file to open and convert'),
      bpmnFilename: filename().optional().describe(
        'Filename for the converted BPMN diagram. When omitted the server generates a '
        + 'placeholder name, which save_as later replaces rather than leaving a duplicate behind.'
      ),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile for the authored document')
    }).strict()
  },
  save: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Save the current diagram to its file (error if no filename set)',
    outputSchema: outputSchemas.save,
    schema: z.object({ ...expectedRevisionField }).strict()
  },
  save_as: {
    annotations: IDEMPOTENT_UPDATE,
    description: 'Save the current diagram with a new filename',
    outputSchema: outputSchemas.save_as,
    schema: z.object({
      filename: filename().describe('New filename for the diagram'),
      overwrite: z.boolean().default(false).describe(
        'Replace an existing file with this filename instead of failing'
      ),
      ...expectedRevisionField
    }).strict()
  },
  close: {
    annotations: IDEMPOTENT_UPDATE,
    description: 'Close the current diagram and clear the context',
    outputSchema: outputSchemas.close,
    schema: strictEmptyObject()
  },
  current: {
    annotations: READ_ONLY,
    description: 'Get information about the current diagram',
    outputSchema: outputSchemas.current,
    schema: strictEmptyObject()
  },
  add_event: {
    annotations: ADDITIVE,
    description: 'Add an event to the current diagram',
    outputSchema: outputSchemas.add_event,
    schema: z.object({
  documentation: boundedTrimmedString(TOOL_INPUT_LIMITS.annotationText).optional().describe(
    'Free-text bpmn:documentation for this element, preserved in the BPMN file'
  ),
      eventType: z.enum([
        'start',
        'end',
        'intermediate-throw',
        'intermediate-catch',
        'boundary'
      ]).describe('Type of event to add'),
      name: name().optional().describe('Name of the event'),
      eventDefinition: z.enum([
        'message',
        'timer',
        'error',
        'signal',
        'conditional',
        'escalation',
        'compensation',
        'cancel',
        'terminate'
      ]).optional().describe(
        'Event definition type. The event kind/type combination must be BPMN-legal.'
      ),
      eventDefinitionPayload: eventDefinitionPayload,
      cancelActivity: z.boolean().optional().describe(
        'Whether a boundary event interrupts its attached activity; compensation boundaries must be false'
      ),
      position: position.optional().describe('Position of the event (optional)'),
      attachTo: bpmnId().optional().describe(
        'Required activity ID for boundary events; invalid on other events. Cancel boundaries require a transaction.'
      ),
      ownerId: bpmnId().optional().describe(
        'Owning process ID (required when adding to a collaboration)'
      ),
      scopeId: bpmnId().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      ),
      ...expectedRevisionField
    }).strict()
  },
  add_activity: {
    annotations: ADDITIVE,
    description: 'Add an activity to the current diagram',
    outputSchema: outputSchemas.add_activity,
    schema: z.object({
  documentation: boundedTrimmedString(TOOL_INPUT_LIMITS.annotationText).optional().describe(
    'Free-text bpmn:documentation for this element, preserved in the BPMN file'
  ),
      activityType: z.enum([
        'task',
        'userTask',
        'serviceTask',
        'scriptTask',
        'businessRuleTask',
        'manualTask',
        'receiveTask',
        'sendTask',
        'subProcess',
        'transaction',
        'callActivity'
      ]).describe('Type of activity'),
      name: name().describe('Name of the activity'),
      position: position.optional().describe('Position of the activity (optional)'),
      properties: activityProperties.optional().describe(
        'Typed activity properties. multiInstance is portable BPMN and its expression bodies are opaque text; assignee, candidateGroups, and dueDate are Camunda 7 user-task fields and require extensionProfile camunda7. Arbitrary qualified names and raw XML are rejected.'
      ),
      ownerId: bpmnId().optional().describe(
        'Owning process ID (required when adding to a collaboration)'
      ),
      scopeId: bpmnId().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      ),
      ...expectedRevisionField
    }).strict()
  },
  add_gateway: {
    annotations: ADDITIVE,
    description: 'Add a gateway to the current diagram',
    outputSchema: outputSchemas.add_gateway,
    schema: z.object({
  documentation: boundedTrimmedString(TOOL_INPUT_LIMITS.annotationText).optional().describe(
    'Free-text bpmn:documentation for this element, preserved in the BPMN file'
  ),
      gatewayType: z.enum([
        'exclusive',
        'parallel',
        'inclusive',
        'eventBased',
        'complex'
      ]).describe('Type of gateway'),
      name: name().optional().describe('Name of the gateway (optional)'),
      position: position.optional().describe('Position of the gateway (optional)'),
      ownerId: bpmnId().optional().describe(
        'Owning process ID (required when adding to a collaboration)'
      ),
      scopeId: bpmnId().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      ),
      ...expectedRevisionField
    }).strict()
  },
  add_data_object: {
    annotations: ADDITIVE,
    description: 'Add a BPMN data object reference and its non-rendered backing data object',
    outputSchema: outputSchemas.add_data_object,
    schema: z.object({
      name: name().describe('Name of the data object and its visible reference'),
      position: position.optional().describe('Position of the visible data object reference'),
      isCollection: z.boolean().default(false).describe(
        'Whether the backing bpmn:DataObject represents a collection'
      ),
      itemSubjectRef: bpmnId().optional().describe(
        'ID of an existing bpmn:ItemDefinition referenced by the backing data object'
      ),
      ownerId: bpmnId().optional().describe(
        'Owning process ID (required when adding to a collaboration with multiple pools)'
      ),
      scopeId: bpmnId().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      ),
      ...expectedRevisionField
    }).strict()
  },
  add_text_annotation: {
    annotations: ADDITIVE,
    description: 'Add a BPMN text annotation, optionally associated with an existing element',
    outputSchema: outputSchemas.add_text_annotation,
    schema: z.object({
      text: annotationText().describe(
        'Annotation text preserved exactly, including whitespace, line breaks, and metacharacters'
      ),
      textFormat: boundedTrimmedString(TOOL_INPUT_LIMITS.language)
        .optional()
        .describe('Optional text media type; BPMN defaults to text/plain'),
      position: position.optional().describe('Position of the annotation'),
      size: size.optional().describe('Size of the annotation'),
      associatedElementId: bpmnId().optional().describe(
        'Existing element to link from the annotation with a separate undirected BPMN association'
      ),
      ...expectedRevisionField
    }).strict()
  },
  connect: {
    annotations: ADDITIVE,
    description: 'Connect two elements. Creates a SequenceFlow between flow nodes in the same '
      + 'process and scope, or a MessageFlow when the endpoints belong to different participants '
      + 'of a collaboration, including black-box pools. label becomes the flow name; condition and '
      + 'isDefault apply to sequence flows only.',
    outputSchema: outputSchemas.connect,
    schema: z.object({
      sourceId: bpmnId().describe('ID of the source element'),
      targetId: bpmnId().describe('ID of the target element'),
      label: label().optional().describe('Label for the connection (optional)'),
  documentation: boundedTrimmedString(TOOL_INPUT_LIMITS.annotationText).optional().describe(
    'Free-text bpmn:documentation for this element, preserved in the BPMN file'
  ),

      condition: expression().optional().describe(
        'Formal condition expression for a sequence flow; cannot be combined with isDefault'
      ),
      conditionLanguage: language().optional().describe(
        'Language URI or identifier; only valid when condition is supplied'
      ),
      conditionType: z.literal('bpmn:FormalExpression').optional().describe(
        'BPMN expression type; only valid when condition is supplied (defaults to bpmn:FormalExpression)'
      ),
      isDefault: z.boolean().default(false).describe(
        'Make this the source activity/gateway default flow; default flows cannot have conditions'
      ),
      ...expectedRevisionField
    }).strict()
  },
  add_association: {
    annotations: ADDITIVE,
    description: 'Add a BPMN association artifact between two compatible BaseElements',
    outputSchema: outputSchemas.add_association,
    schema: z.object({
      sourceId: bpmnId().describe('ID of the source BaseElement'),
      targetId: bpmnId().describe('ID of the target BaseElement'),
      associationDirection: z.enum(['None', 'One', 'Both'])
        .default('None')
        .describe('Arrow direction for the association; BPMN defaults to None'),
      ...expectedRevisionField
    }).strict()
  },
  add_pool: {
    annotations: ADDITIVE,
    description: 'Add a pool to the current collaboration diagram',
    outputSchema: outputSchemas.add_pool,
    schema: z.object({
      name: name().describe('Name of the participant/pool'),
      position: position.optional().describe(
        'Position of the pool. When omitted a placeholder below the existing pools '
        + 'is used; auto_layout replaces it.'
      ),
      size: size.optional().describe('Size of the pool (optional)'),
      blackBox: z.boolean().default(false).describe(
        'Create a black-box participant without an owned process'
      ),
      ...expectedRevisionField
    }).strict()
  },
  add_lane: {
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
    description: 'Add a lane to a white-box pool and assign flow nodes to it, or add flow nodes to an existing lane by passing laneId. Existing assignments are moved from their previous lane. A second lane with a name the pool already uses is rejected, and the error names the lane to target instead.',
    outputSchema: outputSchemas.add_lane,
    schema: z.object({
      poolId: bpmnId().describe('ID of the pool to add lane to'),
      laneId: bpmnId().optional().describe(
        'Existing lane to add these flow nodes to. Omit to create a new lane.'
      ),
      name: name().optional().describe(
        'Name of the lane. Required when creating one; renames the lane when laneId is given'
      ),
      flowNodeIds: withJsonSchemaMetadata(
        z.array(bpmnId())
          .min(TOOL_INPUT_LIMITS.laneFlowNodeIds.minItems)
          .max(TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems)
          .refine(
            values => new Set(values).size === values.length,
            'Flow node IDs must be unique'
          ),
        {
          description: 'IDs of direct flow nodes in the pool process to assign to this lane',
          uniqueItems: true
        }
      ),
      position: z.enum(['top', 'bottom'])
        .default('bottom')
        .describe('Position relative to existing lanes; ignored when laneId is given'),
      ...expectedRevisionField
    }).strict()
  },
  list_elements: {
    annotations: READ_ONLY,
    description: 'List elements and association artifacts in stable ID order as { count, returnedCount, offset, limit, hasMore, elements }; request the next page with offset + returnedCount',
    outputSchema: outputSchemas.list_elements,
    schema: z.object({
      elementType: z.enum(LISTABLE_ELEMENT_TYPES).optional().describe(
        'Filter by exact BPMN element type, for example bpmn:UserTask. This is the '
        + 'BPMN type returned in each row, not the activityType/gatewayType/eventType '
        + 'vocabulary the add_* tools take. Omit to list every element.'
      ),
      ...paginationFields
    }).strict()
  },
  get_element: {
    annotations: READ_ONLY,
    description: 'Get details of a specific element or association in the current diagram',
    outputSchema: outputSchemas.get_element,
    schema: z.object({
      elementId: bpmnId().describe('ID of the element')
    }).strict()
  },
  list_connections: {
    annotations: READ_ONLY,
    description: 'List SequenceFlow, MessageFlow, and Association connections in stable ID order with complete semantic and BPMN DI geometry views; filters combine and pagination continues with offset + returnedCount',
    outputSchema: outputSchemas.list_connections,
    schema: z.object({
      connectionType: z.enum([
        'bpmn:SequenceFlow',
        'bpmn:MessageFlow',
        'bpmn:Association'
      ]).optional().describe('Filter by BPMN connection type'),
      sourceId: bpmnId().optional().describe('Filter by source endpoint ID'),
      targetId: bpmnId().optional().describe('Filter by target endpoint ID'),
      ownerId: bpmnId().optional().describe('Filter by semantic owner ID'),
      scopeId: bpmnId().optional().describe('Filter by semantic scope ID'),
      ...paginationFields
    }).strict()
  },
  get_connection: {
    annotations: READ_ONLY,
    description: 'Get complete semantic and BPMN DI geometry details for a SequenceFlow, MessageFlow, or Association',
    outputSchema: outputSchemas.get_connection,
    schema: z.object({
      connectionId: bpmnId().describe('ID of the connection')
    }).strict()
  },
  update_element: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Update the name, documentation, typed properties, or default flow of an element in the current diagram. At least one of those must be supplied. A request whose values already match leaves the file and the document revision untouched and reports changed:false',
    outputSchema: outputSchemas.update_element,
    schema: z.object({
      elementId: bpmnId().describe('ID of the element to update'),
      name: name().optional().describe('New name for the element'),
  documentation: boundedTrimmedString(TOOL_INPUT_LIMITS.annotationText).optional().describe(
    'Free-text bpmn:documentation for this element, preserved in the BPMN file'
  ),

      properties: elementUpdateProperties.optional().describe(
        'Typed properties to update. isCollection and itemSubjectRef apply only to data object references; null clears itemSubjectRef, assignee, candidateGroups, or dueDate. Unknown and namespace-qualified fields are rejected.'
      ),
      defaultFlow: bpmnId().nullable().optional().describe(
        'Outgoing sequence-flow ID to make the element default, or null to clear its default flow'
      ),
      ...expectedRevisionField
    }).strict().superRefine((update, context) => {
      // A call naming only elementId used to bump the revision and rewrite the
      // file while changing nothing, invalidating every revision token the
      // agent held. It is a caller mistake, so it is rejected at the boundary.
      const hasMutation = ['name', 'documentation', 'properties', 'defaultFlow'].some(
        field => Object.prototype.hasOwnProperty.call(update, field)
      );
      if (!hasMutation) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one of name, documentation, properties, or defaultFlow must be updated'
        });
      }
    })
  },
  update_connection: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Atomically update a SequenceFlow, MessageFlow, or Association label, condition, default ownership, direction, or endpoints while preserving its ID. Labels apply to sequence and message flows only; BPMN associations have no name. Endpoint rewiring requires explicit boundary snapping. Pass expectedSemanticRevision from get_connection, or expectedRevision from any prior result, to make the update conditional on nothing having changed since.',
    outputSchema: outputSchemas.update_connection,
    schema: z.object({
      connectionId: bpmnId().describe('ID of the connection to update'),
      sourceId: bpmnId().optional().describe('Replacement source endpoint ID'),
      targetId: bpmnId().optional().describe('Replacement target endpoint ID'),
      label: label().nullable().optional().describe(
        'Replacement label; null clears it and omission preserves it'
      ),
      condition: z.object({
        body: opaqueExpressionBody().describe('Replacement condition expression body'),
        language: language().nullable().optional().describe(
          'Replacement condition language; null clears it and omission preserves it'
        )
      }).strict().nullable().optional().describe(
        'SequenceFlow condition replacement; null clears it'
      ),
      isDefault: z.boolean().optional().describe(
        'Whether the SequenceFlow is the source node default flow'
      ),
      associationDirection: z.enum(['None', 'One', 'Both']).optional().describe(
        'Replacement Association direction'
      ),
      endpointPolicy: z.literal('snap-to-boundary').optional().describe(
        'Required when sourceId or targetId changes; snaps the retained route to new endpoint bounds'
      ),
      collisionPolicy: z.enum(['reject-new', 'warn', 'allow']).default('reject-new').describe(
        'Reject newly introduced geometry errors, apply while reporting them, or explicitly allow them'
      ),
      expectedSemanticRevision: outputSemanticRevision.optional().describe(
        'Semantic revision returned by get_connection; stale values produce a structured conflict'
      ),
      ...expectedRevisionField
    }).strict().superRefine((update, context) => {
      const hasMutation = ['sourceId', 'targetId', 'label', 'condition', 'isDefault',
        'associationDirection'].some(field => Object.prototype.hasOwnProperty.call(update, field));
      if (!hasMutation) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one semantic field must be updated' });
      }
      if ((update.sourceId || update.targetId) && update.endpointPolicy !== 'snap-to-boundary') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Endpoint changes require endpointPolicy "snap-to-boundary"' });
      }
    })
  },
  update_element_geometry: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Move or resize one rendered BPMN element atomically. Enforces containment, requires an explicit incident-edge policy for connected shapes, rejects newly introduced collisions by default, and supports compare-and-set bounds, optimistic revisions, label bounds, and dry runs.',
    outputSchema: outputSchemas.update_element_geometry,
    schema: z.object({
      elementId: bpmnId().describe('Semantic ID owning the BPMNShape to update'),
      bounds: geometryBounds.describe('Replacement BPMNShape bounds'),
      labelBounds: geometryBounds.nullable().optional().describe(
        'Replacement BPMNLabel bounds; null removes the label bounds and omission preserves them'
      ),
      expectedBounds: geometryBounds.optional().describe(
        'Compare-and-set guard: reject unless the current BPMNShape bounds match exactly'
      ),
      collisionPolicy: z.enum(['reject', 'allow']).default('reject').describe(
        'Reject newly introduced shape, label, edge, or clearance collisions, or explicitly allow them'
      ),
      incidentConnectionPolicy: z.enum(['reject', 'snap-endpoints']).optional().describe(
        'Required when changing bounds of a connected shape: reject the move or atomically snap incident edge endpoints to the new bounds'
      ),
      dryRun: z.boolean().default(false).describe(
        'Validate and return the proposed result without changing memory, revision, or disk'
      ),
      ...expectedRevisionField
    }).strict()
  },
  update_connection_geometry: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Replace one rendered BPMNEdge route atomically. Supports exact or boundary-snapped endpoints, compare-and-set waypoints or geometry revisions, edge-label preservation or clearing, collision policy, optimistic document revisions, and dry runs.',
    outputSchema: outputSchemas.update_connection_geometry,
    schema: z.object({
      connectionId: bpmnId().describe('Semantic ID owning the BPMNEdge to update'),
      waypoints: z.array(position).min(2).max(MAX_INPUT_ARRAY_ITEMS).describe(
        'Complete replacement route containing 2 to 256 bounded finite BPMN DI waypoints'
      ),
      labelBounds: geometryBounds.nullable().optional().describe(
        'Replacement BPMNLabel bounds; null removes the label and omission preserves it'
      ),
      expectedWaypoints: z.array(position).min(2).max(MAX_INPUT_ARRAY_ITEMS).optional().describe(
        'Compare-and-set guard: reject unless current BPMNEdge waypoints match exactly'
      ),
      expectedGeometryRevision: outputGeometryRevision.optional().describe(
        'Opaque geometry revision returned by get_connection; stale values produce a structured conflict'
      ),
      endpointPolicy: z.enum(['exact', 'snap-to-boundary']).default('exact').describe(
        'Keep submitted endpoints exactly or snap the first and last waypoint to source and target boundaries'
      ),
      collisionPolicy: z.enum(['reject-new', 'warn', 'allow']).default('reject-new').describe(
        'Reject newly introduced error diagnostics, apply while reporting them, or explicitly allow them'
      ),
      dryRun: z.boolean().default(false).describe(
        'Validate and return the proposed result without changing memory, revision, or disk'
      ),
      ...expectedRevisionField
    }).strict()
  },
  apply_geometry_patch: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Atomically update multiple BPMNShape bounds or labels and BPMNEdge waypoints or labels. Guards every object with a document revision or expected geometry, validates only the complete final candidate, and supports bounded diagnostics, dry runs, and reject-new, warn, or allow collision policy.',
    outputSchema: outputSchemas.apply_geometry_patch,
    schema: z.object({
      elementUpdates: z.array(geometryPatchElementUpdate)
        .max(MAX_INPUT_ARRAY_ITEMS)
        .default([])
        .describe('BPMNShape bounds and label updates'),
      connectionUpdates: z.array(geometryPatchConnectionUpdate)
        .max(MAX_INPUT_ARRAY_ITEMS)
        .default([])
        .describe('BPMNEdge waypoint and label updates'),
      collisionPolicy: z.enum(['reject-new', 'warn', 'allow']).default('reject-new').describe(
        'Reject newly introduced error diagnostics, apply while reporting them, or explicitly allow them'
      ),
      dryRun: z.boolean().default(false).describe(
        'Validate and return the complete proposed patch without changing memory, revision, or disk'
      ),
      ...expectedRevisionField
    }).strict().superRefine((patch, context) => {
      const updateCount = patch.elementUpdates.length + patch.connectionUpdates.length;
      if (updateCount < 1 || updateCount > MAX_INPUT_ARRAY_ITEMS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Geometry patch must contain between 1 and ${MAX_INPUT_ARRAY_ITEMS} object updates`
        });
      }
      const duplicateElement = firstDuplicate(patch.elementUpdates.map(update => update.elementId));
      if (duplicateElement) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['elementUpdates'],
          message: `Duplicate element update ${duplicateElement}`
        });
      }
      const duplicateConnection = firstDuplicate(
        patch.connectionUpdates.map(update => update.connectionId)
      );
      if (duplicateConnection) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['connectionUpdates'],
          message: `Duplicate connection update ${duplicateConnection}`
        });
      }
      if (patch.expectedRevision) return;
      patch.elementUpdates.forEach((update, index) => {
        if (!update.expectedBounds) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['elementUpdates', index, 'expectedBounds'],
            message: 'expectedBounds is required when expectedRevision is omitted'
          });
        }
        if (Object.prototype.hasOwnProperty.call(update, 'labelBounds')
          && !Object.prototype.hasOwnProperty.call(update, 'expectedLabelBounds')) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['elementUpdates', index, 'expectedLabelBounds'],
            message: 'expectedLabelBounds is required for a label update when expectedRevision is omitted'
          });
        }
      });
      patch.connectionUpdates.forEach((update, index) => {
        if (!update.expectedGeometryRevision) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['connectionUpdates', index, 'expectedGeometryRevision'],
            message: 'expectedGeometryRevision is required when expectedRevision is omitted'
          });
        }
      });
    })
  },
  route_connection: {
    // Not destructive: the default call is a proposal that touches nothing, and
    // hosts that gate destructive tools were prompting users for a read-only
    // read. apply:true is the only mutating mode, and it replaces one edge's
    // waypoints with the same route each time, so the call stays idempotent.
    annotations: IDEMPOTENT_UPDATE,
    description: 'Propose a ranked collision-free orthogonal route for one rendered connection without mutation by default, or apply the selected route atomically with apply:true, which is the only mode that changes the diagram. Returns apply_geometry_patch-compatible geometry, score details, diagnostics, and revisions while preserving every unrelated BPMN DI object.',
    outputSchema: outputSchemas.route_connection,
    schema: z.object({
      connectionId: bpmnId().describe('Semantic ID owning the BPMNEdge to reroute'),
      avoidElementIds: withJsonSchemaMetadata(
        z.array(bpmnId()).max(MAX_INPUT_ARRAY_ITEMS)
          .refine(values => new Set(values).size === values.length, 'Element IDs must be unique')
          .default([]),
        { description: 'Rendered BPMNShape IDs the route must avoid', uniqueItems: true }
      ),
      avoidConnectionIds: withJsonSchemaMetadata(
        z.array(bpmnId()).max(MAX_INPUT_ARRAY_ITEMS)
          .refine(values => new Set(values).size === values.length, 'Connection IDs must be unique')
          .default([]),
        { description: 'Rendered BPMNEdge IDs the route must not cross', uniqueItems: true }
      ),
      clearance: z.number().finite().min(0).max(TOOL_INPUT_LIMITS.coordinate.max)
        .default(20)
        .describe('Minimum clearance from shapes, labels, and existing edge segments'),
      preserveOtherGeometry: z.literal(true).default(true).describe(
        'Required safety invariant: only the selected connection waypoints and label may change'
      ),
      expectedGeometryRevision: outputGeometryRevision.optional().describe(
        'Optional compare-and-set guard for the current target BPMNEdge geometry'
      ),
      apply: z.boolean().default(false).describe(
        'False returns a proposal only; true commits the selected route atomically'
      )
    }).strict()
  },
  build_process: {
    annotations: ADDITIVE,
    description: 'Create many elements and the flows between them in one atomic call. '
      + 'Each node carries a caller-chosen "ref" so flows in the same request can name it; '
      + 'a flow endpoint that is not a ref is treated as the id of an existing element. '
      + 'The same validation applies as for the individual add_event/add_activity/add_gateway/connect '
      + 'tools, and nothing is written unless every step succeeds. Returns the ref-to-ID mapping. '
      + 'Run auto_layout afterwards to place the result.',
    outputSchema: outputSchemas.build_process,
    schema: z.object({
      nodes: z.array(buildNode).min(1).max(MAX_INPUT_ARRAY_ITEMS).describe(
        'Elements to create, in order'
      ),
      flows: z.array(buildFlow).max(MAX_INPUT_ARRAY_ITEMS).default([]).describe(
        'Connections to create after every node exists'
      ),
      ...expectedRevisionField
    }).strict().superRefine((plan, context) => {
      const duplicate = firstDuplicate(plan.nodes.map(node => node.ref));
      if (duplicate !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes'],
          message: `Duplicate node ref "${duplicate}"`
        });
      }
    })
  },
  delete_element: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Delete an element or a connection. Deleting an element also deletes its incident connections, and deleting a container (participant, subprocess, transaction) also deletes everything it contains, including nested elements and their connections. Deleting a connection preserves both endpoints. The result lists every removed element ID.',
    outputSchema: outputSchemas.delete_element,
    schema: z.object({
      elementId: bpmnId().describe('ID of the element to delete'),
      ...expectedRevisionField
    }).strict()
  },
  export: {
    annotations: READ_ONLY,
    description: 'Export the current diagram as BPMN XML text or an embedded image/svg+xml resource rendered by bpmn-js',
    outputSchema: outputSchemas.export,
    schema: z.object({
      format: z.enum(['xml', 'svg']).default('xml').describe('Export format'),
      formatted: z.boolean().default(true).describe('Whether to format the output (for XML)')
    }).strict()
  },
  save_svg: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Render the current diagram as sanitized SVG and save it as a separate file in the managed workspace',
    outputSchema: outputSchemas.save_svg,
    schema: z.object({
      filename: artifactFilename('svg').describe('Managed-store .svg filename'),
      overwrite: z.boolean().default(false).describe('Replace an existing artifact with this filename')
    }).strict()
  },
  save_png: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Render the current diagram as PNG and save it as a separate file in the managed workspace. The result reports the pixel width and height, the scale actually used, and whether the requested scale was reduced to stay inside the renderer pixel limits',
    outputSchema: outputSchemas.save_png,
    schema: z.object({
      filename: artifactFilename('png').describe('Managed-store .png filename'),
      overwrite: z.boolean().default(false).describe('Replace an existing artifact with this filename'),
      scale: z.number().finite().positive().max(MAX_PNG_SCALE).default(1)
        .describe(
          'Pixel density multiplier applied to the diagram\'s own size, 1 to '
          + `${MAX_PNG_SCALE}. Large diagrams are downscaled below the requested `
          + 'value to stay inside the renderer pixel limits; the result says so'
        )
    }).strict()
  },
  validate: {
    annotations: READ_ONLY,
    description: 'Validate the current diagram using cumulative BPMN checks (each issue carries its own severity, so errors and warnings are one list): syntax parses XML and resolves references; semantic adds owner-aware event, flow, subprocess, lane, and collaboration rules; full also adds executable-profile start/end/connectivity guidance',
    outputSchema: outputSchemas.validate,
    schema: z.object({
      level: z.enum(['syntax', 'semantic', 'full'])
        .default('full')
        .describe(
          'Cumulative validation level: syntax; syntax + semantic; or syntax + semantic + executable-profile guidance'
        )
    }).strict()
  },
  analyze_geometry: {
    annotations: READ_ONLY,
    description: 'Analyze BPMN DI geometry deterministically. Returns stable severity-coded diagnostics, summary counts, and relevant shape/edge geometry for the whole diagram or selected element and connection IDs.',
    outputSchema: outputSchemas.analyze_geometry,
    schema: z.object({
      elementIds: withJsonSchemaMetadata(
        z.array(bpmnId()).max(MAX_INPUT_ARRAY_ITEMS)
          .refine(values => new Set(values).size === values.length, 'Element IDs must be unique')
          .default([]),
        { description: 'Optional BPMN shape/container IDs to scope diagnostics', uniqueItems: true }
      ),
      connectionIds: withJsonSchemaMetadata(
        z.array(bpmnId()).max(MAX_INPUT_ARRAY_ITEMS)
          .refine(values => new Set(values).size === values.length, 'Connection IDs must be unique')
          .default([]),
        { description: 'Optional BPMN connection IDs to scope diagnostics', uniqueItems: true }
      ),
      clearance: z.number().finite().min(0).max(TOOL_INPUT_LIMITS.coordinate.max)
        .default(5)
        .describe('Required minimum clearance in diagram units'),
      tolerance: z.number().finite().positive().max(TOOL_INPUT_LIMITS.coordinate.max)
        .default(1)
        .describe('Positive comparison tolerance in diagram units'),
      requireOrthogonal: z.boolean().default(false)
        .describe('Report diagonal edge segments when true')
    }).strict()
  },
  auto_layout: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Apply deterministic automatic layout. Collaboration processes are ranked independently; requested pool/lane sizes are lower bounds, manual coordinates are replaced unless pinned, disconnected nodes stay in their owner, and message flows route after non-overlapping pool placement. A layout that reproduces the current geometry is not committed and returns changed false with the revision unchanged.',
    outputSchema: outputSchemas.auto_layout,
    schema: z.object({
      algorithm: z.enum(['horizontal'])
        .default('horizontal')
        .describe('Layout algorithm to use'),
      direction: z.enum(['left-to-right', 'top-to-bottom'])
        .default('left-to-right')
        .describe(
          'Reading direction of the result. "top-to-bottom" reflects the ranked '
          + 'layout across the diagonal, so pools become vertical bands and '
          + 'flows run downward'
        ),
      spacing: z.number().finite().min(0.5).max(4).default(1).describe(
        'Multiplier for the gaps between ranks; 1 keeps the layout engine\'s own spacing'
      ),
      pinnedElementIds: withJsonSchemaMetadata(
        z.array(bpmnId())
          .max(TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems)
          .refine(
            values => new Set(values).size === values.length,
            'Pinned element IDs must be unique'
          )
          .default([]),
        {
          description: 'Elements whose current position and size auto_layout must keep. '
            + 'Not supported in a collaboration, and not on pools or expanded subprocesses. '
            + 'A pin that cannot be honoured fails the call rather than being dropped.',
          uniqueItems: true
        }
      ),
      ...expectedRevisionField
    }).strict()
  },
  list_diagrams: {
    annotations: READ_ONLY,
    description: 'List diagrams in stable filename order as { count, returnedCount, offset, limit, hasMore, diagrams, path }; request the next page with offset + returnedCount',
    outputSchema: outputSchemas.list_diagrams,
    schema: z.object({ ...paginationFields }).strict()
  },
  delete_diagram_file: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Delete a saved BPMN diagram file. Deleting the file of the active diagram also closes it, leaving no current diagram',
    outputSchema: outputSchemas.delete_diagram_file,
    schema: z.object({
      filename: filename().describe('Filename of the diagram to delete')
    }).strict()
  },
  get_diagrams_path: {
    annotations: READ_ONLY,
    description: 'Get the current managed workspace path (legacy compatibility alias)',
    outputSchema: outputSchemas.get_diagrams_path,
    schema: strictEmptyObject()
  },
  get_workspace: {
    annotations: READ_ONLY,
    description: 'Report the canonical client launch cwd, immutable startup boundary, current managed workspace, and selection source',
    outputSchema: outputSchemas.get_workspace,
    schema: strictEmptyObject()
  },
  select_workspace: {
    annotations: IDEMPOTENT_UPDATE,
    description: 'Select a session-scoped workspace below the immutable startup boundary reported by get_workspace; closes the active diagram when the workspace changes. The directory must already exist: this tool never creates one',
    outputSchema: outputSchemas.select_workspace,
    schema: z.object({
      path: boundedTrimmedString({ minLength: 1, maxLength: 4_096 })
        .describe(
          'Relative descendant path without dot segments or symbolic links, '
          + 'naming a directory that already exists'
        )
    }).strict()
  }
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof toolDefinitions;
export type ToolArguments<Name extends ToolName> = z.infer<
  (typeof toolDefinitions)[Name]['schema']
>;
export type ToolResult<Name extends ToolName> = z.infer<
  (typeof toolDefinitions)[Name]['outputSchema']
>;

export type ParsedToolRequest = {
  [Name in ToolName]: { name: Name; args: ToolArguments<Name> }
}[ToolName];

export const toolNames = Object.keys(toolDefinitions) as ToolName[];

/**
 * Drop every `description` from a schema tree.
 *
 * Output-schema prose is read by nobody: hosts pass the input schema to the
 * model and keep the output schema for validation, and a validator ignores
 * descriptions. Advertising them cost 18,768 bytes of every agent's context
 * window before it could make a single call (mcp-bpmn-8u0.24).
 */
function withoutDescriptions<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(withoutDescriptions) as unknown as T;
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([key]) => key !== 'description')
        .map(([key, value]) => [key, withoutDescriptions(value)])
    ) as T;
  }
  return node;
}

function toJsonObjectSchema(schema: z.ZodTypeAny): Tool['inputSchema'] {
  const { $schema: _schemaUri, ...jsonSchema } = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
    postProcess: jsonDescription
  });

  if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
    throw new Error('Tool argument schemas must describe JSON objects');
  }

  return jsonSchema as Tool['inputSchema'];
}

/**
 * The structured payload a failed call returns instead of the success shape.
 *
 * MCP clients validate `structuredContent` against the advertised outputSchema
 * whenever it is present, including on error results, so a tool that reports
 * machine-readable failures has to advertise that shape too. Without this the
 * SDK rejects the whole response with -32602 and the agent never sees the
 * error at all. Kept deliberately small: the codes are documented in
 * src/utils/ToolError.ts rather than inlined into all forty schemas.
 */
const TOOL_ERROR_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' }
  },
  additionalProperties: true
} as const;

/**
 * Build one tool's output schema, sharing every repeated sub-schema through a
 * single `definitions` block.
 *
 * Shapes like a BPMN id, a revision token and a set of bounds appear dozens of
 * times across these schemas; inlined, they were most of the payload. A `$ref`
 * resolves against the document root, so the definitions are hoisted above the
 * anyOf rather than left inside its first branch, where `#/definitions/...`
 * would not resolve. The e2e suite compiles every advertised schema with Ajv
 * and validates real results against it, which is what proves the references
 * resolve (mcp-bpmn-8u0.24).
 */
function toToolOutputSchema(schema: z.ZodTypeAny): Tool['outputSchema'] {
  const { $schema: _schemaUri, ...jsonSchema } = zodToJsonSchema(schema, {
    $refStrategy: 'root',
    target: 'jsonSchema7',
    postProcess: jsonDescription
  }) as Record<string, unknown>;

  return {
    type: 'object',
    anyOf: [
      rebaseRefs(withoutDescriptions(jsonSchema), '#/anyOf/0'),
      TOOL_ERROR_OUTPUT_SCHEMA
    ]
  } as unknown as Tool['outputSchema'];
}

/**
 * Re-point document-relative `$ref`s at the schema's new position.
 *
 * The generator emits `#/properties/x` for a sub-schema it has already seen,
 * which resolves from the root of the document it produced. Wrapping that
 * document as the first branch of an `anyOf` moves it, so every such pointer
 * has to gain the `#/anyOf/0` prefix or it silently resolves to nothing.
 */
function rebaseRefs<T>(node: T, prefix: string): T {
  if (Array.isArray(node)) {
    return node.map(item => rebaseRefs(item, prefix)) as unknown as T;
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => (
        key === '$ref' && typeof value === 'string' && value.startsWith('#/')
          ? [key, `${prefix}${value.slice(1)}`]
          : [key, rebaseRefs(value, prefix)]
      ))
    ) as T;
  }
  return node;
}

export const tools: Tool[] = toolNames.map(name => ({
  name,
  annotations: toolDefinitions[name].annotations,
  description: toolDefinitions[name].description,
  inputSchema: toJsonObjectSchema(toolDefinitions[name].schema),
  outputSchema: toToolOutputSchema(toolDefinitions[name].outputSchema)
}));

export function parseToolRequest(name: string, args: unknown): ParsedToolRequest {
  if (!Object.prototype.hasOwnProperty.call(toolDefinitions, name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const toolName = name as ToolName;
  const result = toolDefinitions[toolName].schema.safeParse(args === undefined ? {} : args);
  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const path = issue.path.length === 0 ? 'arguments' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    }).join('; ');
    throw new Error(`Invalid arguments for tool "${toolName}": ${details}`);
  }

  return { name: toolName, args: result.data } as ParsedToolRequest;
}

/** Validate successful handler results at the same boundary that validates inputs. */
export function parseToolResult<Name extends ToolName>(
  name: Name,
  value: ToolResult<Name>
): Record<string, unknown> {
  return toolDefinitions[name].outputSchema.parse(value) as Record<string, unknown>;
}
