import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import {
  parseToolRequest,
  toolDefinitions,
  toolNames,
  tools,
  type ToolName
} from '../../src/server/tools.js';
import { FileManager } from '../../src/utils/FileManager.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';
import { TOOL_ERROR_CODES } from '../../src/utils/ToolError.js';

type ReviewedAnnotations = Required<Pick<
  ToolAnnotations,
  'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'
>>;

const READ_ONLY: ReviewedAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const ADDITIVE: ReviewedAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};
const IDEMPOTENT_UPDATE: ReviewedAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const DESTRUCTIVE_UPDATE: ReviewedAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
};
const DESTRUCTIVE_NON_IDEMPOTENT: ReviewedAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

// Deliberately exhaustive: a new tool must receive an explicit behavioral review.
const EXPECTED_ANNOTATIONS = {
  new_bpmn: ADDITIVE,
  new_from_mermaid: ADDITIVE,
  preview_mermaid: READ_ONLY,
  open_bpmn: IDEMPOTENT_UPDATE,
  open_mermaid_file: ADDITIVE,
  save: DESTRUCTIVE_UPDATE,
  save_as: IDEMPOTENT_UPDATE,
  close: IDEMPOTENT_UPDATE,
  current: READ_ONLY,
  add_event: ADDITIVE,
  add_activity: ADDITIVE,
  add_gateway: ADDITIVE,
  add_data_object: ADDITIVE,
  add_text_annotation: ADDITIVE,
  connect: ADDITIVE,
  add_association: ADDITIVE,
  add_pool: ADDITIVE,
  add_lane: DESTRUCTIVE_NON_IDEMPOTENT,
  list_elements: READ_ONLY,
  get_element: READ_ONLY,
  list_connections: READ_ONLY,
  get_connection: READ_ONLY,
  update_element: DESTRUCTIVE_UPDATE,
  update_connection: DESTRUCTIVE_UPDATE,
  update_element_geometry: DESTRUCTIVE_UPDATE,
  update_connection_geometry: DESTRUCTIVE_UPDATE,
  apply_geometry_patch: DESTRUCTIVE_UPDATE,
  route_connection: IDEMPOTENT_UPDATE,
  delete_element: DESTRUCTIVE_UPDATE,
  export: READ_ONLY,
  save_svg: DESTRUCTIVE_UPDATE,
  save_png: DESTRUCTIVE_UPDATE,
  validate: READ_ONLY,
  analyze_geometry: READ_ONLY,
  auto_layout: DESTRUCTIVE_UPDATE,
  build_process: ADDITIVE,
  list_diagrams: READ_ONLY,
  delete_diagram_file: DESTRUCTIVE_UPDATE,
  get_diagrams_path: READ_ONLY,
  get_workspace: READ_ONLY,
  select_workspace: IDEMPOTENT_UPDATE
} satisfies Record<ToolName, ReviewedAnnotations>;

