import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import { FileManager } from '../../../src/utils/FileManager.js';
import { resolveSafeFilePath } from '../../../src/utils/SafeFilePath.js';

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

    expect(fileManager.validatePath(path.join(siblingRoot, 'outside.bpmn'), diagramsRoot)).toBe(false);
    await expect(fileManager.saveBpmnFile('<xml />', {
      filename: 'outside.bpmn',
      directory: siblingRoot
    })).resolves.toEqual({ success: false, error: 'Invalid save directory' });
    await expect(fs.readFile(outsideBpmn, 'utf8')).resolves.toBe('outside BPMN sentinel');
  });

  it('validates names and extensions before touching the filesystem', async () => {
    const missingRoot = path.join(workspace, 'missing');
    const fileManager = new FileManager(missingRoot);

    await expect(resolveSafeFilePath({
      rootDirectory: missingRoot,
      filename: 'wrong.txt',
      allowedExtensions: ['.bpmn'],
      access: 'read'
    })).rejects.toThrow('File extension must be one of: .bpmn');
    await expect(fileManager.saveBpmnFile('<xml />', { filename: 'wrong.txt' }))
      .resolves.toEqual({ success: false, error: 'File extension must be one of: .bpmn' });
    await expect(fs.access(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
