import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BpmnImportLimits } from '../../src/config/index.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import type { ProcessContext } from '../../src/types/index.js';
import { FileManager } from '../../src/utils/FileManager.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

type EngineState = {
  processes: Map<string, ProcessContext>;
  processLocks: Map<string, Promise<void>>;
};

function engineState(engine: SimpleBpmnEngine): EngineState {
  return engine as unknown as EngineState;
}

function nearLimitProcessXml(processId: string, maxBytes: number): string {
  const prefix = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"'
    + ' targetNamespace="context-release-test">'
    + `<bpmn:process id="${processId}" name="${processId}">`
    + '<bpmn:task id="Task_1" name="';
  const suffix = '" /></bpmn:process></bpmn:definitions>';
  const paddingBytes = maxBytes - 1 - Buffer.byteLength(prefix + suffix, 'utf8');
  if (paddingBytes <= 0) throw new Error('Test byte limit is too small for BPMN fixture');
  return `${prefix}${'x'.repeat(paddingBytes)}${suffix}`;
}

describe('engine context release', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-context-release-'));
    IdGenerator.reset();
    diagramContext.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps retained contexts bounded across hundreds of near-limit opens and close', async () => {
    const maxBytes = 4 * 1024;
    const importLimits: BpmnImportLimits = {
      maxBytes,
      maxElements: 10,
      maxFlows: 10,
      maxDiElements: 10
    };
    const engine = new SimpleBpmnEngine(directory, importLimits);
    const handler = new BpmnRequestHandler(engine);
    const state = engineState(engine);
    const filenames = Array.from({ length: 200 }, (_, index) => `near-limit-${index}.bpmn`);

    for (const [index, filename] of filenames.entries()) {
      const xml = nearLimitProcessXml(`Process_${index}`, maxBytes);
      expect(Buffer.byteLength(xml, 'utf8')).toBe(maxBytes - 1);
      await fs.writeFile(join(directory, filename), xml, 'utf8');
      const opened = await handler.handleRequest('open_bpmn', { filename });
      expect(opened.isError).toBeUndefined();
      expect(state.processes.size).toBe(1);
      expect(state.processLocks.size).toBe(0);
    }

    const finalFilename = diagramContext.getCurrentInfo()?.filename;
    const closed = await handler.handleRequest('close', {});
    expect(closed.isError).toBeUndefined();
    expect(diagramContext.hasCurrent()).toBe(false);
    expect(state.processes.size).toBe(0);
    expect(state.processLocks.size).toBe(0);
    await expect(fs.access(join(directory, finalFilename!))).resolves.toBeUndefined();

    for (let index = 0; index < 50; index++) {
      const created = await handler.handleRequest('new_bpmn', { name: `Created ${index}` });
      expect(created.isError).toBeUndefined();
      expect(state.processes.size).toBe(1);
      await handler.handleRequest('close', {});
      expect(state.processes.size).toBe(0);
      expect(state.processLocks.size).toBe(0);
    }

    const reopened = await handler.handleRequest('open_bpmn', { filename: filenames[0] });
    expect(reopened.isError).toBeUndefined();
    expect(diagramContext.getCurrent().elements.get('Task_1')?.name?.length)
      .toBeGreaterThan(maxBytes - 512);
    expect(state.processes.size).toBe(1);
    const firstReopen = diagramContext.getCurrent();
    await handler.handleRequest('open_bpmn', { filename: filenames[0] });
    expect(diagramContext.getCurrent()).not.toBe(firstReopen);
    expect(state.processes.size).toBe(1);
    await handler.handleRequest('close', {});
    expect(state.processes.size).toBe(0);
    expect(state.processLocks.size).toBe(0);
  });

  it('drains queued work and rejects operations queued behind release', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.createProcess('Release ordering');
    const state = engineState(engine);
    const fileManager = (engine as unknown as { fileManager: FileManager }).fileManager;
    const save = fileManager.saveBpmnFile.bind(fileManager);
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
    const writeBlocked = new Promise<void>(resolve => { releaseWrite = resolve; });
    jest.spyOn(fileManager, 'saveBpmnFile').mockImplementationOnce(async (...args) => {
      markWriteStarted();
      await writeBlocked;
      return save(...args);
    });

    const inFlight = engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Finishes before release'
    });
    await writeStarted;
    const release = engine.releaseProcess(context);
    const queuedAfterRelease = engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Must not run after release'
    });
    const readQueuedAfterRelease = engine.exportXml(context.id);

    releaseWrite();
    await expect(inFlight).resolves.toMatchObject({ name: 'Finishes before release' });
    await expect(release).resolves.toBeUndefined();
    await expect(queuedAfterRelease).rejects.toThrow(`Process ${context.id} not found`);
    await expect(readQueuedAfterRelease).rejects.toThrow(`Process ${context.id} not found`);
    expect(() => engine.getProcess(context.id)).toThrow(`Process ${context.id} not found`);
    expect(state.processLocks.size).toBe(0);
    const persisted = await fs.readFile(join(directory, context.filename!), 'utf8');
    expect(persisted).toContain('Finishes before release');
    expect(persisted).not.toContain('Must not run after release');
  });

  it('deletes every retained context that references the removed file', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const first = await engine.createProcess('First reference');
    const second = await engine.createProcess('Second reference');
    const filename = first.filename!;
    second.filename = filename;

    await engine.deleteDiagram(filename);

    expect(() => engine.getProcess(first.id)).toThrow(`Process ${first.id} not found`);
    expect(() => engine.getProcess(second.id)).toThrow(`Process ${second.id} not found`);
    expect(engineState(engine).processes.size).toBe(0);
    expect(engineState(engine).processLocks.size).toBe(0);
    await expect(fs.access(join(directory, filename))).rejects.toThrow();
  });
});