function successfulContent(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

async function storedFiles(directory: string): Promise<Record<string, string>> {
  const filenames = (await fs.readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(filenames.map(async filename => [
    filename,
    await fs.readFile(join(directory, filename), 'utf8')
  ])));
}

describe('MCP tool behavior annotations', () => {
  let directory: string;
  let handler: BpmnRequestHandler;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-tool-annotations-'));
    IdGenerator.reset();
    diagramContext.clear();
    handler = new BpmnRequestHandler(new SimpleBpmnEngine(directory));
  });

  afterEach(async () => {
    await handler.shutdown();
    jest.restoreAllMocks();
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('advertises the reviewed annotation tuple for every ToolName', () => {
    expect(Object.keys(EXPECTED_ANNOTATIONS).sort()).toEqual([...toolNames].sort());

    for (const name of toolNames) {
      expect(toolDefinitions[name].annotations).toEqual(EXPECTED_ANNOTATIONS[name]);
      expect(tools.find(tool => tool.name === name)?.annotations)
        .toEqual(EXPECTED_ANNOTATIONS[name]);
    }
  });

  it('does not persist during tools advertised as read-only', async () => {
    const created = successfulContent(await handler.handleRequest('new_bpmn', {
      name: 'Read-only probes'
    }));
    const added = successfulContent(await handler.handleRequest('add_event', {
      eventType: 'start',
      name: 'Start'
    }));
    const target = successfulContent(await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Target'
    }));
    const connected = successfulContent(await handler.handleRequest('connect', {
      sourceId: added.elementId,
      targetId: target.elementId
    }));
    const before = await storedFiles(directory);
    const saveSpy = jest.spyOn(FileManager.prototype, 'saveBpmnFile');
    const deleteSpy = jest.spyOn(FileManager.prototype, 'deleteBpmnFile');

    const probes: Array<[ToolName, Record<string, unknown>]> = [
      ['current', {}],
      ['preview_mermaid', { mermaidCode: 'flowchart TD\n  A[Alpha] --> B[Beta]' }],
      ['list_elements', {}],
      ['get_element', { elementId: added.elementId }],
      ['list_connections', {}],
      ['get_connection', { connectionId: connected.connectionId }],
      ['export', { format: 'xml' }],
      ['validate', { level: 'full' }],
      ['analyze_geometry', {}],
      ['list_diagrams', {}],
      ['get_diagrams_path', {}],
      ['get_workspace', {}]
    ];
    for (const [name, args] of probes) {
      successfulContent(await handler.handleRequest(name, args));
      expect(EXPECTED_ANNOTATIONS[name].readOnlyHint).toBe(true);
    }

    expect(created.filename).toEqual(expect.any(String));
    expect(saveSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await storedFiles(directory)).toEqual(before);
  });

  it('proposes a route without mutating, and is not advertised as destructive', async () => {
    expect(tools.find(tool => tool.name === 'route_connection')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false
    });

    successfulContent(await handler.handleRequest('new_bpmn', { name: 'Route probes' }));
    const start = successfulContent(await handler.handleRequest('add_event', {
      eventType: 'start',
      name: 'Start'
    }));
    const task = successfulContent(await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Work'
    }));
    const connected = successfulContent(await handler.handleRequest('connect', {
      sourceId: start.elementId,
      targetId: task.elementId
    }));
    const before = await storedFiles(directory);
    const saveSpy = jest.spyOn(FileManager.prototype, 'saveBpmnFile');

    const proposal = successfulContent(await handler.handleRequest('route_connection', {
      connectionId: connected.connectionId
    }));

    expect(proposal.applied).toBe(false);
    expect(proposal.beforeRevision).toBe(proposal.afterRevision);
    expect(proposal.afterRevision).toBe(connected.afterRevision);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(await storedFiles(directory)).toEqual(before);
  });

  it('repeats idempotent updates without an additional model effect', async () => {
    successfulContent(await handler.handleRequest('new_bpmn', {
      name: 'Idempotent probes'
    }));
    const added = successfulContent(await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Before'
    }));
    const updateArgs = { elementId: added.elementId, name: 'After' };

    successfulContent(await handler.handleRequest('update_element', updateArgs));
    const afterFirstUpdate = await storedFiles(directory);
    successfulContent(await handler.handleRequest('update_element', updateArgs));
    expect(await storedFiles(directory)).toEqual(afterFirstUpdate);

    successfulContent(await handler.handleRequest('save', {}));
    const afterFirstSave = await storedFiles(directory);
    successfulContent(await handler.handleRequest('save', {}));
    expect(await storedFiles(directory)).toEqual(afterFirstSave);
  });

  it('persists another diagram when a Mermaid file is opened repeatedly', async () => {
    const sourceFilename = 'repeat.mmd';
    await fs.writeFile(
      join(directory, sourceFilename),
      'flowchart TD\n  A[Alpha] --> B[Beta]\n',
      'utf8'
    );

    const first = successfulContent(await handler.handleRequest('open_mermaid_file', {
      filename: sourceFilename
    }));
    const second = successfulContent(await handler.handleRequest('open_mermaid_file', {
      filename: sourceFilename
    }));

    expect(first.filename).not.toBe(second.filename);
    expect((await fs.readdir(directory)).filter(filename => filename.endsWith('.bpmn')))
      .toHaveLength(2);
    expect(EXPECTED_ANNOTATIONS.open_mermaid_file.idempotentHint).toBe(false);
  });

  it('moves an existing assignment when add_lane is repeated', async () => {
    successfulContent(await handler.handleRequest('new_bpmn', {
      name: 'Lane probes',
      type: 'collaboration'
    }));
    const pool = successfulContent(await handler.handleRequest('add_pool', {
      name: 'Pool'
    }));
    const activity = successfulContent(await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Task',
      ownerId: pool.processId
    }));
    const laneArgs = {
      poolId: pool.elementId,
      name: 'Operators',
      flowNodeIds: [activity.elementId]
    };

    const first = successfulContent(await handler.handleRequest('add_lane', laneArgs));
    const afterFirstLane = await storedFiles(directory);
    const second = successfulContent(await handler.handleRequest('add_lane', laneArgs));

    expect(first.laneId).not.toBe(second.laneId);
    expect(await storedFiles(directory)).not.toEqual(afterFirstLane);
    expect(EXPECTED_ANNOTATIONS.add_lane).toMatchObject({
      destructiveHint: true,
      idempotentHint: false
    });
  });

  it('classifies and performs diagram-file deletion as destructive and idempotent', async () => {
    const created = successfulContent(await handler.handleRequest('new_bpmn', {
      name: 'Delete probe'
    }));
    const filename = created.filename as string;

    expect(EXPECTED_ANNOTATIONS.delete_diagram_file).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    });
    successfulContent(await handler.handleRequest('delete_diagram_file', { filename }));
    await expect(fs.access(join(directory, filename))).rejects.toThrow();

    const repeated = await handler.handleRequest('delete_diagram_file', { filename });
    expect(repeated.isError).toBe(true);
    await expect(fs.access(join(directory, filename))).rejects.toThrow();
  });
});

