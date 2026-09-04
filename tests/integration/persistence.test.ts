import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DocumentRevisionConflictError,
  SimpleBpmnEngine
} from '../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import { FileManager } from '../../src/utils/FileManager.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

function textOf(result: Awaited<ReturnType<BpmnRequestHandler['handleRequest']>>): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('Expected text result');
  return content.text;
}

describe('transactional diagram persistence', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;
  let handler: BpmnRequestHandler;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-persistence-'));
    IdGenerator.reset();
    diagramContext.clear();
    engine = new SimpleBpmnEngine(directory);
    handler = new BpmnRequestHandler(engine);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function expectActiveFileMatchesContext(): Promise<void> {
    const context = diagramContext.getCurrent();
    expect(context.filename).toBeDefined();
    await expect(fs.readFile(join(directory, context.filename!), 'utf8'))
      .resolves.toBe(context.xml);
  }

  it('autosaves add, connect, update, and delete through one active file', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Autosave contract' });
    await expectActiveFileMatchesContext();

    await handler.handleRequest('add_event', { eventType: 'start', name: 'Start' });
    await expectActiveFileMatchesContext();
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Before' });
    await expectActiveFileMatchesContext();
    await handler.handleRequest('connect', { sourceId: 'StartEvent_1', targetId: 'Task_1' });
    await expectActiveFileMatchesContext();

    const update = await handler.handleRequest('update_element', {
      elementId: 'Task_1',
      name: 'After'
    });
    expect(update.isError).toBeUndefined();
    await expectActiveFileMatchesContext();
    expect(diagramContext.getCurrent().xml).toContain('name="After"');

    const layout = await handler.handleRequest('auto_layout', {});
    expect(layout.isError).toBeUndefined();
    await expectActiveFileMatchesContext();

    const deletion = await handler.handleRequest('delete_element', { elementId: 'Task_1' });
    expect(deletion.isError).toBeUndefined();
    await expectActiveFileMatchesContext();
    expect(diagramContext.getCurrent().xml).not.toContain('Task_1');
    expect(diagramContext.getCurrent().xml).not.toContain('Flow_1');
  });

  it('switches save_as to the only active filename and reopens, lists, and deletes that file', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Save as contract' });
    const context = diagramContext.getCurrent();
    const generatedFilename = context.filename!;
    const generatedSnapshot = context.xml!;

    await fs.writeFile(join(directory, 'occupied.bpmn'), 'existing file', 'utf8');
    const rejectedSaveAs = await handler.handleRequest('save_as', { filename: 'occupied.bpmn' });
    expect(rejectedSaveAs.isError).toBe(true);
    expect(context.filename).toBe(generatedFilename);
    await expect(fs.readFile(join(directory, 'occupied.bpmn'), 'utf8')).resolves.toBe('existing file');

    const savedAs = await handler.handleRequest('save_as', { filename: 'active-copy' });
    expect(savedAs.isError).toBeUndefined();
    expect(context.filename).toBe('active-copy.bpmn');
    await expectActiveFileMatchesContext();
    // The generated name was a server placeholder for this same diagram, so
    // save_as takes it with it rather than leaving a stale duplicate behind
    // (mcp-bpmn-8u0.2). A filename the caller chose is never removed.
    expect(savedAs.structuredContent).toMatchObject({
      previousFilename: generatedFilename,
      removedPreviousFile: true
    });
    await expect(fs.access(join(directory, generatedFilename))).rejects.toThrow();

    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Only active copy changes' });
    await expectActiveFileMatchesContext();
    expect(context.xml).not.toBe(generatedSnapshot);

    const save = await handler.handleRequest('save', {});
    expect(save.isError).toBeUndefined();
    await handler.handleRequest('close', {});
    const reopened = await handler.handleRequest('open_bpmn', { filename: 'active-copy.bpmn' });
    expect(reopened.isError).toBeUndefined();
    expect(diagramContext.getCurrentInfo()?.filename).toBe('active-copy.bpmn');
    await expectActiveFileMatchesContext();

    const listed = await handler.handleRequest('list_diagrams', {});
    const listing = JSON.parse(textOf(listed));
    const listedFilenames = listing.diagrams
      .map((diagram: { filename: string }) => diagram.filename);
    expect(listedFilenames).toEqual(expect.arrayContaining(['active-copy.bpmn']));
    expect(listedFilenames).not.toContain(generatedFilename);

    const deleted = await handler.handleRequest('delete_diagram_file', { filename: 'active-copy.bpmn' });
    expect(deleted.isError).toBeUndefined();
    await expect(fs.access(join(directory, 'active-copy.bpmn'))).rejects.toThrow();
    expect(textOf(await handler.handleRequest('current', {}))).toBe('No current diagram');
    expect(() => engine.getProcess(context.id)).toThrow('not found');
  });

  it('rolls back model and XML when serialization fails', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Serialization rollback' });
    const context = diagramContext.getCurrent();
    const beforeXml = context.xml;
    const beforeRevision = context.revision;
    const beforeDisk = await fs.readFile(join(directory, context.filename!), 'utf8');
    const serializer = (engine as unknown as {
      serializer: { serialize: (...args: unknown[]) => Promise<string> };
    }).serializer;
    jest.spyOn(serializer, 'serialize').mockRejectedValueOnce(new Error('injected serialization failure'));

    const result = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Must roll back'
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('injected serialization failure');
    expect(context.elements.size).toBe(0);
    expect(context.xml).toBe(beforeXml);
    expect(context.revision).toBe(beforeRevision);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);
  });

  it('rolls back model and leaves the previous file intact when writing fails', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Write rollback' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Before' });
    const context = diagramContext.getCurrent();
    const beforeXml = context.xml;
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    jest.spyOn(fileManager, 'saveBpmnFile').mockResolvedValueOnce({
      success: false,
      error: 'injected write failure'
    });

    const result = await handler.handleRequest('update_element', {
      elementId: 'Task_1',
      name: 'Must roll back'
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('injected write failure');
    expect(context.elements.get('Task_1')?.name).toBe('Before');
    expect(context.xml).toBe(beforeXml);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeXml);
  });

  it('rolls back connection geometry and leaves the previous file intact when writing fails', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Connection geometry rollback' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Source' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Target' });
    const connected = await handler.handleRequest('connect', {
      sourceId: 'Task_1', targetId: 'Task_2'
    });
    const connectionId = (connected.structuredContent as any).connectionId as string;
    const context = diagramContext.getCurrent();
    const edge = Array.from(context.document.diagram.edges.values()).find(
      candidate => candidate.connectionId === connectionId
    )!;
    const beforeXml = context.xml;
    const beforeRevision = context.revision;
    const beforeWaypoints = structuredClone(edge.waypoints);
    const beforeDisk = await fs.readFile(join(directory, context.filename!), 'utf8');
    const midpoint = {
      x: (beforeWaypoints[0].x + beforeWaypoints[1].x) / 2,
      y: (beforeWaypoints[0].y + beforeWaypoints[1].y) / 2
    };
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    jest.spyOn(fileManager, 'saveBpmnFile').mockResolvedValueOnce({
      success: false,
      error: 'injected connection geometry failure'
    });

    const result = await handler.handleRequest('update_connection_geometry', {
      connectionId,
      waypoints: [beforeWaypoints[0], midpoint, beforeWaypoints[1]],
      collisionPolicy: 'allow'
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('injected connection geometry failure');
    expect(context.connections.get(connectionId)?.waypoints).toEqual(beforeWaypoints);
    expect(edge.waypoints).toEqual(beforeWaypoints);
    expect(context.xml).toBe(beforeXml);
    expect(context.revision).toBe(beforeRevision);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);
  });

  it('rolls back a rewired default connection completely when writing fails', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Connection rewire rollback' });
    await handler.handleRequest('add_activity', {
      activityType: 'task', name: 'Old source', position: { x: 100, y: 100 }
    });
    await handler.handleRequest('add_activity', {
      activityType: 'task', name: 'Old target', position: { x: 350, y: 100 }
    });
    const context = diagramContext.getCurrent();
    const subprocessResult = await handler.handleRequest('add_activity', {
      activityType: 'subProcess', name: 'Nested scope', position: { x: 500, y: 250 }
    });
    const subprocessId = (subprocessResult.structuredContent as any).elementId as string;
    const newSourceResult = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'New source',
      ownerId: context.id,
      scopeId: subprocessId,
      position: { x: 550, y: 300 }
    });
    const newSourceId = (newSourceResult.structuredContent as any).elementId as string;
    const newTargetResult = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'New target',
      ownerId: context.id,
      scopeId: subprocessId,
      position: { x: 700, y: 300 }
    });
    const newTargetId = (newTargetResult.structuredContent as any).elementId as string;
    const connected = await handler.handleRequest('connect', {
      sourceId: 'Task_1', targetId: 'Task_2', label: 'Before', isDefault: true
    });
    const connectionId = (connected.structuredContent as any).connectionId as string;
    const details = (await handler.handleRequest('get_connection', {
      connectionId
    })).structuredContent as any;
    const beforeXml = context.xml;
    const beforeRevision = context.revision;
    const beforeConnection = structuredClone(context.connections.get(connectionId));
    const edge = Array.from(context.document.diagram.edges.values()).find(
      candidate => candidate.connectionId === connectionId
    )!;
    const beforeEdge = structuredClone(edge);
    const beforeDisk = await fs.readFile(join(directory, context.filename!), 'utf8');
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    jest.spyOn(fileManager, 'saveBpmnFile').mockResolvedValueOnce({
      success: false,
      error: 'injected connection rewire failure'
    });

    const result = await handler.handleRequest('update_connection', {
      connectionId,
      sourceId: newSourceId,
      targetId: newTargetId,
      endpointPolicy: 'snap-to-boundary',
      collisionPolicy: 'allow',
      expectedSemanticRevision: details.semanticRevision
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('injected connection rewire failure');
    expect(context.connections.get(connectionId)).toEqual(beforeConnection);
    expect(context.connections.get(connectionId)).toMatchObject({
      source: 'Task_1',
      target: 'Task_2',
      ownerId: context.id,
      scopeId: context.id
    });
    expect(context.elements.get('Task_1')?.defaultFlow).toBe(connectionId);
    expect(context.elements.get(newSourceId)?.defaultFlow).toBeUndefined();
    expect(edge).toEqual(beforeEdge);
    expect(context.xml).toBe(beforeXml);
    expect(context.revision).toBe(beforeRevision);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);
  });

  it('rolls back connection deletion and default ownership when writing fails', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Connection delete rollback' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Source' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Target' });
    await handler.handleRequest('connect', {
      sourceId: 'Task_1',
      targetId: 'Task_2',
      isDefault: true
    });
    const context = diagramContext.getCurrent();
    const beforeXml = context.xml;
    const beforeConnections = structuredClone(Array.from(context.connections.entries()));
    const beforeDisk = await fs.readFile(join(directory, context.filename!), 'utf8');
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    jest.spyOn(fileManager, 'saveBpmnFile').mockResolvedValueOnce({
      success: false,
      error: 'injected connection delete failure'
    });

    const result = await handler.handleRequest('delete_element', { elementId: 'Flow_1' });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Error: injected connection delete failure' }],
      isError: true,
      // An injected fault is genuinely unclassifiable, and is reported as such
      // rather than being given a confidently wrong code.
      structuredContent: { code: 'unexpected_error' }
    });
    expect(Array.from(context.connections.entries())).toEqual(beforeConnections);
    expect(context.elements.get('Task_1')?.defaultFlow).toBe('Flow_1');
    expect(context.elements.has('Task_1')).toBe(true);
    expect(context.elements.has('Task_2')).toBe(true);
    expect(context.xml).toBe(beforeXml);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);
  });

  it('commits an associated text annotation and its association in one write', async () => {
    const context = await engine.createProcess('Atomic annotation');
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Annotated task'
    });
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    const save = fileManager.saveBpmnFile.bind(fileManager);
    const saveSpy = jest.spyOn(fileManager, 'saveBpmnFile').mockImplementation(save);

    const { annotation, association } = await engine.addTextAnnotation(context.id, 'Review this', {
      associatedElementId: task.id
    });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(context.elements.get(annotation.id)).toBe(annotation);
    expect(context.connections.get(association!.id)).toBe(association);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(context.xml);

    const reopened = await new SimpleBpmnEngine(directory).loadDiagram(context.filename!);
    expect(reopened.elements.has(annotation.id)).toBe(true);
    expect(reopened.connections.has(association!.id)).toBe(true);
  });

  it.each(['serialization', 'write'] as const)(
    'rolls back an associated text annotation when %s fails',
    async failurePoint => {
      const context = await engine.createProcess(`Atomic annotation ${failurePoint}`);
      const task = await engine.createElement(context.id, {
        type: 'bpmn:Task',
        name: 'Unchanged task'
      });
      const beforeXml = context.xml;

      if (failurePoint === 'serialization') {
        const serializer = (engine as unknown as {
          serializer: { serialize: (...args: unknown[]) => Promise<string> };
        }).serializer;
        jest.spyOn(serializer, 'serialize').mockRejectedValueOnce(
          new Error('injected annotation serialization failure')
        );
      } else {
        const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
        jest.spyOn(fileManager, 'saveBpmnFile').mockResolvedValueOnce({
          success: false,
          error: 'injected annotation write failure'
        });
      }

      await expect(engine.addTextAnnotation(context.id, 'Must roll back', {
        associatedElementId: task.id
      })).rejects.toThrow(`injected annotation ${failurePoint} failure`);

      expect(Array.from(context.elements.values()).filter(
        element => element.type === 'bpmn:TextAnnotation'
      )).toHaveLength(0);
      expect(Array.from(context.connections.values()).filter(
        connection => connection.type === 'bpmn:Association'
      )).toHaveLength(0);
      expect(context.xml).toBe(beforeXml);
      await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeXml);

      const reopened = await new SimpleBpmnEngine(directory).loadDiagram(context.filename!);
      expect(Array.from(reopened.elements.values()).filter(
        element => element.type === 'bpmn:TextAnnotation'
      )).toHaveLength(0);
      expect(Array.from(reopened.connections.values()).filter(
        connection => connection.type === 'bpmn:Association'
      )).toHaveLength(0);
    }
  );

  it('keeps the destination unchanged and cleans up temporary output when staging fails', async () => {
    const fileManager = new FileManager(directory);
    const filename = `${'a'.repeat(245)}.bpmn`;
    await fs.writeFile(join(directory, filename), 'old XML', 'utf8');

    await expect(fileManager.saveBpmnFile('new XML', {
      filename,
      overwrite: true
    })).resolves.toMatchObject({ success: false });
    await expect(fs.readFile(join(directory, filename), 'utf8')).resolves.toBe('old XML');
    expect(await fs.readdir(directory)).toEqual([filename]);
  });

  it('serializes concurrent mutations without losing state or diverging from disk', async () => {
    const context = await engine.createProcess('Concurrent commits');
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    const save = fileManager.saveBpmnFile.bind(fileManager);
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>(resolve => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteBlocked = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    jest.spyOn(fileManager, 'saveBpmnFile').mockImplementation(async (...args) => {
      writeCount += 1;
      if (writeCount === 1) {
        markFirstWriteStarted();
        await firstWriteBlocked;
      }
      return save(...args);
    });

    const first = engine.createElement(context.id, { type: 'bpmn:Task', name: 'First' });
    await firstWriteStarted;
    const second = engine.createElement(context.id, { type: 'bpmn:Task', name: 'Second' });
    releaseFirstWrite();
    const [firstElement, secondElement] = await Promise.all([first, second]);

    expect(context.elements.size).toBe(2);
    expect(firstElement.position.x).not.toBe(secondElement.position.x);
    expect(context.xml).toContain('name="First"');
    expect(context.xml).toContain('name="Second"');
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(context.xml);
  });

  it('atomically selects one winner for concurrent no-clobber saves', async () => {
    const firstManager = new FileManager(directory);
    const secondManager = new FileManager(directory);
    const [first, second] = await Promise.all([
      firstManager.saveBpmnFile('first writer', {
        filename: 'contended.bpmn',
        overwrite: false
      }),
      secondManager.saveBpmnFile('second writer', {
        filename: 'contended.bpmn',
        overwrite: false
      })
    ]);
    const winner = first.success ? first : second;
    const loser = first.success ? second : first;

    expect(winner).toMatchObject({ success: true, filename: 'contended.bpmn' });
    expect(loser).toEqual({
      success: false,
      error: 'File already exists: contended.bpmn. Use overwrite option to replace.'
    });
    await expect(fs.readFile(join(directory, 'contended.bpmn'), 'utf8'))
      .resolves.toBe(first.success ? 'first writer' : 'second writer');
    expect(await fs.readdir(directory)).toEqual(['contended.bpmn']);
  });

  it('keeps a populated new_bpmn file unchanged across a full engine restart', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Restart-safe process' });
    await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Must survive restart'
    });
    const first = diagramContext.getCurrent();
    const firstFilename = first.filename!;
    const firstBytes = await fs.readFile(join(directory, firstFilename));

    diagramContext.clear();
    IdGenerator.reset();
    const restartedEngine = new SimpleBpmnEngine(directory);
    const restartedHandler = new BpmnRequestHandler(restartedEngine);
    const created = await restartedHandler.handleRequest('new_bpmn', {
      name: 'Restart-safe process'
    });
    const second = diagramContext.getCurrent();

    expect(created.isError).toBeUndefined();
    expect(second.id).toBe(first.id);
    expect(second.filename).not.toBe(firstFilename);
    await expect(fs.readFile(join(directory, firstFilename))).resolves.toEqual(firstBytes);

    const reopened = await restartedEngine.loadDiagram(firstFilename);
    expect(Array.from(reopened.elements.values()).map(element => element.name))
      .toContain('Must survive restart');
    await expect(restartedEngine.listDiagrams()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: firstFilename, processId: first.id }),
      expect.objectContaining({ filename: second.filename, processId: second.id })
    ]));
  });

  it('keeps the first Mermaid-created file unchanged across a full engine restart', async () => {
    const args = {
      name: 'Restart-safe Mermaid',
      mermaidCode: 'flowchart TD\n  A[Start] --> B[Finish]'
    };
    await handler.handleRequest('new_from_mermaid', args);
    const first = diagramContext.getCurrent();
    const firstFilename = first.filename!;
    const firstBytes = await fs.readFile(join(directory, firstFilename));

    diagramContext.clear();
    IdGenerator.reset();
    const restartedEngine = new SimpleBpmnEngine(directory);
    const restartedHandler = new BpmnRequestHandler(restartedEngine);
    const created = await restartedHandler.handleRequest('new_from_mermaid', args);
    const second = diagramContext.getCurrent();

    expect(created.isError).toBeUndefined();
    expect(second.id).toBe(first.id);
    expect(second.filename).not.toBe(firstFilename);
    await expect(fs.readFile(join(directory, firstFilename))).resolves.toEqual(firstBytes);

    const reopened = await restartedEngine.loadDiagram(firstFilename);
    expect(reopened.elements.size).toBe(2);
    expect(reopened.connections.size).toBe(1);
    await expect(restartedEngine.listDiagrams()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: firstFilename, processId: first.id }),
      expect.objectContaining({ filename: second.filename, processId: second.id })
    ]));
  });

  it('persists concurrent same-name creations from independent engines as distinct files', async () => {
    const firstEngine = new SimpleBpmnEngine(directory);
    const secondEngine = new SimpleBpmnEngine(directory);

    const [first, second] = await Promise.all([
      firstEngine.createProcess('Concurrent same name'),
      secondEngine.createProcess('Concurrent same name')
    ]);

    expect(second.id).not.toBe(first.id);
    expect(second.filename).not.toBe(first.filename);
    await expect(fs.readdir(directory)).resolves.toEqual(expect.arrayContaining([
      first.filename,
      second.filename
    ]));
  });

  it('rejects an initial filename collision without adopting or replacing state', async () => {
    jest.spyOn(IdGenerator, 'generateUuid').mockReturnValue('fixed-storage-id');
    const first = await engine.createProcess('Reserved import');
    const firstBytes = await fs.readFile(join(directory, first.filename!));
    IdGenerator.reset();
    const competingEngine = new SimpleBpmnEngine(directory);

    await expect(competingEngine.createProcess('Reserved import')).rejects.toThrow(
      `File already exists: ${first.filename}. Use overwrite option to replace.`
    );
    await expect(fs.readFile(join(directory, first.filename!))).resolves.toEqual(firstBytes);
    expect(() => competingEngine.getProcess(first.id)).toThrow(`Process ${first.id} not found`);
  });

  it('exposes stable query revisions and before/after mutation revisions', async () => {
    const created = await handler.handleRequest('new_bpmn', { name: 'Revision contract' });
    const createdRevision = (created.structuredContent as { revision: string }).revision;
    expect(createdRevision).toMatch(/^sha256:[a-f0-9]{64}:v1$/);

    const firstCurrent = await handler.handleRequest('current', {});
    const secondCurrent = await handler.handleRequest('current', {});
    expect(firstCurrent.structuredContent).toEqual(secondCurrent.structuredContent);
    expect((firstCurrent.structuredContent as any).diagram.revision).toBe(createdRevision);

    const added = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Revisioned',
      expectedRevision: createdRevision
    });
    expect(added.structuredContent).toMatchObject({
      beforeRevision: createdRevision,
      afterRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}:v2$/)
    });
    const afterRevision = (added.structuredContent as any).afterRevision;
    expect((await handler.handleRequest('list_elements', {})).structuredContent)
      .toMatchObject({ revision: afterRevision });
    expect((await handler.handleRequest('get_element', { elementId: 'Task_1' })).structuredContent)
      .toMatchObject({ revision: afterRevision });
  });

  it('rejects external edits without changing memory and supports explicit revision recovery', async () => {
    await handler.handleRequest('new_bpmn', { name: 'External conflict' });
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const beforeXml = context.xml;
    const externalXml = beforeXml!.replace('External conflict', 'External winner');
    await fs.writeFile(join(directory, context.filename!), externalXml, 'utf8');

    const conflict = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Rejected',
      expectedRevision: beforeRevision
    });
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'revision_conflict',
        conflict: true,
        reason: 'external_change',
        expectedRevision: beforeRevision,
        actualRevision: expect.any(String)
      }
    });
    expect(context.revision).toBe(beforeRevision);
    expect(context.xml).toBe(beforeXml);
    expect(context.elements.size).toBe(0);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(externalXml);

    const actualRevision = (conflict.structuredContent as any).actualRevision;
    const recovered = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Explicit overwrite',
      expectedRevision: actualRevision
    });
    expect(recovered.isError).toBeUndefined();
    expect(recovered.structuredContent).toMatchObject({
      beforeRevision,
      afterRevision: expect.any(String)
    });
    expect(Array.from(context.elements.values()).map(element => element.name))
      .toContain('Explicit overwrite');
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(context.xml);
  });

  it('prevents stale independent engines from silently overwriting the same file', async () => {
    const seed = await engine.createProcess('Independent sessions');
    const filename = seed.filename!;
    const firstEngine = new SimpleBpmnEngine(directory);
    const secondEngine = new SimpleBpmnEngine(directory);
    const first = await firstEngine.loadDiagram(filename);
    const second = await secondEngine.loadDiagram(filename);
    expect(first.revision).toBe(second.revision);

    await firstEngine.createElement(first.id, {
      type: 'bpmn:Task', name: 'First writer'
    }, first.revision);
    const winnerBytes = await fs.readFile(join(directory, filename), 'utf8');
    const secondMemory = second.xml;

    await expect(secondEngine.createElement(second.id, {
      type: 'bpmn:Task', name: 'Stale writer'
    }, second.revision)).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    expect(second.elements.size).toBe(0);
    expect(second.xml).toBe(secondMemory);
    await expect(fs.readFile(join(directory, filename), 'utf8')).resolves.toBe(winnerBytes);
  });

  it('allows only one independent save_as writer to claim a new target', async () => {
    const seed = await engine.createProcess('Save as race');
    const originalBytes = await fs.readFile(join(directory, seed.filename!), 'utf8');
    const firstEngine = new SimpleBpmnEngine(directory);
    const secondEngine = new SimpleBpmnEngine(directory);
    const first = await firstEngine.loadDiagram(seed.filename!);
    const second = await secondEngine.loadDiagram(seed.filename!);

    const outcomes = await Promise.allSettled([
      firstEngine.saveAs(first.id, 'shared-target.bpmn', first.revision),
      secondEngine.saveAs(second.id, 'shared-target.bpmn', second.revision)
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    await expect(fs.readFile(join(directory, seed.filename!), 'utf8')).resolves.toBe(originalBytes);
    await expect(fs.readFile(join(directory, 'shared-target.bpmn'), 'utf8'))
      .resolves.toBe(originalBytes);
  });
});
