import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceLimits } from '../../src/config/index.js';
import { DEFAULT_RESOURCE_LIMITS } from '../../src/config/index.js';
import { MermaidConverter } from '../../src/converters/MermaidConverter.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import {
  assertLayoutComplexity,
  BpmnAutoLayoutV2Adapter,
  type BpmnLayoutAdapter
} from '../../src/core/layout/BpmnLayoutAdapter.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import { MAX_PAGE_LIMIT, parseToolRequest } from '../../src/server/tools.js';
import { FileManager } from '../../src/utils/FileManager.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

const passthroughLayout: BpmnLayoutAdapter = {
  layout: jest.fn(async (xml: string) => ({ xml, warnings: [] }))
};

function limits(overrides: Partial<ResourceLimits> = {}): ResourceLimits {
  return { ...DEFAULT_RESOURCE_LIMITS, ...overrides };
}

function textOf(result: Awaited<ReturnType<BpmnRequestHandler['handleRequest']>>): string {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text result');
  return item.text;
}

function denseProcessXml(elementCount: number): string {
  const elements = Array.from(
    { length: elementCount },
    (_, index) => `<bpmn:task id="Task_${index}" />`
  ).join('');
  const connections: string[] = [];
  for (let source = 0; source < elementCount; source++) {
    for (let target = source + 1; target < elementCount; target++) {
      connections.push(
        `<bpmn:sequenceFlow id="Flow_${source}_${target}" sourceRef="Task_${source}" targetRef="Task_${target}" />`
      );
    }
  }
  return `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="resource-test"><bpmn:process id="Process_1">${elements}${connections.join('')}</bpmn:process></bpmn:definitions>`;
}

