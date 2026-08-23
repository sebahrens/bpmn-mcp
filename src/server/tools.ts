import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { jsonDescription, zodToJsonSchema } from 'zod-to-json-schema';
import {
  MAX_INPUT_ARRAY_ITEMS,
  TOOL_INPUT_LIMITS
} from '../config/index.js';
import type { SafeJsonObject, SafeJsonValue } from '../types/index.js';
import { BPMN_ID_PATTERN } from '../utils/BpmnId.js';

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
const identifier = () => boundedTrimmedString(TOOL_INPUT_LIMITS.identifier);
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

export const PROPERTY_PAYLOAD_LIMITS = Object.freeze({
  maxDepth: 8,
  maxKeys: 128,
  maxKeyLength: 256,
  maxStringLength: 8_192,
  maxArrayLength: MAX_INPUT_ARRAY_ITEMS,
  maxSerializedBytes: 64 * 1_024
});

const FORBIDDEN_PROPERTY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class PropertyPayloadError extends Error {
  constructor(
    message: string,
    readonly path: Array<string | number> = []
  ) {
    super(message);
  }
}

/**
 * Validate and detach an untrusted JSON property bag. Records intentionally
 * have no prototype so later property access cannot resolve inherited keys.
 */
export function copySafeProperties(value: unknown): SafeJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PropertyPayloadError('properties must be a JSON object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PropertyPayloadError('properties must be a plain JSON object');
  }

  const state = {
    keyCount: 0,
    serializedBytes: 0,
    seen: new WeakSet<object>()
  };
  const copied = copySafeJsonValue(value, 0, [], state);
  return copied as SafeJsonObject;
}

function copySafeJsonValue(
  value: unknown,
  depth: number,
  path: Array<string | number>,
  state: { keyCount: number; serializedBytes: number; seen: WeakSet<object> }
): SafeJsonValue {
  if (value === null || typeof value === 'boolean') {
    addSerializedBytes(JSON.stringify(value), path, state);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PropertyPayloadError('property numbers must be finite', path);
    }
    addSerializedBytes(JSON.stringify(value), path, state);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > PROPERTY_PAYLOAD_LIMITS.maxStringLength) {
      throw new PropertyPayloadError(
        `property strings may contain at most ${PROPERTY_PAYLOAD_LIMITS.maxStringLength} characters`,
        path
      );
    }
    addSerializedBytes(JSON.stringify(value), path, state);
    return value;
  }
  if (typeof value !== 'object') {
    throw new PropertyPayloadError('properties may contain only JSON values', path);
  }
  if (depth > PROPERTY_PAYLOAD_LIMITS.maxDepth) {
    throw new PropertyPayloadError(
      `property payload may be at most ${PROPERTY_PAYLOAD_LIMITS.maxDepth} levels deep`,
      path
    );
  }
  if (state.seen.has(value)) {
    throw new PropertyPayloadError('property payload must not contain circular references', path);
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > PROPERTY_PAYLOAD_LIMITS.maxArrayLength) {
      throw new PropertyPayloadError(
        `property arrays may contain at most ${PROPERTY_PAYLOAD_LIMITS.maxArrayLength} items`,
        path
      );
    }
    const result: SafeJsonValue[] = [];
    addSerializedBytes('[', path, state);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new PropertyPayloadError('property arrays must not contain empty slots', [...path, index]);
      }
      if (index > 0) addSerializedBytes(',', [...path, index], state);
      result.push(copySafeJsonValue(value[index], depth + 1, [...path, index], state));
    }
    addSerializedBytes(']', path, state);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PropertyPayloadError('properties may contain only plain JSON objects', path);
  }

  const keys = Reflect.ownKeys(value);
  state.keyCount += keys.length;
  if (state.keyCount > PROPERTY_PAYLOAD_LIMITS.maxKeys) {
    throw new PropertyPayloadError(
      `property payload may contain at most ${PROPERTY_PAYLOAD_LIMITS.maxKeys} keys`,
      path
    );
  }

  const result = Object.create(null) as SafeJsonObject;
  addSerializedBytes('{', path, state);
  for (const [index, key] of keys.entries()) {
    if (typeof key !== 'string') {
      throw new PropertyPayloadError('property keys must be strings', path);
    }
    if (FORBIDDEN_PROPERTY_KEYS.has(key)) {
      throw new PropertyPayloadError(`forbidden property key "${key}"`, [...path, key]);
    }
    if (key.length > PROPERTY_PAYLOAD_LIMITS.maxKeyLength) {
      throw new PropertyPayloadError(
        `property keys may contain at most ${PROPERTY_PAYLOAD_LIMITS.maxKeyLength} characters`,
        [...path, key]
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new PropertyPayloadError('properties may contain only plain JSON fields', [...path, key]);
    }
    if (index > 0) addSerializedBytes(',', [...path, key], state);
    addSerializedBytes(`${JSON.stringify(key)}:`, [...path, key], state);
    result[key] = copySafeJsonValue(descriptor.value, depth + 1, [...path, key], state);
  }
  addSerializedBytes('}', path, state);
  return result;
}

