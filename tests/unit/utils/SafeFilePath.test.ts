import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  COMPARE_WRITE_LOCK_PREFIX,
  SafeFileStore,
  SafeFilePathError
} from '../../../src/utils/SafeFilePath.js';

interface InspectableSafeFileStore {
  worker?: {
    child?: {
      pid?: number;
      kill(): boolean;
    };
  };
}

/** The compare-and-write lock the worker takes for one managed filename. */
function lockDirectory(root: string, filename: string): string {
  return path.join(
    root,
    COMPARE_WRITE_LOCK_PREFIX + createHash('sha256').update(filename).digest('hex')
  );
}

/** A process id that has already exited, as a crashed worker would leave behind. */
function exitedPid(): number {
  const exited = spawnSync(process.execPath, ['-e', '']);
  if (typeof exited.pid !== 'number') throw new Error('Unable to spawn a probe process');
  return exited.pid;
}

async function writeOwnerRecord(
  lock: string,
  record: { uuid: string; pid: number; host: string; time: number }
): Promise<void> {
  await fs.mkdir(lock, { mode: 0o700 });
  await fs.writeFile(path.join(lock, 'owner'), JSON.stringify(record), { mode: 0o600 });
}

describe('SafeFileStore worker lifecycle', () => {
  let root: string;
  let store: SafeFileStore;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bpmn-safe-file-store-')));
    store = new SafeFileStore(root);
  });

  afterEach(async () => {
    const inspectable = store as unknown as InspectableSafeFileStore;
    inspectable.worker?.child?.kill();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reuses its anchored worker across ordinary request gaps', async () => {
    await store.write('diagram.bpmn', ['.bpmn'], '<xml />', false);
    const inspectable = store as unknown as InspectableSafeFileStore;
    const initialPid = inspectable.worker?.child?.pid;

    expect(initialPid).toEqual(expect.any(Number));
    await new Promise(resolve => setTimeout(resolve, 250));

    await expect(store.read('diagram.bpmn', ['.bpmn'], 1024)).resolves.toBe('<xml />');
    expect(inspectable.worker?.child?.pid).toBe(initialPid);
  });

  it('reclaims the lock a killed writer left behind instead of stalling forever', async () => {
    const filename = 'crashed.bpmn';
    await store.write(filename, ['.bpmn'], 'first', false);
    const lock = lockDirectory(root, filename);
    await writeOwnerRecord(lock, {
      uuid: 'abandoned-by-a-killed-worker',
      pid: exitedPid(),
      host: os.hostname(),
      time: Date.now()
    });

    const startedAt = Date.now();
    await expect(store.compareAndWrite(filename, ['.bpmn'], 'first', 'second'))
      .resolves.toBe(path.join(root, filename));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(fs.readFile(path.join(root, filename), 'utf8')).resolves.toBe('second');
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims an expired lock that carries no owner record', async () => {
    const filename = 'expired.bpmn';
    await store.write(filename, ['.bpmn'], 'first', false);
    const lock = lockDirectory(root, filename);
    await fs.mkdir(lock, { mode: 0o700 });
    const longAgo = new Date(Date.now() - 120_000);
    await fs.utimes(lock, longAgo, longAgo);

    const startedAt = Date.now();
    await expect(store.compareAndWrite(filename, ['.bpmn'], 'first', 'second'))
      .resolves.toBe(path.join(root, filename));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(fs.readFile(path.join(root, filename), 'utf8')).resolves.toBe('second');
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a lock whose holder is still alive rather than stealing it', async () => {
    const filename = 'held.bpmn';
    await store.write(filename, ['.bpmn'], 'first', false);
    const lock = lockDirectory(root, filename);
    await writeOwnerRecord(lock, {
      uuid: 'live-holder',
      pid: process.pid,
      host: os.hostname(),
      time: Date.now()
    });

    let settled = false;
    const write = store.compareAndWrite(filename, ['.bpmn'], 'first', 'second')
      .then(result => {
        settled = true;
        return result;
      }, error => {
        settled = true;
        throw error;
      });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(settled).toBe(false);
    await expect(fs.readFile(path.join(root, filename), 'utf8')).resolves.toBe('first');
    await expect(fs.readFile(path.join(lock, 'owner'), 'utf8')).resolves.toContain('live-holder');

    await fs.rm(lock, { recursive: true, force: true });
    await expect(write).resolves.toBe(path.join(root, filename));
    await expect(fs.readFile(path.join(root, filename), 'utf8')).resolves.toBe('second');
  });

  it('names the lock directory when a live holder never releases it', async () => {
    const filename = 'blocked.bpmn';
    await store.write(filename, ['.bpmn'], 'first', false);
    const lock = lockDirectory(root, filename);
    await writeOwnerRecord(lock, {
      uuid: 'live-holder',
      pid: process.pid,
      host: os.hostname(),
      time: Date.now()
    });

    const failure = await store.compareAndWrite(filename, ['.bpmn'], 'first', 'second')
      .then(() => undefined, (error: unknown) => error as SafeFilePathError);

    expect(failure).toBeInstanceOf(SafeFilePathError);
    expect(failure?.code).toBe('busy');
    expect(failure?.detail).toContain(path.basename(lock));
    await expect(fs.readFile(path.join(root, filename), 'utf8')).resolves.toBe('first');
  }, 30_000);

  it('admits exactly one of several processes writing the same expected revision', async () => {
    const filename = 'contended.bpmn';
    await store.write(filename, ['.bpmn'], 'base', false);
    const writers = Array.from({ length: 5 }, () => new SafeFileStore(root));

    const results = await Promise.allSettled(writers.map((writer, index) =>
      writer.compareAndWrite(filename, ['.bpmn'], 'base', `writer-${index}`)));

    try {
      const winners = results
        .map((result, index) => ({ result, index }))
        .filter(entry => entry.result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      await expect(fs.readFile(path.join(root, filename), 'utf8'))
        .resolves.toBe(`writer-${winners[0].index}`);
      for (const { result } of results.map((result, index) => ({ result, index }))) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(SafeFilePathError);
          expect(['conflict', 'busy']).toContain((result.reason as SafeFilePathError).code);
        }
      }
      await expect(fs.readdir(root)).resolves.toEqual([filename]);
    } finally {
      for (const writer of writers) {
        (writer as unknown as InspectableSafeFileStore).worker?.child?.kill();
      }
    }
  });
});
