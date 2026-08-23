import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import {
  parseToolRequest,
  TOOL_INPUT_LIMITS,
  toolDefinitions,
  toolNames,
  tools,
  type ToolName
} from '../../src/server/tools.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

const validArguments = {
  new_bpmn: { name: 'Validated process' },
  new_from_mermaid: { name: 'Validated Mermaid', mermaidCode: 'flowchart TD\nA-->B' },
  open_bpmn: { filename: 'diagram.bpmn' },
  open_mermaid_file: { filename: 'diagram.mmd' },
  save: {},
  save_as: { filename: 'copy.bpmn' },
  close: {},
  current: {},
  add_event: { eventType: 'start' },
  add_activity: { activityType: 'task', name: 'Task' },
  add_gateway: { gatewayType: 'exclusive' },
  add_data_object: { name: 'Data' },
  add_text_annotation: { text: 'Context note' },
  connect: { sourceId: 'StartEvent_1', targetId: 'Task_1' },
  add_association: { sourceId: 'TextAnnotation_1', targetId: 'Task_1' },
  add_pool: { name: 'Pool' },
  add_lane: { poolId: 'Participant_1', name: 'Lane', flowNodeIds: ['Task_1'] },
  list_elements: {},
  get_element: { elementId: 'Task_1' },
  update_element: { elementId: 'Task_1' },
  delete_element: { elementId: 'Task_1' },
  export: {},
  validate: {},
  auto_layout: {},
  list_diagrams: {},
  delete_diagram_file: { filename: 'diagram.bpmn' },
  get_diagrams_path: {}
} satisfies Record<ToolName, unknown>;

