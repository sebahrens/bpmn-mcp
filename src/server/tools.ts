import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { jsonDescription, zodToJsonSchema } from 'zod-to-json-schema';
import { config } from '../config/index.js';
import type { SafeJsonObject, SafeJsonValue } from '../types/index.js';

interface ToolDefinition {
  description: string;
  schema: z.ZodTypeAny;
}

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
export const TOOL_INPUT_LIMITS = Object.freeze({
  coordinate: Object.freeze({ min: 0, max: 1_000_000 }),
  dimension: Object.freeze({ min: 1, max: 1_000_000 }),
  name: Object.freeze({ minLength: 1, maxLength: 256 }),
  label: Object.freeze({ minLength: 1, maxLength: 1_024 }),
  // FileManager appends a PID and UUID for adjacent atomic writes; 200 leaves
  // room for that suffix under the common 255-byte component-name ceiling.
  filename: Object.freeze({ minLength: 1, maxLength: 200 }),
  identifier: Object.freeze({ minLength: 1, maxLength: 255 }),
  annotationText: Object.freeze({ minLength: 1, maxLength: 8_192 }),
  expression: Object.freeze({ minLength: 1, maxLength: 8_192 }),
  language: Object.freeze({ minLength: 1, maxLength: 256 }),
  // The handler separately enforces this configured limit in UTF-8 bytes.
  mermaidCode: Object.freeze({
    minLength: 1,
    maxLength: config.resourceLimits.maxMermaidBytes
  })
});

const boundedTrimmedString = (limits: { minLength: number; maxLength: number }) =>
  z.string().trim().min(limits.minLength).max(limits.maxLength);
const name = () => boundedTrimmedString(TOOL_INPUT_LIMITS.name);
const label = () => boundedTrimmedString(TOOL_INPUT_LIMITS.label);
const filename = () => boundedTrimmedString(TOOL_INPUT_LIMITS.filename);
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
).min(1);
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
  maxArrayLength: 256,
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
const bpmnId = identifier().regex(/^[A-Za-z_][A-Za-z0-9._-]*$/);
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
  loopDataInputRef: identifier().optional().describe(
    'ID of an existing BPMN ItemAwareElement used as the loop collection/input'
  ),
  loopDataOutputRef: identifier().optional().describe(
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
  itemSubjectRef: identifier().nullable().optional()
}).strict();

/**
 * The single source of truth for tool advertisement, runtime validation, and
 * tool argument types. All object schemas are strict at the request boundary.
 */
