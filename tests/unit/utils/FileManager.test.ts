import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  BpmnFileTooLargeError,
  FileManager,
  MermaidFileTooLargeError
} from '../../../src/utils/FileManager.js';

describe('FileManager behavior matrix', () => {
  let root: string;
  let fileManager: FileManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bpmn-file-manager-'));
    fileManager = new FileManager(root);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('normalizes generated filenames and keeps path validation separator-aware', () => {
    const filename = fileManager.generateDefaultFilename('Order / Intake...');

    expect(filename).toMatch(/^Order___Intake_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z\.bpmn$/);
    expect(fileManager.sanitizeFilename('../unsafe name')).toBe('_unsafe_name');
    expect(fileManager.validatePath(path.join(root, 'inside.bpmn'), root)).toBe(true);
    expect(fileManager.validatePath(`${root}-sibling/outside.bpmn`, root)).toBe(false);
  });

  it('saves, reads, lists, and reports metadata inside its unique temporary root', async () => {
    const xml = '<bpmn:process id="Process_1" name="Order Intake" />';
    const saved = await fileManager.saveBpmnFile(xml);

    expect(saved).toMatchObject({ success: true, filename: expect.stringMatching(/\.bpmn$/) });
    expect(saved.filePath).toBe(path.join(await fs.realpath(root), saved.filename!));
    await expect(fileManager.readBpmnFile(saved.filename!, Buffer.byteLength(xml)))
      .resolves.toBe(xml);
    await expect(fileManager.listBpmnFiles()).resolves.toEqual([saved.filename]);
    const fileInfo = await fileManager.getFileInfo(saved.filePath!);
    expect(fileInfo).toMatchObject({
      exists: true,
      size: Buffer.byteLength(xml)
    });
    expect(Number.isFinite(fileInfo.modified?.getTime())).toBe(true);
    await expect(fileManager.getFileInfo(path.join(root, 'missing.bpmn')))
      .resolves.toEqual({ exists: false });
  });

  it('preserves an existing destination unless overwrite is explicitly enabled', async () => {
    await expect(fileManager.saveBpmnFile('first', { filename: 'stable' }))
      .resolves.toMatchObject({ success: true, filename: 'stable.bpmn' });

    await expect(fileManager.saveBpmnFile('second', { filename: 'stable.bpmn' }))
      .resolves.toEqual({
        success: false,
        error: 'File already exists: stable.bpmn. Use overwrite option to replace.'
      });
    await expect(fs.readFile(path.join(root, 'stable.bpmn'), 'utf8')).resolves.toBe('first');

    await expect(fileManager.saveBpmnFile('replacement', {
      filename: 'stable.bpmn',
      overwrite: true
    })).resolves.toMatchObject({ success: true });
    await expect(fs.readFile(path.join(root, 'stable.bpmn'), 'utf8')).resolves.toBe('replacement');
  });

  it('rejects an overlong atomic output before staging and leaves the previous file intact', async () => {
    const filename = `${'a'.repeat(245)}.bpmn`;
    await fs.writeFile(path.join(root, filename), 'previous', 'utf8');

    await expect(fileManager.saveBpmnFile('next', {
      filename,
      overwrite: true
    })).resolves.toEqual({
      success: false,
      error: 'Filename must not exceed 200 UTF-8 bytes'
    });
    await expect(fs.readFile(path.join(root, filename), 'utf8')).resolves.toBe('previous');
    await expect(fs.readdir(root)).resolves.toEqual([filename]);
  });

  it('enforces independent BPMN and Mermaid byte and extension policies', async () => {
    await fs.writeFile(path.join(root, 'diagram.bpmn'), '<xml />', 'utf8');
    await fs.writeFile(path.join(root, 'diagram.mmd'), 'A --> B', 'utf8');

    await expect(fileManager.readBpmnFile('diagram.bpmn', 6))
      .rejects.toBeInstanceOf(BpmnFileTooLargeError);
    await expect(fileManager.readMermaidFile('diagram.mmd', 6))
      .rejects.toBeInstanceOf(MermaidFileTooLargeError);
    await expect(fileManager.readBpmnFile('diagram.mmd', 100))
      .rejects.toThrow('File extension must be one of: .bpmn');
    await expect(fileManager.readMermaidFile('diagram.bpmn', 100))
      .rejects.toThrow('File extension must be one of: .mmd, .mermaid, .txt');
    await expect(fileManager.readBpmnFile('diagram.bpmn', 0))
      .rejects.toThrow('Invalid file import byte limit');
  });

  it('filters and deterministically orders directory listings', async () => {
    await Promise.all([
      fs.writeFile(path.join(root, 'a.bpmn'), 'a'),
      fs.writeFile(path.join(root, 'z.bpmn'), 'z'),
      fs.writeFile(path.join(root, 'ignored.txt'), 'text')
    ]);

    await expect(fileManager.listBpmnFiles()).resolves.toEqual(['z.bpmn', 'a.bpmn']);

    const nestedRoot = path.join(root, 'new-directory');
    const nestedManager = new FileManager(nestedRoot);
    await expect(nestedManager.listBpmnFiles()).resolves.toEqual([]);
    expect((await fs.stat(nestedRoot)).isDirectory()).toBe(true);
  });
});