describe('MCP request validation boundary', () => {
  let directory: string;
  let handler: BpmnRequestHandler;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-request-validation-'));
    IdGenerator.reset();
    diagramContext.clear();
    handler = new BpmnRequestHandler(new SimpleBpmnEngine(directory));
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps advertised tools, validators, and dispatchers in exhaustive parity', () => {
    const advertisedNames = tools.map(tool => tool.name).sort();
    const validatorNames = Object.keys(toolDefinitions).sort();
    const dispatcherNames = Object.keys((handler as unknown as {
      dispatchers: Record<string, unknown>;
    }).dispatchers).sort();

    expect(advertisedNames).toEqual([...toolNames].sort());
    expect(validatorNames).toEqual(advertisedNames);
    expect(dispatcherNames).toEqual(advertisedNames);
    expect(new Set(advertisedNames).size).toBe(advertisedNames.length);

    for (const name of toolNames) {
      expect(() => parseToolRequest(name, validArguments[name])).not.toThrow();
    }
  });

  it('advertises strict objects, complete nested geometry, and runtime defaults', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }

    const addPoolSchema = tools.find(tool => tool.name === 'add_pool')!.inputSchema as any;
    expect(addPoolSchema.properties.position.required).toEqual(['x', 'y']);
    expect(addPoolSchema.properties.position.additionalProperties).toBe(false);
    expect(addPoolSchema.properties.position.properties.x).toMatchObject({
      minimum: TOOL_INPUT_LIMITS.coordinate.min,
      maximum: TOOL_INPUT_LIMITS.coordinate.max
    });
    expect(addPoolSchema.properties.size.required).toEqual(['width', 'height']);
    expect(addPoolSchema.properties.size.additionalProperties).toBe(false);
    expect(addPoolSchema.properties.size.properties.width).toMatchObject({
      minimum: TOOL_INPUT_LIMITS.dimension.min,
      maximum: TOOL_INPUT_LIMITS.dimension.max
    });

    const newBpmnSchema = tools.find(tool => tool.name === 'new_bpmn')!.inputSchema as any;
    expect(newBpmnSchema.properties.name).toMatchObject({
      minLength: TOOL_INPUT_LIMITS.name.minLength,
      maxLength: TOOL_INPUT_LIMITS.name.maxLength
    });

    const openBpmnSchema = tools.find(tool => tool.name === 'open_bpmn')!.inputSchema as any;
    expect(openBpmnSchema.properties.filename).toMatchObject({
      minLength: TOOL_INPUT_LIMITS.filename.minLength,
      maxLength: TOOL_INPUT_LIMITS.filename.maxLength
    });

    const addLaneSchema = tools.find(tool => tool.name === 'add_lane')!.inputSchema as any;
    expect(addLaneSchema.properties.flowNodeIds.uniqueItems).toBe(true);
    expect(addLaneSchema.properties.flowNodeIds.maxItems)
      .toBe(TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems);

    const addActivitySchema = tools.find(tool => tool.name === 'add_activity')!.inputSchema as any;
    expect(addActivitySchema.properties.properties.properties.candidateGroups.maxItems)
      .toBe(TOOL_INPUT_LIMITS.candidateGroups.maxItems);

    const defaultCases: Array<[ToolName, unknown, Record<string, unknown>]> = [
      ['new_bpmn', { name: 'Defaults' }, { type: 'process' }],
      ['connect', { sourceId: 'a', targetId: 'b' }, { isDefault: false }],
      ['add_data_object', { name: 'Data' }, { isCollection: false }],
      ['add_association', { sourceId: 'a', targetId: 'b' }, { associationDirection: 'None' }],
      ['add_pool', { name: 'Pool' }, { blackBox: false }],
      ['add_lane', { poolId: 'p', name: 'Lane', flowNodeIds: ['n'] }, { position: 'bottom' }],
      ['export', {}, { format: 'xml', formatted: true }],
      ['validate', {}, { level: 'full' }],
      ['auto_layout', {}, { algorithm: 'horizontal' }],
      ['list_elements', {}, { limit: 100, offset: 0 }],
      ['list_diagrams', {}, { limit: 100, offset: 0 }]
    ];

    for (const [name, args, expectedDefaults] of defaultCases) {
      expect(parseToolRequest(name, args).args).toMatchObject(expectedDefaults);
    }
  });

  it('normalizes absent arguments only for tools whose schema accepts an empty object', async () => {
    const current = await handler.handleRequest('current', undefined);
    expect(current.isError).toBeUndefined();
    expect(current.content[0].text).toBe('No current diagram');

    const required = await handler.handleRequest('new_bpmn', undefined);
    expect(required.isError).toBe(true);
    expect(required.content[0].text).toContain('Invalid arguments for tool "new_bpmn"');
  });

  it('accepts exact geometry and string boundaries, including fractional geometry', async () => {
    const maximumName = 'n'.repeat(TOOL_INPUT_LIMITS.name.maxLength);
    const created = await handler.handleRequest('new_bpmn', {
      name: `  ${maximumName}  `,
      type: 'collaboration'
    });
    expect(created.isError).toBeUndefined();
    expect(diagramContext.getCurrentInfo()?.name).toBe(maximumName);

    const minimumPool = await handler.handleRequest('add_pool', {
      name: 'Minimum geometry',
      position: {
        x: TOOL_INPUT_LIMITS.coordinate.min,
        y: TOOL_INPUT_LIMITS.coordinate.min + 0.5
      },
      size: {
        width: TOOL_INPUT_LIMITS.dimension.min,
        height: TOOL_INPUT_LIMITS.dimension.min + 0.5
      }
    });
    expect(minimumPool.isError).toBeUndefined();

    const maximumPool = await handler.handleRequest('add_pool', {
      name: 'Maximum geometry',
      position: {
        x: TOOL_INPUT_LIMITS.coordinate.max,
        y: TOOL_INPUT_LIMITS.coordinate.max
      },
      size: {
        width: TOOL_INPUT_LIMITS.dimension.max,
        height: TOOL_INPUT_LIMITS.dimension.max
      }
    });
    expect(maximumPool.isError).toBeUndefined();

    const process = diagramContext.getCurrent();
    const ownerId = Array.from(process.elements.values()).find(
      element => element.type === 'bpmn:Participant'
    )?.processRef;
    expect(ownerId).toBeDefined();
    const start = await handler.handleRequest('add_event', {
      eventType: 'start',
      name: 'S',
      ownerId,
      scopeId: ownerId
    });
    const task = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'T',
      ownerId,
      scopeId: ownerId
    });
    expect(start.isError).toBeUndefined();
    expect(task.isError).toBeUndefined();
    const [startId, taskId] = Array.from(process.elements.values())
      .filter(element => element.ownerId === ownerId)
      .map(element => element.id);
    const maximumLabel = await handler.handleRequest('connect', {
      sourceId: startId,
      targetId: taskId,
      label: 'l'.repeat(TOOL_INPUT_LIMITS.label.maxLength)
    });
    expect(maximumLabel.isError).toBeUndefined();

    const maximumFilename = `${'f'.repeat(TOOL_INPUT_LIMITS.filename.maxLength - 5)}.bpmn`;
    const saved = await handler.handleRequest('save_as', { filename: maximumFilename });
    expect(saved.isError).toBeUndefined();
    await expect(fs.access(join(directory, maximumFilename))).resolves.toBeUndefined();

    expect(() => parseToolRequest('new_from_mermaid', {
      name: 'M',
      mermaidCode: 'm'.repeat(TOOL_INPUT_LIMITS.mermaidCode.maxLength)
    })).not.toThrow();

    expect(() => parseToolRequest('add_activity', {
      activityType: 'userTask',
      name: 'Bounded groups',
      properties: {
        candidateGroups: Array.from(
          { length: TOOL_INPUT_LIMITS.candidateGroups.maxItems },
          (_, index) => `group-${index}`
        )
      }
    })).not.toThrow();
    expect(() => parseToolRequest('add_lane', {
      poolId: 'Participant_1',
      name: 'Bounded lane',
      flowNodeIds: Array.from(
        { length: TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems },
        (_, index) => `Task_${index}`
      )
    })).not.toThrow();
  });

  it.each([
    ['null', 'new_bpmn', null],
    ['array', 'new_bpmn', ['not', 'an', 'object']],
    ['missing required field', 'new_bpmn', {}],
    ['wrong enum', 'new_bpmn', { name: 'Replacement', type: 'invalid' }],
    ['wrong type', 'new_bpmn', { name: 42 }],
    ['partial position', 'add_activity', {
      activityType: 'task', name: 'Injected', position: { x: 10 }
    }],
    ['partial size', 'add_pool', { name: 'Injected', size: { width: 100 } }],
    ['position below minimum', 'add_activity', {
      activityType: 'task',
      name: 'Injected',
      position: { x: TOOL_INPUT_LIMITS.coordinate.min - 1, y: 0 }
    }],
    ['position above maximum', 'add_activity', {
      activityType: 'task',
      name: 'Injected',
      position: { x: TOOL_INPUT_LIMITS.coordinate.max + 1, y: 0 }
    }],
    ['zero dimension', 'add_pool', {
      name: 'Injected',
      size: { width: TOOL_INPUT_LIMITS.dimension.min - 1, height: 1 }
    }],
    ['dimension above maximum', 'add_pool', {
      name: 'Injected',
      size: { width: TOOL_INPUT_LIMITS.dimension.max + 1, height: 1 }
    }],
    ['infinite coordinate', 'add_activity', {
      activityType: 'task', name: 'Injected', position: { x: Number.POSITIVE_INFINITY, y: 0 }
    }],
    ['negative-infinite coordinate', 'add_activity', {
      activityType: 'task', name: 'Injected', position: { x: Number.NEGATIVE_INFINITY, y: 0 }
    }],
    ['NaN dimension', 'add_pool', {
      name: 'Injected', size: { width: Number.NaN, height: 1 }
    }],
    ['empty name', 'new_bpmn', { name: '' }],
    ['whitespace name', 'add_activity', { activityType: 'task', name: '   ' }],
    ['oversized name', 'add_pool', {
      name: 'n'.repeat(TOOL_INPUT_LIMITS.name.maxLength + 1)
    }],
    ['whitespace label', 'connect', {
      sourceId: 'StartEvent_1', targetId: 'Task_1', label: '   '
    }],
    ['oversized label', 'connect', {
      sourceId: 'StartEvent_1',
      targetId: 'Task_1',
      label: 'l'.repeat(TOOL_INPUT_LIMITS.label.maxLength + 1)
    }],
    ['whitespace annotation text', 'add_text_annotation', { text: '   \n  ' }],
    ['oversized annotation text', 'add_text_annotation', {
      text: 'a'.repeat(TOOL_INPUT_LIMITS.annotationText.maxLength + 1)
    }],
    ['whitespace filename', 'save_as', { filename: '   ' }],
    ['oversized filename', 'delete_diagram_file', {
      filename: `${'f'.repeat(TOOL_INPUT_LIMITS.filename.maxLength - 4)}.bpmn`
    }],
    ['oversized UTF-8 filename', 'save_as', {
      filename: `${'é'.repeat(98)}.bpmn`
    }],
    ['whitespace Mermaid code', 'new_from_mermaid', {
      name: 'Injected', mermaidCode: '   '
    }],
    ['oversized Mermaid code', 'new_from_mermaid', {
      name: 'Injected',
      mermaidCode: 'm'.repeat(TOOL_INPUT_LIMITS.mermaidCode.maxLength + 1)
    }],
    ['oversized nested expression', 'add_event', {
      eventType: 'intermediate-catch',
      eventDefinition: 'timer',
      eventDefinitionPayload: {
        timer: {
          type: 'timeDuration',
          expression: 'x'.repeat(TOOL_INPUT_LIMITS.expression.maxLength + 1)
        }
      }
    }],
    ['whitespace nested language', 'add_event', {
      eventType: 'intermediate-catch',
      eventDefinition: 'timer',
      eventDefinitionPayload: {
        timer: { type: 'timeDuration', expression: 'PT1M', language: '   ' }
      }
    }],
    ['partial nested event object', 'add_event', {
      eventType: 'intermediate-catch',
      eventDefinition: 'timer',
      eventDefinitionPayload: { timer: { type: 'timeDuration' } }
    }],
    ['unknown top-level key', 'current', { unexpected: true }],
    ['unknown nested key', 'add_event', {
      eventType: 'start',
      position: { x: 10, y: 20, z: 30 }
    }],
    ['unknown event definition payload key', 'add_event', {
      eventType: 'start',
      eventDefinitionPayload: { unexpected: true }
    }],
    ['duplicate lane flow node IDs', 'add_lane', {
      poolId: 'Participant_1',
      name: 'Lane',
      flowNodeIds: ['Task_1', 'Task_1']
    }],
    ['too many candidate groups', 'add_activity', {
      activityType: 'userTask',
      name: 'Injected',
      properties: {
        candidateGroups: Array.from(
          { length: TOOL_INPUT_LIMITS.candidateGroups.maxItems + 1 },
          (_, index) => `group-${index}`
        )
      }
    }],
    ['too many lane flow node IDs', 'add_lane', {
      poolId: 'Participant_1',
      name: 'Lane',
      flowNodeIds: Array.from(
        { length: TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems + 1 },
        (_, index) => `Task_${index}`
      )
    }],
    ['unknown key on a file mutation', 'delete_diagram_file', {
      filename: 'stable-diagram.bpmn',
      force: true
    }]
  ])('rejects %s before changing context or files', async (_label, name, args) => {
    const created = await handler.handleRequest('new_bpmn', { name: 'Stable diagram' });
    expect(created.isError).toBeUndefined();

    const contextBefore = diagramContext.getCurrentInfo();
    const filesBefore = await snapshotDirectory(directory);
    const result = await handler.handleRequest(name, args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`Invalid arguments for tool "${name}"`);
    expect(diagramContext.getCurrentInfo()).toEqual(contextBefore);
    expect(await snapshotDirectory(directory)).toEqual(filesBefore);
  });
});

async function snapshotDirectory(directory: string): Promise<Record<string, string>> {
  const entries = (await fs.readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(entries.map(async entry => [
    entry,
    await fs.readFile(join(directory, entry), 'utf8')
  ])));
}