export const toolDefinitions = {
  new_bpmn: {
    description: 'Create a new BPMN diagram and set it as current context',
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
    description: 'Create a new BPMN diagram from Mermaid code and set it as current context',
    schema: z.object({
      name: name().describe('Name for the new diagram'),
      mermaidCode: boundedTrimmedString(TOOL_INPUT_LIMITS.mermaidCode)
        .describe('Mermaid flowchart code to convert'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile for the authored document')
    }).strict()
  },
  open_bpmn: {
    description: 'Open an existing BPMN file and set it as current context',
    schema: z.object({
      filename: filename().describe('Filename of the BPMN diagram to open')
    }).strict()
  },
  open_mermaid_file: {
    description: 'Open a Mermaid file, convert it to BPMN, and set as current context',
    schema: z.object({
      filename: filename().describe('Filename of the Mermaid file to open and convert'),
      extensionProfile: extensionProfile.default('portable')
        .describe('BPMN extension profile for the authored document')
    }).strict()
  },
  save: {
    description: 'Save the current diagram to its file (error if no filename set)',
    schema: strictEmptyObject()
  },
  save_as: {
    description: 'Save the current diagram with a new filename',
    schema: z.object({
      filename: filename().describe('New filename for the diagram')
    }).strict()
  },
  close: {
    description: 'Close the current diagram and clear the context',
    schema: strictEmptyObject()
  },
  current: {
    description: 'Get information about the current diagram',
    schema: strictEmptyObject()
  },
  add_event: {
    description: 'Add an event to the current diagram',
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
        definitionId: bpmnId.optional().describe(
          'Stable child event-definition ID (generated when omitted)'
        ),
        reference: z.object({
          id: bpmnId.optional(),
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
        activityRef: identifier().optional().describe(
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
      attachTo: identifier().optional().describe(
        'Required activity ID for boundary events; invalid on other events. Cancel boundaries require a transaction.'
      ),
      ownerId: identifier().optional().describe(
        'Owning process ID (required when adding to a collaboration)'
      ),
      scopeId: identifier().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      )
    }).strict()
  },
  add_activity: {
    description: 'Add an activity to the current diagram',
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
      ownerId: identifier().optional().describe(
        'Owning process ID (required when adding to a collaboration)'
      ),
      scopeId: identifier().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      )
    }).strict()
  },
  add_gateway: {
    description: 'Add a gateway to the current diagram',
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
      ownerId: identifier().optional().describe(
        'Owning process ID (required when adding to a collaboration)'
      ),
      scopeId: identifier().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      )
    }).strict()
  },
  add_data_object: {
    description: 'Add a BPMN data object reference and its non-rendered backing data object',
    schema: z.object({
      name: name().describe('Name of the data object and its visible reference'),
      position: position.optional().describe('Position of the visible data object reference'),
      isCollection: z.boolean().default(false).describe(
        'Whether the backing bpmn:DataObject represents a collection'
      ),
      itemSubjectRef: identifier().optional().describe(
        'ID of an existing bpmn:ItemDefinition referenced by the backing data object'
      ),
      ownerId: identifier().optional().describe(
        'Owning process ID (required when adding to a collaboration with multiple pools)'
      ),
      scopeId: identifier().optional().describe(
        'Containing process or subprocess ID (defaults to ownerId)'
      )
    }).strict()
  },
  add_text_annotation: {
    description: 'Add a BPMN text annotation, optionally associated with an existing element',
    schema: z.object({
      text: annotationText().describe(
        'Annotation text preserved exactly, including whitespace, line breaks, and metacharacters'
      ),
      textFormat: boundedTrimmedString(TOOL_INPUT_LIMITS.language)
        .optional()
        .describe('Optional text media type; BPMN defaults to text/plain'),
      position: position.optional().describe('Position of the annotation'),
      size: size.optional().describe('Size of the annotation'),
      associatedElementId: identifier().optional().describe(
        'Existing element to link from the annotation with a separate undirected BPMN association'
      )
    }).strict()
  },
  connect: {
    description: 'Connect two elements in the current diagram',
    schema: z.object({
      sourceId: identifier().describe('ID of the source element'),
      targetId: identifier().describe('ID of the target element'),
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
    description: 'Add a BPMN association artifact between two compatible BaseElements',
    schema: z.object({
      sourceId: identifier().describe('ID of the source BaseElement'),
      targetId: identifier().describe('ID of the target BaseElement'),
      associationDirection: z.enum(['None', 'One', 'Both'])
        .default('None')
        .describe('Arrow direction for the association; BPMN defaults to None')
    }).strict()
  },
  add_pool: {
    description: 'Add a pool to the current collaboration diagram',
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
    description: 'Add a lane to a white-box pool and assign flow nodes to it. Existing assignments are moved from their previous lane.',
    schema: z.object({
      poolId: identifier().describe('ID of the pool to add lane to'),
      name: name().describe('Name of the lane'),
      flowNodeIds: withJsonSchemaMetadata(
        z.array(identifier()).min(1).refine(
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
    description: 'List elements and association artifacts in stable ID order as { count, returnedCount, offset, limit, hasMore, elements }; request the next page with offset + returnedCount',
    schema: z.object({
      elementType: identifier().optional().describe('Filter by element type (optional)'),
      ...paginationFields
    }).strict()
  },
  get_element: {
    description: 'Get details of a specific element or association in the current diagram',
    schema: z.object({
      elementId: identifier().describe('ID of the element')
    }).strict()
  },
  update_element: {
    description: 'Update properties of an element in the current diagram',
    schema: z.object({
      elementId: identifier().describe('ID of the element to update'),
      name: name().optional().describe('New name for the element'),
      properties: elementUpdateProperties.optional().describe(
        'Typed properties to update. isCollection and itemSubjectRef apply only to data object references; null clears itemSubjectRef, assignee, candidateGroups, or dueDate. Unknown and namespace-qualified fields are rejected.'
      ),
      defaultFlow: identifier().nullable().optional().describe(
        'Outgoing sequence-flow ID to make the element default, or null to clear its default flow'
      )
    }).strict()
  },
  delete_element: {
    description: 'Delete an element (cascading incident connections) or delete an association alone',
    schema: z.object({
      elementId: identifier().describe('ID of the element to delete')
    }).strict()
  },
  export: {
    description: 'Export the current diagram as BPMN XML text or an embedded image/svg+xml resource rendered by bpmn-js',
    schema: z.object({
      format: z.enum(['xml', 'svg']).default('xml').describe('Export format'),
      formatted: z.boolean().default(true).describe('Whether to format the output (for XML)')
    }).strict()
  },
  validate: {
    description: 'Validate the current diagram using cumulative BPMN checks: syntax parses XML and resolves references; semantic adds owner-aware event, flow, subprocess, lane, and collaboration rules; full also adds executable-profile start/end/connectivity guidance',
    schema: z.object({
      level: z.enum(['syntax', 'semantic', 'full'])
        .default('full')
        .describe(
          'Cumulative validation level: syntax; syntax + semantic; or syntax + semantic + executable-profile guidance'
        )
    }).strict()
  },
  auto_layout: {
    description: 'Apply deterministic automatic layout. Collaboration processes are ranked independently; requested pool/lane sizes are lower bounds, manual coordinates are replaced, disconnected nodes stay in their owner, and message flows route after non-overlapping pool placement.',
    schema: z.object({
      algorithm: z.enum(['horizontal', 'vertical'])
        .default('horizontal')
        .describe('Layout algorithm to use')
    }).strict()
  },
  list_diagrams: {
    description: 'List diagrams in stable filename order as { count, returnedCount, offset, limit, hasMore, diagrams, path }; request the next page with offset + returnedCount',
    schema: z.object({ ...paginationFields }).strict()
  },
  delete_diagram_file: {
    description: 'Delete a saved BPMN diagram file',
    schema: z.object({
      filename: filename().describe('Filename of the diagram to delete')
    }).strict()
  },
  get_diagrams_path: {
    description: 'Get the path where BPMN diagrams are saved',
    schema: strictEmptyObject()
  }
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof toolDefinitions;
export type ToolArguments<Name extends ToolName> = z.infer<
  (typeof toolDefinitions)[Name]['schema']
>;

export type ParsedToolRequest = {
  [Name in ToolName]: { name: Name; args: ToolArguments<Name> }
}[ToolName];

export const toolNames = Object.keys(toolDefinitions) as ToolName[];

function toInputSchema(schema: z.ZodTypeAny): Tool['inputSchema'] {
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
  description: toolDefinitions[name].description,
  inputSchema: toInputSchema(toolDefinitions[name].schema)
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
