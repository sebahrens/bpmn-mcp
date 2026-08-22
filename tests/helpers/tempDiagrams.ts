import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BpmnRequestHandler } from '../../src/server/handlers.js';

const DIAGRAMS_PATH_ENV = 'MCP_BPMN_DIAGRAMS_PATH';
const defaultDiagramsDirectory = join(homedir(), 'mcp-bpmn');

export interface TempDiagramsSandbox {
  directory: string;
  uniqueFilename(label: string): string;
  cleanup(): Promise<void>;
}

export interface TempHandlerSandbox extends TempDiagramsSandbox {
  handler: BpmnRequestHandler;
}

function restoreDiagramsPath(previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[DIAGRAMS_PATH_ENV];
  } else {
    process.env[DIAGRAMS_PATH_ENV] = previousValue;
  }
}

export async function createTempDiagramsDirectory(
  label: string
): Promise<TempDiagramsSandbox> {
  const directory = await mkdtemp(join(tmpdir(), `mcp-bpmn-${label}-${process.pid}-`));
  const previousDiagramsPath = process.env[DIAGRAMS_PATH_ENV];
  process.env[DIAGRAMS_PATH_ENV] = directory;

  let cleaned = false;
  return {
    directory,
    uniqueFilename: filenameLabel => (
      `${filenameLabel}-${basename(directory)}-${randomUUID()}.bpmn`
    ),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      restoreDiagramsPath(previousDiagramsPath);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export async function createTempDiagramsSandbox(
  label: string
): Promise<TempHandlerSandbox> {
  const sandbox = await createTempDiagramsDirectory(label);
  try {
    // Load modules that capture configuration only after the isolated path is set.
    const [{ BpmnRequestHandler }, { SimpleBpmnEngine }] = await Promise.all([
      import('../../src/server/handlers.js'),
      import('../../src/core/SimpleBpmnEngine.js')
    ]);
    const engine = new SimpleBpmnEngine(sandbox.directory);
    if (engine.getDiagramsPath() !== sandbox.directory) {
      throw new Error('Handler test engine did not use the isolated diagrams directory');
    }

    return {
      ...sandbox,
      handler: new BpmnRequestHandler(engine),
    };
  } catch (error) {
    await sandbox.cleanup();
    throw error;
  }
}

/**
 * Fingerprint the files these suites could previously overwrite in the user's
 * default diagrams directory without exposing their names or contents.
 */
export async function snapshotDefaultDiagramsDirectory(): Promise<string> {
  let entries;
  try {
    entries = await readdir(defaultDiagramsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }

  const hash = createHash('sha256');
  const bpmnEntries = entries
    .filter(entry => entry.name.endsWith('.bpmn'))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of bpmnEntries) {
    const entryPath = join(defaultDiagramsDirectory, entry.name);
    const stats = await lstat(entryPath);
    hash.update(entry.name);
    hash.update(stats.isFile() ? await readFile(entryPath) : `non-file:${stats.mode}`);
  }

  return `${bpmnEntries.length}:${hash.digest('hex')}`;
}
