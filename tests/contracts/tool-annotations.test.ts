import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import {
  toolDefinitions,
  toolNames,
  tools,
  type ToolName
} from '../../src/server/tools.js';
import { FileManager } from '../../src/utils/FileManager.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

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
  route_connection: DESTRUCTIVE_UPDATE,
  delete_element: DESTRUCTIVE_UPDATE,
  export: READ_ONLY,
  save_svg: DESTRUCTIVE_UPDATE,
  save_png: DESTRUCTIVE_UPDATE,
  validate: READ_ONLY,
  analyze_geometry: READ_ONLY,
  auto_layout: DESTRUCTIVE_UPDATE,
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
