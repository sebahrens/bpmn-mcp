import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import { FileManager } from '../../../src/utils/FileManager.js';
import { isPathContained } from '../../../src/utils/SafeFilePath.js';
import { TOOL_INPUT_LIMITS } from '../../../src/config/index.js';

describe('file operation containment', () => {
  let workspace: string;
  let diagramsRoot: string;
  let siblingRoot: string;
  let outsideBpmn: string;
  let outsideMermaid: string;
  let handler: BpmnRequestHandler;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bpmn-file-security-'));
    diagramsRoot = path.join(workspace, 'diagrams');
    siblingRoot = path.join(workspace, 'diagrams-backup');
    outsideBpmn = path.join(siblingRoot, 'outside.bpmn');
    outsideMermaid = path.join(siblingRoot, 'outside.mmd');
    await fs.mkdir(diagramsRoot);
    await fs.mkdir(siblingRoot);
    await fs.writeFile(outsideBpmn, 'outside BPMN sentinel', 'utf8');
    await fs.writeFile(outsideMermaid, 'outside Mermaid sentinel', 'utf8');
    await fs.symlink(outsideBpmn, path.join(diagramsRoot, 'linked.bpmn'));
    await fs.symlink(outsideMermaid, path.join(diagramsRoot, 'linked.mmd'));
    handler = new BpmnRequestHandler(new SimpleBpmnEngine(diagramsRoot));
    diagramContext.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    diagramContext.clear();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it.each([
    '../diagrams-backup/outside.bpmn',
    '..\\diagrams-backup\\outside.bpmn',
    'C:\\temp\\outside.bpmn',
    '\\\\server\\share\\outside.bpmn',
    '',
    '.',
    '..',
    '.bpmn',
    '..bpmn',
    'outside.txt',
    'linked.bpmn'
  ])('rejects unsafe BPMN name %p for both open and delete', async filename => {
    const openResult = await handler.handleRequest('open_bpmn', { filename });
    const deleteResult = await handler.handleRequest('delete_diagram_file', { filename });

    expect(openResult.isError).toBe(true);
    expect(deleteResult.isError).toBe(true);
    expect(openResult.content[0].text).not.toContain(workspace);
    expect(deleteResult.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
  });

  it('rejects absolute BPMN paths without disclosing the configured root', async () => {
    const openResult = await handler.handleRequest('open_bpmn', { filename: outsideBpmn });
    const deleteResult = await handler.handleRequest('delete_diagram_file', { filename: outsideBpmn });

    expect(openResult).toMatchObject({ isError: true });
    expect(deleteResult).toMatchObject({ isError: true });
    expect(openResult.content[0].text).not.toContain(workspace);
    expect(deleteResult.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
  });

  it.each([
    '../diagrams-backup/outside.mmd',
    '..\\diagrams-backup\\outside.mmd',
    'C:\\temp\\outside.mmd',
    '\\\\server\\share\\outside.mmd',
    '',
    '.',
    '..',
    '.mmd',
    '..mmd',
    'outside.bpmn',
    'linked.mmd'
  ])('rejects unsafe Mermaid name %p', async filename => {
    const result = await handler.handleRequest('open_mermaid_file', { filename });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(outsideMermaid, 'utf8')).resolves.toBe('outside Mermaid sentinel');
  });

  it('rejects absolute Mermaid paths', async () => {
    const result = await handler.handleRequest('open_mermaid_file', { filename: outsideMermaid });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(outsideMermaid, 'utf8')).resolves.toBe('outside Mermaid sentinel');
  });

  it.each([
    '../diagrams-backup/outside.bpmn',
    '..\\diagrams-backup\\outside.bpmn',
    'C:\\temp\\outside.bpmn',
    '\\\\server\\share\\outside.bpmn',
    '',
    '.',
    '..',
    '.bpmn',
    '..bpmn',
    'outside.txt',
    'linked.bpmn'
  ])('rejects unsafe save_as name %p', async filename => {
    await handler.handleRequest('new_bpmn', { name: 'Security test' });

    const result = await handler.handleRequest('save_as', { filename });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
  });

  it('rejects absolute save_as paths', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Security test' });

    const result = await handler.handleRequest('save_as', { filename: outsideBpmn });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
  });

  it('supports valid in-root BPMN and Mermaid open, save, and delete operations', async () => {
    const fixture = await fs.readFile(
      path.join(process.cwd(), 'tests/fixtures/simple-process.bpmn'),
      'utf8'
    );
    await fs.writeFile(path.join(diagramsRoot, 'valid.bpmn'), fixture, 'utf8');
    await fs.writeFile(path.join(diagramsRoot, 'valid.mmd'), 'graph TD\n  A[Start] --> B[End]', 'utf8');

    await expect(handler.handleRequest('open_bpmn', { filename: 'valid.bpmn' }))
      .resolves.not.toMatchObject({ isError: true });
    await expect(handler.handleRequest('open_mermaid_file', { filename: 'valid.mmd' }))
      .resolves.not.toMatchObject({ isError: true });
    await expect(handler.handleRequest('save_as', { filename: 'saved' }))
      .resolves.not.toMatchObject({ isError: true });
    await expect(handler.handleRequest('save', {}))
      .resolves.not.toMatchObject({ isError: true });
    await expect(fs.readFile(path.join(diagramsRoot, 'saved.bpmn'), 'utf8'))
      .resolves.toContain('bpmn:definitions');
    await expect(handler.handleRequest('delete_diagram_file', { filename: 'saved.bpmn' }))
      .resolves.not.toMatchObject({ isError: true });
    await expect(fs.access(path.join(diagramsRoot, 'saved.bpmn'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses separator-aware containment and rejects the directory-capable sibling escape', async () => {
    const fileManager = new FileManager(diagramsRoot);

    // The containment predicate is asserted directly rather than through the
    // caller-less FileManager.validatePath wrapper deleted in mcp-bpmn-iqa.13.
    expect(isPathContained(path.join(siblingRoot, 'outside.bpmn'), diagramsRoot)).toBe(false);
    await expect(fileManager.saveBpmnFile('<xml />', {
      filename: 'outside.bpmn',
      directory: siblingRoot
    })).resolves.toEqual({ success: false, error: 'Invalid save directory' });
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
  });

  it.each(['read', 'write', 'delete'] as const)(
    'anchors %s to the validated root when the configured directory is swapped',
    async operation => {
      const filename = 'race.bpmn';
      const originalRoot = path.join(workspace, 'original-diagrams');
      const outsideTarget = path.join(siblingRoot, filename);
      await fs.writeFile(path.join(diagramsRoot, filename), 'inside file', 'utf8');
      await fs.writeFile(outsideTarget, 'outside race sentinel', 'utf8');
      const run = rejectingRaceOperation(operation, filename);
      swapAfterRootStat(2, async () => {
        await fs.rename(diagramsRoot, originalRoot);
        await fs.symlink(siblingRoot, diagramsRoot, 'dir');
      });

      await run();
      await run();

      await expect(fs.readFile(outsideTarget, 'utf8')).resolves.toBe('outside race sentinel');
    }
  );

  it.each(['read', 'write', 'delete'] as const)(
    'rejects %s when the validated leaf is exchanged for an outside symlink',
    async operation => {
      const filename = 'race.bpmn';
      const insideTarget = path.join(diagramsRoot, filename);
      const outsideTarget = path.join(siblingRoot, filename);
      await fs.writeFile(insideTarget, 'inside file', 'utf8');
      await fs.writeFile(outsideTarget, 'outside race sentinel', 'utf8');
      const run = rejectingRaceOperation(operation, filename);
      swapAfterRootStat(2, async () => {
        await fs.unlink(insideTarget);
        await fs.symlink(outsideTarget, insideTarget);
      });

      await run();
      await run();

      await expect(fs.readFile(outsideTarget, 'utf8')).resolves.toBe('outside race sentinel');
    }
  );

  it('rejects a configured-root swap during canonicalization', async () => {
    const filename = 'race.bpmn';
    const originalRoot = path.join(workspace, 'original-diagrams');
    const outsideTarget = path.join(siblingRoot, filename);
    await fs.writeFile(path.join(diagramsRoot, filename), 'inside file', 'utf8');
    await fs.writeFile(outsideTarget, 'outside race sentinel', 'utf8');
    const run = rejectingRaceOperation('read', filename);
    swapAfterRootStat(1, async () => {
      await fs.rename(diagramsRoot, originalRoot);
      await fs.symlink(siblingRoot, diagramsRoot, 'dir');
    });

    await run();
    await run();

    await expect(fs.readFile(outsideTarget, 'utf8')).resolves.toBe('outside race sentinel');
  });

  it('never re-pins a workspace that a symlink replaced between operations', async () => {
    const fileManager = new FileManager(diagramsRoot);
    await expect(fileManager.saveBpmnFile('<xml />', { filename: 'pinned.bpmn' }))
      .resolves.toMatchObject({ success: true });
    await fs.rm(diagramsRoot, { recursive: true, force: true });
    await fs.symlink(siblingRoot, diagramsRoot, 'dir');

    const result = await fileManager.saveBpmnFile('replacement', {
      filename: 'outside.bpmn',
      overwrite: true
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('symbolic link');
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
    await expect(fileManager.readBpmnFile('outside.bpmn', 1024)).rejects.toThrow();
  });

  it('shares the pinned root across BPMN persistence and Mermaid opens', async () => {
    const engine = new SimpleBpmnEngine(diagramsRoot);
    const sharedHandler = new BpmnRequestHandler(engine);
    await engine.createProcess('Pin the root');
    const originalRoot = path.join(workspace, 'original-diagrams');
    await fs.writeFile(
      path.join(siblingRoot, 'outside.mmd'),
      'graph TD\n  Outside --> Secret',
      'utf8'
    );
    await fs.rename(diagramsRoot, originalRoot);
    await fs.symlink(siblingRoot, diagramsRoot, 'dir');

    const result = await sharedHandler.handleRequest('open_mermaid_file', {
      filename: 'outside.mmd'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('Outside');
    expect(result.content[0].text).not.toContain(workspace);
    await expect(fs.readFile(path.join(siblingRoot, 'outside.mmd'), 'utf8'))
      .resolves.toBe('graph TD\n  Outside --> Secret');
  });

  it('validates names and extensions before touching the filesystem', async () => {
    const missingRoot = path.join(workspace, 'missing');
    const fileManager = new FileManager(missingRoot);

    await expect(fileManager.readBpmnFile('wrong.txt', 100))
      .rejects.toThrow('File extension must be one of: .bpmn');
    await expect(fileManager.saveBpmnFile('<xml />', { filename: 'wrong.txt' }))
      .resolves.toEqual({ success: false, error: 'File extension must be one of: .bpmn' });
    await expect(fs.access(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces portable UTF-8 target and atomic temporary-name byte limits before I/O', async () => {
    const exactFilename = `${'é'.repeat(97)}a.bpmn`;
    expect(Buffer.byteLength(exactFilename, 'utf8'))
      .toBe(TOOL_INPUT_LIMITS.filename.maxUtf8Bytes);
    expect(
      Buffer.byteLength(exactFilename, 'utf8')
        + TOOL_INPUT_LIMITS.filename.maxAtomicWriteSuffixBytes
    ).toBeLessThanOrEqual(TOOL_INPUT_LIMITS.filename.maxComponentBytes);
    await expect(new FileManager(diagramsRoot).saveBpmnFile('<xml />', {
      filename: exactFilename
    })).resolves.toMatchObject({ success: true, filename: exactFilename });

    const overFilename = `${'é'.repeat(98)}.bpmn`;
    expect(Buffer.byteLength(overFilename, 'utf8'))
      .toBe(TOOL_INPUT_LIMITS.filename.maxUtf8Bytes + 1);
    const missingRoot = path.join(workspace, 'byte-limit-missing');
    await expect(new FileManager(missingRoot).saveBpmnFile('<xml />', {
      filename: overFilename
    })).resolves.toEqual({
      success: false,
      error: `Filename must not exceed ${TOOL_INPUT_LIMITS.filename.maxUtf8Bytes} UTF-8 bytes`
    });
    await expect(fs.access(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  function swapAfterRootStat(statCall: number, swap: () => Promise<void>): void {
    const stat = fs.stat.bind(fs);
    let calls = 0;
    const spy = jest.spyOn(fs, 'stat').mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      const result = await stat(...args);
      calls += 1;
      if (calls === statCall) {
        await swap();
        spy.mockRestore();
      }
      return result;
    }) as typeof fs.stat);
  }

  function rejectingRaceOperation(
    operation: 'read' | 'write' | 'delete',
    filename: string
  ): () => Promise<void> {
    const fileManager = new FileManager(diagramsRoot);
    return async () => {
      if (operation === 'read') {
        await expect(fileManager.readBpmnFile(filename, 1024)).rejects.toThrow();
        return;
      }
      if (operation === 'write') {
        await expect(fileManager.saveBpmnFile('replacement', { filename, overwrite: true }))
          .resolves.toMatchObject({ success: false });
        return;
      }
      await expect(fileManager.deleteBpmnFile(filename)).rejects.toThrow();
    };
  }
});