describe('structured tool errors', () => {
  const errorCases: Array<{ label: string; tool: ToolName; args: unknown; code: string }> = [
    {
      label: 'a tool needing a diagram before one is open',
      tool: 'list_elements',
      args: {},
      code: 'no_current_diagram'
    },
    {
      label: 'an argument that fails schema validation',
      tool: 'add_activity',
      args: { activityType: 'notAType', name: 'x' },
      code: 'invalid_arguments'
    },
    {
      label: 'an unknown element id',
      tool: 'get_element',
      args: { elementId: 'Nope_1' },
      code: 'element_not_found'
    },
    {
      label: 'an unknown connection id',
      tool: 'get_connection',
      args: { connectionId: 'Nope_1' },
      code: 'connection_not_found'
    }
  ];

  it.each(errorCases)('reports $label with a machine-readable code', async ({ tool, args, code }) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-errors-'));
    IdGenerator.reset();
    diagramContext.clear();
    const handler = new BpmnRequestHandler(new SimpleBpmnEngine(directory));
    try {
      if (code !== 'no_current_diagram') {
        await handler.handleRequest('new_bpmn', { name: 'Errors' });
      }

      const result = await handler.handleRequest(tool, args);

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      expect(structured).toBeDefined();
      expect(structured!.code).toBe(code);
      expect(typeof structured!.message).toBe('string');
      expect(TOOL_ERROR_CODES).toContain(structured!.code);
    } finally {
      diagramContext.clear();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('gives every advertised tool a structured failure when called with no diagram open', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-errors-all-'));
    IdGenerator.reset();
    diagramContext.clear();
    const handler = new BpmnRequestHandler(new SimpleBpmnEngine(directory));
    try {
      const offenders: string[] = [];
      for (const name of toolNames) {
        const result = await handler.handleRequest(name, {});
        if (!result.isError) continue;
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        if (!structured || !TOOL_ERROR_CODES.includes(structured.code as never)) {
          offenders.push(`${name}: ${JSON.stringify(structured?.code ?? null)}`);
        }
      }

      expect(offenders).toEqual([]);
    } finally {
      diagramContext.clear();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('advertised schema cost', () => {
  // tools/list is sent to the model before it can do anything, so its size is
  // a per-session tax on every agent. It was 168 KB before the expanded XML
  // NCName pattern was dropped from every id-valued field; the error branch
  // each outputSchema now advertises costs some of that back, and is required
  // for clients to accept error results at all. This bound is deliberately
  // close to the current size so a regression is noticed; raise it
  // consciously when the tool surface grows.
  const MAX_TOOLS_LIST_BYTES = 140_000;

  it('keeps the advertised tool list within its size budget', () => {
    const advertised = JSON.stringify(tools);

    expect(advertised.length).toBeLessThan(MAX_TOOLS_LIST_BYTES);
  });

  it('does not embed the expanded XML NCName character class in any schema', () => {
    // The runtime still enforces NCName; only the multi-hundred-byte pattern
    // is kept out of the advertised schema.
    const advertised = JSON.stringify(tools);

    expect(advertised).not.toContain('\\u02FF');
    expect(advertised).not.toContain('uD7FF');
  });

  it('advertises an output schema that accepts this server error payload', async () => {
    // Regression guard: MCP clients validate structuredContent against the
    // advertised outputSchema even when isError is true. A tool that reports a
    // machine-readable failure must therefore advertise that shape, or strict
    // clients reject the entire response with -32602 and the agent sees
    // nothing at all.
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ strict: false, allErrors: true });
    const sampleError = {
      code: 'element_not_found',
      message: 'Element Nope_1 not found',
      recovery: 'List elements with list_elements and use an id from that result.',
      elementId: 'Nope_1'
    };

    const rejecting = tools
      .filter(tool => tool.outputSchema
        && !ajv.compile(tool.outputSchema as object)(sampleError))
      .map(tool => tool.name);

    expect(rejecting).toEqual([]);
  });

  it('still advertises the success shape for every tool', async () => {
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ strict: false, allErrors: true });

    // The success branch must still reject an obviously wrong success payload,
    // so the union does not degenerate into "accepts anything".
    const nonsense = { definitelyNotAField: 1 };
    const accepting = tools
      .filter(tool => tool.outputSchema
        && ajv.compile(tool.outputSchema as object)(nonsense))
      .map(tool => tool.name);

    expect(accepting).toEqual([]);
  });

  it('still rejects an identifier that is not an XML NCName', () => {
    expect(() => parseToolRequest('get_element', { elementId: '1bad id' })).toThrow(/NCName/);
    expect(() => parseToolRequest('get_element', { elementId: 'Task_1' })).not.toThrow();
  });
});
