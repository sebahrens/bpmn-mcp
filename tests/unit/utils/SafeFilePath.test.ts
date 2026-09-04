import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  assertSafeFilename,
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

describe('assertSafeFilename hostile names', () => {
  function rejection(filename: string): SafeFilePathError | undefined {
    try {
      assertSafeFilename(filename, ['.bpmn']);
      return undefined;
    } catch (error) {
      if (error instanceof SafeFilePathError) return error;
      throw error;
    }
  }

  // WSL2 (/mnt/c) is a supported platform, so a name Windows resolves to a
  // console device rather than a file has to be refused here: on that mount
  // "CON.bpmn" opens the console and the caller's diagram is silently lost.
  const reservedNames = [
    'CON.bpmn', 'con.bpmn', 'Con.bpmn', 'PRN.bpmn', 'aux.bpmn', 'NUL.bpmn',
    'com1.bpmn', 'COM9.bpmn', 'lpt1.bpmn', 'LPT9.bpmn', 'CON .bpmn'
  ];

  // Bidi overrides and other invisible format characters let one filename
  // render as another in every listing an operator reads, and the C0/C1
  // ranges are not filename material at all. Code points rather than literals,
  // so the hostile characters cannot hide in this source file either.
  const invisibleCodePoints: Array<[string, number]> = [
    ['right-to-left override', 0x202e],
    ['left-to-right embedding', 0x202a],
    ['right-to-left mark', 0x200f],
    ['first strong isolate', 0x2068],
    ['zero width joiner', 0x200d],
    ['soft hyphen', 0x00ad],
    ['C0 bell', 0x0007],
    ['C1 control', 0x009b],
    ['delete character', 0x007f]
  ];

  it.each(reservedNames)('rejects the Windows device name %j', filename => {
    expect(rejection(filename)).toBeInstanceOf(SafeFilePathError);
  });

  it.each(invisibleCodePoints)('rejects a filename carrying a %s', (_label, codePoint) => {
    const filename = `report${String.fromCodePoint(codePoint as number)}name.bpmn`;

    expect(rejection(filename)).toBeInstanceOf(SafeFilePathError);
  });

  // The no-false-positive twin: ordinary names, names that merely begin with
  // the letters of a device name, and the non-ASCII names other suites save.
  it('still accepts every ordinary filename', () => {
    const accepted = [
      'diagram.bpmn', 'valid.bpmn', 'saved.bpmn', 'race.bpmn', 'pinned.bpmn',
      'order-to-cash.bpmn', 'Order To Cash.bpmn', 'v1.2.bpmn', 'foo..bpmn',
      'console.bpmn', 'conference.bpmn', 'aux-review.bpmn', 'com10.bpmn',
      'lpt0.bpmn', 'nullify.bpmn', 'prnt.bpmn', 'CONTRACT.bpmn', 'my CON.bpmn',
      `${'é'.repeat(97)}a.bpmn`, 'Ordnung-für-Prozesse.bpmn', '流程图.bpmn'
    ];

    expect(accepted.filter(filename => rejection(filename) !== undefined)).toEqual([]);
  });
});
