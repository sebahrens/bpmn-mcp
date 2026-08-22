import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
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

    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Only active copy changes' });
    await expectActiveFileMatchesContext();
    await expect(fs.readFile(join(directory, generatedFilename), 'utf8'))
      .resolves.toBe(generatedSnapshot);
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
    expect(listing.diagrams.map((diagram: { filename: string }) => diagram.filename))
      .toEqual(expect.arrayContaining([generatedFilename, 'active-copy.bpmn']));

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

  it('keeps the destination unchanged and cleans up the temporary file when rename fails', async () => {
    const fileManager = new FileManager(directory);
    await expect(fileManager.saveBpmnFile('old XML', {
      filename: 'atomic.bpmn',
      overwrite: true
    })).resolves.toMatchObject({ success: true });
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));

    await expect(fileManager.saveBpmnFile('new XML', {
      filename: 'atomic.bpmn',
      overwrite: true
    })).resolves.toMatchObject({ success: false });
    await expect(fs.readFile(join(directory, 'atomic.bpmn'), 'utf8')).resolves.toBe('old XML');
    expect(await fs.readdir(directory)).toEqual(['atomic.bpmn']);
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

  it('does not clobber a save_as destination created after the existence check', async () => {
    const fileManager = new FileManager(directory);
    jest.spyOn(fs, 'link').mockImplementationOnce(async (_temporaryPath, destinationPath) => {
      await fs.writeFile(destinationPath, 'concurrent writer', 'utf8');
      throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
    });

    await expect(fileManager.saveBpmnFile('our XML', {
      filename: 'contended.bpmn',
      overwrite: false
    })).resolves.toMatchObject({ success: false });
    await expect(fs.readFile(join(directory, 'contended.bpmn'), 'utf8'))
      .resolves.toBe('concurrent writer');
    expect(await fs.readdir(directory)).toEqual(['contended.bpmn']);
  });
});