describe('resource exhaustion guards', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-resource-'));
    IdGenerator.reset();
    diagramContext.clear();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('accepts an exact-limit Mermaid file and rejects one byte over before conversion', async () => {
    const maxMermaidBytes = 128;
    const source = 'flowchart TD\n  A((Start)) --> B((End))';
    const commentPrefix = `${source}\n%%`;
    const exact = `${commentPrefix}${'x'.repeat(maxMermaidBytes - Buffer.byteLength(commentPrefix))}`;
    const fileManager = new FileManager(directory);
    await fs.writeFile(join(directory, 'exact.mmd'), exact, 'utf8');
    await fs.writeFile(join(directory, 'over.mmd'), `${exact}x`, 'utf8');

    await expect(fileManager.readMermaidFile('exact.mmd', maxMermaidBytes)).resolves.toBe(exact);
    await expect(fileManager.readMermaidFile('over.mmd', maxMermaidBytes))
      .rejects.toThrow('Mermaid import exceeds the configured byte limit');

    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout),
      undefined,
      limits({ maxMermaidBytes })
    );
    const opened = await handler.handleRequest('open_mermaid_file', { filename: 'exact.mmd' });
    expect(opened.isError).toBeUndefined();
    const stable = diagramContext.getCurrent();

    const rejected = await handler.handleRequest('open_mermaid_file', { filename: 'over.mmd' });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('Mermaid import exceeds the configured byte limit');
    expect(diagramContext.getCurrent()).toBe(stable);
  });

  it('accepts the layout element limit and rejects one over before invoking layout', async () => {
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn(async xml => ({ xml, warnings: [] }))
    };
    const engine = new SimpleBpmnEngine(
      directory,
      undefined,
      adapter,
      limits({ maxLayoutElements: 2, maxLayoutConnections: 10, maxLayoutDensity: 10 })
    );
    const context = await engine.createProcess('Element guard');
    await engine.createElement(context.id, { type: 'bpmn:Task', name: 'One' });
    await engine.createElement(context.id, { type: 'bpmn:Task', name: 'Two' });

    await expect(engine.applyAutoLayout(context.id)).resolves.toBeDefined();
    expect(adapter.layout).toHaveBeenCalledTimes(1);

    await engine.createElement(context.id, { type: 'bpmn:Task', name: 'Three' });
    await expect(engine.applyAutoLayout(context.id)).rejects.toThrow('element limit 2 exceeded');
    expect(adapter.layout).toHaveBeenCalledTimes(1);
  });

  it('guards inline Mermaid bytes and Mermaid layout complexity before layout', async () => {
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn(async xml => ({ xml, warnings: [] }))
    };
    const resourceLimits = limits({
      maxMermaidBytes: 64,
      maxLayoutElements: 2,
      maxLayoutConnections: 2,
      maxLayoutDensity: 2
    });
    const converter = new MermaidConverter(adapter, resourceLimits);
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout, resourceLimits),
      converter,
      resourceLimits
    );

    const exactGraph = await handler.handleRequest('new_from_mermaid', {
      name: 'Exact graph',
      mermaidCode: 'flowchart TD\nA-->B'
    });
    expect(exactGraph.isError).toBeUndefined();
    expect(adapter.layout).toHaveBeenCalledTimes(1);

    const overGraph = await handler.handleRequest('new_from_mermaid', {
      name: 'Over graph',
      mermaidCode: 'flowchart TD\nA-->B-->C'
    });
    expect(overGraph.isError).toBe(true);
    expect(textOf(overGraph)).toContain('element limit 2 exceeded');
    expect(adapter.layout).toHaveBeenCalledTimes(1);

    const overBytes = await handler.handleRequest('new_from_mermaid', {
      name: 'Over bytes',
      mermaidCode: `flowchart TD\nA-->B\n%%${'x'.repeat(64)}`
    });
    expect(overBytes.isError).toBe(true);
    expect(textOf(overBytes)).toContain('Mermaid import exceeds the configured byte limit');
    expect(adapter.layout).toHaveBeenCalledTimes(1);
  });

  it('accepts exact connection and density limits and rejects one over', async () => {
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn(async xml => ({ xml, warnings: [] }))
    };
    const engine = new SimpleBpmnEngine(
      directory,
      undefined,
      adapter,
      limits({ maxLayoutElements: 10, maxLayoutConnections: 3, maxLayoutDensity: 0.5 })
    );
    const context = await engine.createProcess('Connection guard');
    for (let index = 1; index <= 4; index++) {
      await engine.createElement(context.id, {
        id: `Task_${index}`,
        type: 'bpmn:Task',
        name: `Task ${index}`
      });
    }
    await engine.connect(context.id, 'Task_1', 'Task_2');
    await engine.connect(context.id, 'Task_3', 'Task_4');

    await expect(engine.applyAutoLayout(context.id)).resolves.toBeDefined();
    await engine.connect(context.id, 'Task_1', 'Task_3');
    await expect(engine.applyAutoLayout(context.id)).rejects.toThrow('connection density limit 0.5');
    expect(adapter.layout).toHaveBeenCalledTimes(1);

    const edgeLimited = new SimpleBpmnEngine(
      join(directory, 'edge-limit'),
      undefined,
      adapter,
      limits({ maxLayoutElements: 10, maxLayoutConnections: 2, maxLayoutDensity: 10 })
    );
    const edgeContext = await edgeLimited.createProcess('Edge guard');
    for (let index = 1; index <= 3; index++) {
      await edgeLimited.createElement(edgeContext.id, {
        id: `EdgeTask_${index}`,
        type: 'bpmn:Task',
        name: `Edge task ${index}`
      });
    }
    await edgeLimited.connect(edgeContext.id, 'EdgeTask_1', 'EdgeTask_2');
    await edgeLimited.connect(edgeContext.id, 'EdgeTask_2', 'EdgeTask_3');
    await expect(edgeLimited.applyAutoLayout(edgeContext.id)).resolves.toBeDefined();
    await edgeLimited.connect(edgeContext.id, 'EdgeTask_1', 'EdgeTask_3');
    await expect(edgeLimited.applyAutoLayout(edgeContext.id))
      .rejects.toThrow('connection limit 2 exceeded');
  });

  it('rejects oversized low-complexity layout XML before invoking the adapter', async () => {
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn(async xml => ({ xml, warnings: [] }))
    };
    const engine = new SimpleBpmnEngine(
      directory,
      undefined,
      adapter,
      limits({ maxLayoutBytes: 512 })
    );
    const context = await engine.createProcess('x'.repeat(1_000));
    await engine.createElement(context.id, { type: 'bpmn:Task', name: 'Only task' });

    await expect(engine.applyAutoLayout(context.id)).rejects.toThrow('byte limit 512 exceeded');
    expect(adapter.layout).not.toHaveBeenCalled();

    expect(() => assertLayoutComplexity(1, 0, 512, limits({ maxLayoutBytes: 512 })))
      .not.toThrow();
    expect(() => assertLayoutComplexity(1, 0, 513, limits({ maxLayoutBytes: 512 })))
      .toThrow('byte limit 512 exceeded');
  });

  it('terminates synchronous pathological layout work without blocking the server event loop', async () => {
    const timeoutMs = 10;
    const adapter = new BpmnAutoLayoutV2Adapter(undefined, timeoutMs);
    let eventLoopAdvanced = false;
    setTimeout(() => { eventLoopAdvanced = true; }, 0);
    const startedAt = Date.now();

    await expect(adapter.layout(denseProcessXml(100)))
      .rejects.toThrow(`bpmn-auto-layout subprocess exceeded ${timeoutMs}ms`);

    expect(eventLoopAdvanced).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('rejects layout bursts above the global subprocess concurrency cap', async () => {
    const timeoutMs = 100;
    const adapter = new BpmnAutoLayoutV2Adapter(undefined, timeoutMs, 1);
    const first = adapter.layout(denseProcessXml(30));

    await expect(adapter.layout(denseProcessXml(30)))
      .rejects.toThrow('Concurrent auto-layout limit 1 reached');
    await expect(first).rejects.toThrow(`bpmn-auto-layout subprocess exceeded ${timeoutMs}ms`);
  });

  it('paginates empty, sparse, dense, and final element pages in stable ID order', async () => {
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout)
    );
    await handler.handleRequest('new_bpmn', { name: 'Pagination' });

    // A real BPMN type that this diagram happens not to contain. The filter
    // only accepts advertised types, so an invented one is rejected outright
    // rather than silently yielding an empty page.
    const empty = ((await handler.handleRequest('list_elements', {
      elementType: 'bpmn:ExclusiveGateway',
      limit: 2,
      offset: 0
    })).structuredContent as Record<string, any>);
    expect(empty).toMatchObject({ count: 0, returnedCount: 0, hasMore: false, elements: [] });

    const unknownType = await handler.handleRequest('list_elements', {
      elementType: 'bpmn:Gateway'
    });
    expect(unknownType.isError).toBe(true);
    expect(unknownType.structuredContent).toMatchObject({ code: 'invalid_arguments' });

    for (let index = 1; index <= 4; index++) {
      await handler.handleRequest('add_activity', { activityType: 'task', name: `Task ${index}` });
    }
    for (let index = 1; index < 4; index++) {
      await handler.handleRequest('connect', {
        sourceId: `Task_${index}`,
        targetId: `Task_${index + 1}`
      });
    }

    const first = ((await handler.handleRequest('list_elements', {
      limit: 2,
      offset: 0
    })).structuredContent as Record<string, any>);
    const middle = ((await handler.handleRequest('list_elements', {
      limit: 2,
      offset: 2
    })).structuredContent as Record<string, any>);
    expect(first.elements.map((element: { id: string }) => element.id)).toEqual(['Task_1', 'Task_2']);
    expect(middle.elements.map((element: { id: string }) => element.id)).toEqual(['Task_3', 'Task_4']);
    expect([first.hasMore, middle.hasMore]).toEqual([true, false]);

    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Task 5' });
    await handler.handleRequest('connect', { sourceId: 'Task_4', targetId: 'Task_5' });
    const final = ((await handler.handleRequest('list_elements', {
      limit: 2,
      offset: 4
    })).structuredContent as Record<string, any>);
    const middleAfterGrowth = ((await handler.handleRequest('list_elements', {
      limit: 2,
      offset: 2
    })).structuredContent as Record<string, any>);
    expect(final.elements.map((element: { id: string }) => element.id)).toEqual(['Task_5']);
    expect([middleAfterGrowth.hasMore, final.hasMore]).toEqual([true, false]);

    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_3' });
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_4' });
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_5' });
    const dense = ((await handler.handleRequest('list_elements', {
      limit: 5,
      offset: 0
    })).structuredContent as Record<string, any>);
    expect(dense.elements[0]).toMatchObject({ id: 'Task_1', incoming: 0, outgoing: 4 });
    expect(dense.elements[4]).toMatchObject({ id: 'Task_5', incoming: 2, outgoing: 0 });
  });

  it('bounds and stably paginates diagram listings through the final page', async () => {
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout)
    );
    const empty = ((await handler.handleRequest('list_diagrams', {})).structuredContent as Record<string, any>);
    expect(empty).toMatchObject({ count: 0, returnedCount: 0, hasMore: false, diagrams: [] });

    for (const name of ['Zulu', 'Alpha', 'Middle']) {
      await handler.handleRequest('new_bpmn', { name });
    }
    const first = ((await handler.handleRequest('list_diagrams', {
      limit: 2,
      offset: 0
    })).structuredContent as Record<string, any>);
    const final = ((await handler.handleRequest('list_diagrams', {
      limit: 2,
      offset: 2
    })).structuredContent as Record<string, any>);
    const filenames = [...first.diagrams, ...final.diagrams]
      .map((diagram: { filename: string }) => diagram.filename);
    expect(filenames).toEqual([...filenames].sort());
    expect(first).toMatchObject({ count: 3, returnedCount: 2, hasMore: true });
    expect(final).toMatchObject({ count: 3, returnedCount: 1, hasMore: false });

    expect(() => parseToolRequest('list_elements', { limit: MAX_PAGE_LIMIT, offset: 0 }))
      .not.toThrow();
    expect(() => parseToolRequest('list_connections', {
      connectionType: 'bpmn:SequenceFlow',
      sourceId: 'Task_1',
      targetId: 'Task_2',
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      limit: MAX_PAGE_LIMIT,
      offset: 0
    })).not.toThrow();
    expect(() => parseToolRequest('list_diagrams', { limit: MAX_PAGE_LIMIT + 1, offset: 0 }))
      .toThrow(`Number must be less than or equal to ${MAX_PAGE_LIMIT}`);
  });

  it('reads metadata only for the requested stable diagram page', async () => {
    const filenames = Array.from(
      { length: 7 },
      (_, index) => `${String(index).padStart(2, '0')}-custom.bpmn`
    );
    for (const [index, filename] of filenames.entries()) {
      await fs.writeFile(
        join(directory, filename),
        `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="resource-test"><bpmn:process id="Process_${index}" name="Diagram ${index}" /></bpmn:definitions>`,
        'utf8'
      );
    }

    const engine = new SimpleBpmnEngine(directory, undefined, passthroughLayout);
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    const readSpy = jest.spyOn(fileManager, 'readBpmnFile');
    const handler = new BpmnRequestHandler(engine);

    const fourth = ((await handler.handleRequest('list_diagrams', {
      limit: 1,
      offset: 3
    })).structuredContent as Record<string, any>);
    expect(fourth).toMatchObject({
      count: 7,
      returnedCount: 1,
      hasMore: true,
      diagrams: [{ filename: filenames[3], processId: 'Process_3', name: 'Diagram 3' }]
    });
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenLastCalledWith(filenames[3], expect.any(Number));

    readSpy.mockClear();
    const fifth = ((await handler.handleRequest('list_diagrams', {
      limit: 1,
      offset: 4
    })).structuredContent as Record<string, any>);
    expect(fifth.diagrams).toEqual([
      expect.objectContaining({ filename: filenames[4], processId: 'Process_4' })
    ]);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenLastCalledWith(filenames[4], expect.any(Number));
  });

  it('accepts the exact diagram metadata byte budget and rejects one byte over', async () => {
    const metadataBudget = 512;
    const prefix = '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="resource-test"><bpmn:process id="Process_1" name="Budget" /><!--';
    const suffix = '--></bpmn:definitions>';
    const exactXml = `${prefix}${'x'.repeat(metadataBudget - Buffer.byteLength(prefix + suffix))}${suffix}`;
    expect(Buffer.byteLength(exactXml)).toBe(metadataBudget);

    const exactDirectory = join(directory, 'exact-metadata-budget');
    await fs.mkdir(exactDirectory);
    await fs.writeFile(join(exactDirectory, 'custom.bpmn'), exactXml, 'utf8');
    const exactHandler = new BpmnRequestHandler(
      new SimpleBpmnEngine(
        exactDirectory,
        undefined,
        passthroughLayout,
        limits({ maxListingMetadataBytes: metadataBudget })
      )
    );
    const exact = await exactHandler.handleRequest('list_diagrams', { limit: 1, offset: 0 });
    expect(exact.isError).toBeUndefined();
    expect((exact.structuredContent as Record<string, any>).diagrams).toEqual([
      expect.objectContaining({ filename: 'custom.bpmn', processId: 'Process_1', name: 'Budget' })
    ]);

    const overDirectory = join(directory, 'over-metadata-budget');
    await fs.mkdir(overDirectory);
    await fs.writeFile(join(overDirectory, 'custom.bpmn'), `${exactXml}x`, 'utf8');
    const overHandler = new BpmnRequestHandler(
      new SimpleBpmnEngine(
        overDirectory,
        undefined,
        passthroughLayout,
        limits({ maxListingMetadataBytes: metadataBudget })
      )
    );
    const over = await overHandler.handleRequest('list_diagrams', { limit: 1, offset: 0 });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain(`metadata byte limit ${metadataBudget} exceeded`);
  });

  it('accepts exact listing candidate caps and rejects one over', async () => {
    const resourceLimits = limits({ maxListingItems: 2 });
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout, resourceLimits),
      undefined,
      resourceLimits
    );
    await handler.handleRequest('new_bpmn', { name: 'First' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'One' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Two' });
    expect((await handler.handleRequest('list_elements', {})).isError).toBeUndefined();

    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Three' });
    const excessElements = await handler.handleRequest('list_elements', {});
    expect(excessElements.isError).toBe(true);
    expect(textOf(excessElements)).toContain('item limit 2 exceeded');

    await handler.handleRequest('new_bpmn', { name: 'Second' });
    expect((await handler.handleRequest('list_diagrams', {})).isError).toBeUndefined();
    await handler.handleRequest('new_bpmn', { name: 'Third' });
    const excessDiagrams = await handler.handleRequest('list_diagrams', {});
    expect(excessDiagrams.isError).toBe(true);
    expect(textOf(excessDiagrams)).toContain('scan limit 2 exceeded');
  });

  it('caps geometry patch size at the request boundary and diagnostic work in the engine', async () => {
    const revision = `sha256:${'a'.repeat(32)}:v1`;
    expect(() => parseToolRequest('apply_geometry_patch', {
      expectedRevision: revision,
      elementUpdates: Array.from({ length: 256 }, (_, index) => ({
        elementId: `Task_${index}`,
        bounds: { x: index, y: 0, width: 1, height: 1 }
      }))
    })).not.toThrow();
    expect(() => parseToolRequest('apply_geometry_patch', {
      expectedRevision: revision,
      elementUpdates: Array.from({ length: 257 }, (_, index) => ({
        elementId: `Task_${index}`,
        bounds: { x: index, y: 0, width: 1, height: 1 }
      }))
    })).toThrow('Array must contain at most 256 element(s)');

    const resourceLimits = limits({ maxListingItems: 1 });
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout, resourceLimits),
      undefined,
      resourceLimits
    );
    await handler.handleRequest('new_bpmn', { name: 'Bounded patch diagnostics' });
    for (const [name, x] of [['One', 100], ['Two', 400], ['Three', 700]] as const) {
      await handler.handleRequest('add_activity', {
        activityType: 'task', name, position: { x, y: 100 }
      });
    }
    const context = diagramContext.getCurrent();
    const beforeXml = context.xml;
    const rejected = await handler.handleRequest('apply_geometry_patch', {
      expectedRevision: context.revision,
      elementUpdates: [{
        elementId: 'Task_1',
        bounds: { x: 350, y: 100, width: 500, height: 80 }
      }],
      collisionPolicy: 'allow'
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('resource limit exceeded');
    expect(context.xml).toBe(beforeXml);
  });

  it('bounds route candidate validation and returns ranked resource diagnostics', async () => {
    const resourceLimits = limits({ maxLayoutElements: 1 });
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout, resourceLimits),
      undefined,
      resourceLimits
    );
    await handler.handleRequest('new_bpmn', { name: 'Bounded connection routing' });
    await handler.handleRequest('add_activity', {
      activityType: 'task', name: 'Source', position: { x: 100, y: 100 }
    });
    await handler.handleRequest('add_activity', {
      activityType: 'task', name: 'Target', position: { x: 500, y: 100 }
    });
    const connection = await handler.handleRequest('connect', {
      sourceId: 'Task_1', targetId: 'Task_2'
    });
    const connectionId = (connection.structuredContent as any).connectionId as string;
    const context = diagramContext.getCurrent();
    const beforeXml = context.xml;
    const beforeRevision = context.revision;

    const rejected = await handler.handleRequest('route_connection', { connectionId });

    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'routing_failed',
        mutated: false,
        rankedDiagnostics: [expect.objectContaining({
          rank: 1,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'RESOURCE_LIMIT_EXCEEDED' })
          ])
        })]
      }
    });
    expect(context.xml).toBe(beforeXml);
    expect(context.revision).toBe(beforeRevision);
  });

  it('caps diagram directory scans even when entries are not BPMN files', async () => {
    const scanDirectory = join(directory, 'scan-cap');
    await fs.mkdir(scanDirectory);
    const resourceLimits = limits({ maxListingItems: 2 });
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(scanDirectory, undefined, passthroughLayout, resourceLimits),
      undefined,
      resourceLimits
    );
    await fs.writeFile(join(scanDirectory, 'one.txt'), 'one');
    await fs.writeFile(join(scanDirectory, 'two.txt'), 'two');
    expect((await handler.handleRequest('list_diagrams', {})).isError).toBeUndefined();

    await fs.writeFile(join(scanDirectory, 'three.txt'), 'three');
    const rejected = await handler.handleRequest('list_diagrams', {});
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('scan limit 2 exceeded');
  });

  it('caps connection scans when element count remains small', async () => {
    const resourceLimits = limits({ maxListingItems: 2 });
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout, resourceLimits),
      undefined,
      resourceLimits
    );
    await handler.handleRequest('new_bpmn', { name: 'Connection scan cap' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'One' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Two' });
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_2' });
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_2' });
    expect((await handler.handleRequest('list_elements', {})).isError).toBeUndefined();

    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_2' });
    const rejected = await handler.handleRequest('list_elements', {});
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('connection scan limit 2 exceeded');
  });

  it('stably paginates filtered connections and enforces the connection scan cap', async () => {
    const resourceLimits = limits({ maxListingItems: 3 });
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, passthroughLayout, resourceLimits),
      undefined,
      resourceLimits
    );
    await handler.handleRequest('new_bpmn', { name: 'Connection pages' });
    for (let index = 1; index <= 3; index++) {
      await handler.handleRequest('add_activity', { activityType: 'task', name: `Task ${index}` });
    }
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_2' });
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'Task_3' });

    const first = ((await handler.handleRequest('list_connections', {
      sourceId: 'Task_1', limit: 1, offset: 0
    })).structuredContent as Record<string, any>);
    const final = ((await handler.handleRequest('list_connections', {
      sourceId: 'Task_1', limit: 1, offset: 1
    })).structuredContent as Record<string, any>);
    expect(first.connections.map((connection: { id: string }) => connection.id))
      .toEqual(['Flow_1']);
    expect(final.connections.map((connection: { id: string }) => connection.id))
      .toEqual(['Flow_2']);
    expect([first.hasMore, final.hasMore]).toEqual([true, false]);

    await handler.handleRequest('connect', { sourceId: 'Task_2', targetId: 'Task_3' });
    expect((await handler.handleRequest('list_connections', {})).isError).toBeUndefined();
    await handler.handleRequest('connect', { sourceId: 'Task_2', targetId: 'Task_3' });
    const rejected = await handler.handleRequest('list_connections', {});
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('Connection listing rejected: scan limit 3 exceeded');
  });
});