function addSerializedBytes(
  fragment: string,
  path: Array<string | number>,
  state: { serializedBytes: number }
): void {
  state.serializedBytes += Buffer.byteLength(fragment, 'utf8');
  if (state.serializedBytes > PROPERTY_PAYLOAD_LIMITS.maxSerializedBytes) {
    throw new PropertyPayloadError(
      `property payload exceeds ${PROPERTY_PAYLOAD_LIMITS.maxSerializedBytes} serialized bytes`,
      path
    );
  }
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
const bpmnId = () => z.string()
  .min(TOOL_INPUT_LIMITS.identifier.minLength)
  .max(TOOL_INPUT_LIMITS.identifier.maxLength)
  .regex(BPMN_ID_PATTERN, 'Invalid BPMN xsd:ID; expected an XML NCName');
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
const activityProperties = z.object({
  isExpanded: z.boolean().optional(),
  calledElement: extensionString().optional(),
  assignee: extensionString().optional(),
  candidateGroups: candidateGroups().optional(),
  dueDate: extensionString().optional(),
  multiInstance: multiInstance.optional()
}).strict();
const elementUpdateProperties = z.object({
  isExpanded: z.boolean().optional(),
  calledElement: extensionString().optional(),
  assignee: extensionString().nullable().optional(),
  candidateGroups: candidateGroups().nullable().optional(),
  dueDate: extensionString().nullable().optional(),
  multiInstance: multiInstance.optional(),
  isCollection: z.boolean().optional(),
  itemSubjectRef: bpmnId().nullable().optional()
}).strict();

const outputFilename = z.string().min(1).describe('Active BPMN filename');
const outputBpmnId = z.string()
  .min(1)
  .regex(BPMN_ID_PATTERN, 'Invalid BPMN xsd:ID; expected an XML NCName')
  .describe('Stable generated or existing BPMN ID');
const outputCount = z.number().int().min(0);
const outputDiagram = z.object({
  processId: outputBpmnId,
  name: z.string(),
  type: z.enum(['process', 'collaboration']),
  extensionProfile,
  filename: outputFilename
}).strict();
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
const outputQueryBase = z.object({
  id: outputBpmnId,
  type: z.string().min(1),
  name: z.string().optional(),
  kind: z.string().optional(),
  ownerId: outputBpmnId.optional(),
  scopeId: outputBpmnId.optional(),
  processRef: outputBpmnId.optional(),
  sourceId: outputBpmnId.optional(),
  targetId: outputBpmnId.optional(),
  associationDirection: z.enum(['None', 'One', 'Both']).optional(),
  position: outputPosition.optional(),
  size: outputSize.optional(),
  waypoints: z.array(outputPosition).optional(),
  defaultFlow: outputBpmnId.optional()
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
  open_bpmn: outputDiagram.extend({
    elementCount: outputCount,
    connectionCount: outputCount
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
    filename: outputFilename
  }).strict(),
  save_as: z.object({
    processId: outputBpmnId,
    name: z.string(),
    filename: outputFilename
  }).strict(),
  close: z.object({
    processId: outputBpmnId,
    name: z.string(),
    filename: outputFilename
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
    filename: outputFilename
  }).strict(),
  add_activity: z.object({
    elementId: outputBpmnId,
    elementType: z.string().min(1),
    filename: outputFilename
  }).strict(),
  add_gateway: z.object({
    elementId: outputBpmnId,
    elementType: z.string().min(1),
    filename: outputFilename
  }).strict(),
  add_data_object: z.object({
    referenceId: outputBpmnId,
    dataObjectId: outputBpmnId,
    filename: outputFilename
  }).strict(),
  add_text_annotation: z.object({
    annotationId: outputBpmnId,
    associationId: outputBpmnId.optional(),
    filename: outputFilename
  }).strict(),
  connect: z.object({
    connectionId: outputBpmnId,
    connectionType: z.string().min(1),
    sourceId: outputBpmnId,
    targetId: outputBpmnId,
    filename: outputFilename
  }).strict(),
  add_association: z.object({
    associationId: outputBpmnId,
    sourceId: outputBpmnId,
    targetId: outputBpmnId,
    associationDirection: z.enum(['None', 'One', 'Both']),
    filename: outputFilename
  }).strict(),
  add_pool: z.object({
    elementId: outputBpmnId,
    processId: outputBpmnId.optional(),
    blackBox: z.boolean(),
    filename: outputFilename
  }).strict(),
  add_lane: z.object({
    laneId: outputBpmnId,
    poolId: outputBpmnId,
    assignedFlowNodeCount: outputCount,
    filename: outputFilename
  }).strict(),
  list_elements: z.object({
    ...outputPage,
    elements: z.array(outputListElement)
  }).strict(),
  get_element: outputElementDetails,
  update_element: z.object({
    elementId: outputBpmnId,
    filename: outputFilename
  }).strict(),
  delete_element: z.object({
    elementId: outputBpmnId,
    deletedKind: z.enum(['element', 'connection']),
    removedConnectionCount: outputCount,
    filename: outputFilename
  }).strict(),
  export: z.object({
    processId: outputBpmnId,
    filename: outputFilename,
    format: z.enum(['xml', 'svg']),
    mimeType: z.enum(['application/xml', 'image/svg+xml']),
    byteLength: outputCount,
    uri: z.string().optional()
  }).strict(),
  validate: z.object({
    level: z.enum(['syntax', 'semantic', 'full']),
    valid: z.boolean(),
    issues: z.array(outputValidationIssue),
    errors: z.array(outputValidationIssue),
    warnings: z.array(outputValidationIssue),
    summary: z.string(),
    filename: outputFilename
  }).strict(),
  auto_layout: z.object({
    algorithm: z.literal('horizontal'),
    elementCount: outputCount,
    connectionCount: outputCount,
    warnings: z.array(outputLayoutWarning),
    filename: outputFilename
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
  }).strict()
} as const;

/**
 * The single source of truth for tool advertisement, runtime validation, and
 * tool argument types. All object schemas are strict at the request boundary.
 */
export const toolDefinitions = {
  new_bpmn: {
    annotations: ADDITIVE,
    description: 'Create a new BPMN diagram and set it as current context',
    outputSchema: outputSchemas.new_bpmn,
    schema: z.object({
      name: name().describe('Name of the diagram'),
      type: z.enum(['process', 'collaboration'])
        .default('process')
        .describe('Type of diagram to create'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile; portable emits no vendor attributes')
    }).strict()
  },
  new_from_mermaid: {
    annotations: ADDITIVE,
    description: 'Create a new BPMN diagram from Mermaid code and set it as current context',
    outputSchema: outputSchemas.new_from_mermaid,
    schema: z.object({
      name: name().describe('Name for the new diagram'),
      mermaidCode: boundedTrimmedString(TOOL_INPUT_LIMITS.mermaidCode)
        .describe('Mermaid flowchart code to convert'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile for the authored document')
    }).strict()
  },
  open_bpmn: {
    annotations: IDEMPOTENT_UPDATE,
    description: 'Open an existing BPMN file and set it as current context',
    outputSchema: outputSchemas.open_bpmn,
    schema: z.object({
      filename: filename().describe('Filename of the BPMN diagram to open')
    }).strict()
  },
  open_mermaid_file: {
    annotations: ADDITIVE,
    description: 'Open a Mermaid file, convert it to BPMN, and set as current context',
    outputSchema: outputSchemas.open_mermaid_file,
    schema: z.object({
      filename: filename().describe('Filename of the Mermaid file to open and convert'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile for the authored document')
    }).strict()
  },
  save: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Save the current diagram to its file (error if no filename set)',
    outputSchema: outputSchemas.save,
    schema: strictEmptyObject()
  },
  save_as: {
    annotations: IDEMPOTENT_UPDATE,
    description: 'Save the current diagram with a new filename',
    outputSchema: outputSchemas.save_as,
    schema: z.object({
      filename: filename().describe('New filename for the diagram')
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
      eventDefinitionPayload: z.object({
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
        'Definition details. Timer requires timer; conditional requires condition. Message/signal/error/escalation roots are generated and may be named or assigned a stable ID here.'
      ),
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
      )
    }).strict()
  },
  add_activity: {
    annotations: ADDITIVE,
    description: 'Add an activity to the current diagram',
    outputSchema: outputSchemas.add_activity,
    schema: z.object({
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
      )
    }).strict()
  },
  add_gateway: {
    annotations: ADDITIVE,
    description: 'Add a gateway to the current diagram',
    outputSchema: outputSchemas.add_gateway,
    schema: z.object({
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
      )
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
      )
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
      )
    }).strict()
  },
  connect: {
    annotations: ADDITIVE,
    description: 'Connect two elements in the current diagram',
    outputSchema: outputSchemas.connect,
    schema: z.object({
      sourceId: bpmnId().describe('ID of the source element'),
      targetId: bpmnId().describe('ID of the target element'),
      label: label().optional().describe('Label for the connection (optional)'),
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
      )
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
        .describe('Arrow direction for the association; BPMN defaults to None')
    }).strict()
  },
  add_pool: {
    annotations: ADDITIVE,
    description: 'Add a pool to the current collaboration diagram',
    outputSchema: outputSchemas.add_pool,
    schema: z.object({
      name: name().describe('Name of the participant/pool'),
      position: position.optional().describe('Position of the pool (optional)'),
      size: size.optional().describe('Size of the pool (optional)'),
      blackBox: z.boolean().default(false).describe(
        'Create a black-box participant without an owned process'
      )
    }).strict()
  },
  add_lane: {
    annotations: DESTRUCTIVE_NON_IDEMPOTENT,
    description: 'Add a lane to a white-box pool and assign flow nodes to it. Existing assignments are moved from their previous lane.',
    outputSchema: outputSchemas.add_lane,
    schema: z.object({
      poolId: bpmnId().describe('ID of the pool to add lane to'),
      name: name().describe('Name of the lane'),
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
        .describe('Position relative to existing lanes')
    }).strict()
  },
  list_elements: {
    annotations: READ_ONLY,
    description: 'List elements and association artifacts in stable ID order as { count, returnedCount, offset, limit, hasMore, elements }; request the next page with offset + returnedCount',
    outputSchema: outputSchemas.list_elements,
    schema: z.object({
      elementType: identifier().optional().describe('Filter by element type (optional)'),
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
  update_element: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Update properties of an element in the current diagram',
    outputSchema: outputSchemas.update_element,
    schema: z.object({
      elementId: bpmnId().describe('ID of the element to update'),
      name: name().optional().describe('New name for the element'),
      properties: elementUpdateProperties.optional().describe(
        'Typed properties to update. isCollection and itemSubjectRef apply only to data object references; null clears itemSubjectRef, assignee, candidateGroups, or dueDate. Unknown and namespace-qualified fields are rejected.'
      ),
      defaultFlow: bpmnId().nullable().optional().describe(
        'Outgoing sequence-flow ID to make the element default, or null to clear its default flow'
      )
    }).strict()
  },
  delete_element: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Delete an element (cascading incident connections) or a connection while preserving its endpoints',
    outputSchema: outputSchemas.delete_element,
    schema: z.object({
      elementId: bpmnId().describe('ID of the element to delete')
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
  validate: {
    annotations: READ_ONLY,
    description: 'Validate the current diagram using cumulative BPMN checks: syntax parses XML and resolves references; semantic adds owner-aware event, flow, subprocess, lane, and collaboration rules; full also adds executable-profile start/end/connectivity guidance',
    outputSchema: outputSchemas.validate,
    schema: z.object({
      level: z.enum(['syntax', 'semantic', 'full'])
        .default('full')
        .describe(
          'Cumulative validation level: syntax; syntax + semantic; or syntax + semantic + executable-profile guidance'
        )
    }).strict()
  },
  auto_layout: {
    annotations: DESTRUCTIVE_UPDATE,
    description: 'Apply deterministic automatic layout. Collaboration processes are ranked independently; requested pool/lane sizes are lower bounds, manual coordinates are replaced, disconnected nodes stay in their owner, and message flows route after non-overlapping pool placement.',
    outputSchema: outputSchemas.auto_layout,
    schema: z.object({
      algorithm: z.enum(['horizontal'])
        .default('horizontal')
        .describe('Layout algorithm to use')
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
    description: 'Delete a saved BPMN diagram file',
    outputSchema: outputSchemas.delete_diagram_file,
    schema: z.object({
      filename: filename().describe('Filename of the diagram to delete')
    }).strict()
  },
  get_diagrams_path: {
    annotations: READ_ONLY,
    description: 'Get the path where BPMN diagrams are saved',
    outputSchema: outputSchemas.get_diagrams_path,
    schema: strictEmptyObject()
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

export const tools: Tool[] = toolNames.map(name => ({
  name,
  annotations: toolDefinitions[name].annotations,
  description: toolDefinitions[name].description,
  inputSchema: toJsonObjectSchema(toolDefinitions[name].schema),
  outputSchema: toJsonObjectSchema(toolDefinitions[name].outputSchema)
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
