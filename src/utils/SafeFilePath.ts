import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import type { BigIntStats } from 'fs';
import path from 'path';
import { TOOL_INPUT_LIMITS } from '../config/index.js';

type FileAccess = 'read' | 'write' | 'delete';

export class SafeFilePathError extends Error {
  constructor(
    message: string,
    readonly code: SafeFilePathErrorCode = 'access',
    /**
     * Coarse, path-free cause an agent can act on ("permission denied
     * (EACCES)"). Never carries file contents; callers that are allowed to
     * disclose the managed workspace path add it to their own message.
     */
    readonly detail?: string
  ) {
    super(message);
    this.name = 'SafeFilePathError';
  }
}

export type SafeFilePathErrorCode =
  | 'access'
  | 'busy'
  | 'changed'
  | 'conflict'
  | 'exists'
  | 'invalid'
  | 'not_found'
  | 'not_file'
  | 'symlink'
  | 'too_large';

interface ResolvedSafeTarget {
  canonicalRoot: string;
  candidatePath: string;
  filename: string;
  rootDevice: string;
  rootInode: string;
}

interface ResolvedSafeRoot {
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
}

type AnchoredOperation = 'read' | 'write' | 'compare-write' | 'delete';

const ANCHORED_FILE_WORKER_IDLE_TIMEOUT_MS = 5_000;

/**
 * A compare-and-write lock older than this — or one whose recorded holder is a
 * dead process on this host — is reclaimed instead of blocking every later
 * mutation of that diagram. Reclaiming is serialized through an O_EXCL claim
 * file named after the exact holder record being reclaimed, so two reclaimers
 * can never both decide they own the lock.
 */
const COMPARE_WRITE_LOCK_STALE_MS = 30_000;
const COMPARE_WRITE_LOCK_ATTEMPTS = 500;
const COMPARE_WRITE_LOCK_RETRY_MS = 10;
/** Public name of the lock directory, documented for operators. */
export const COMPARE_WRITE_LOCK_PREFIX = '.mcp-bpmn-lock-';

/*
 * Node does not expose openat(2), renameat(2), or unlinkat(2). This worker
 * obtains the equivalent directory anchor by starting with the validated root
 * as its cwd, verifying that directory's identity, and then using basenames
 * only. Renaming or replacing the configured root path after startup cannot
 * redirect operations away from the directory held as the child's cwd.
 */
const ANCHORED_FILE_WORKER = String.raw`
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

class OperationFailure extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OperationFailure(code, detail);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function existingFile(filename) {
  let stats;
  try {
    stats = await fs.lstat(filename, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('not_found');
    throw error;
  }
  if (stats.isSymbolicLink()) fail('symlink');
  if (!stats.isFile()) fail('not_file');
  return stats;
}

async function readExactFile(filename, expectedSize) {
  const beforeOpen = await existingFile(filename);
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const afterOpen = await handle.stat({ bigint: true });
    if (!afterOpen.isFile() || !sameIdentity(beforeOpen, afterOpen)) fail('changed');
    if (afterOpen.size !== BigInt(expectedSize)) fail('conflict');
    const buffer = Buffer.alloc(expectedSize);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (!sameIdentity(afterOpen, afterRead)
      || afterOpen.size !== afterRead.size
      || afterOpen.mtimeNs !== afterRead.mtimeNs
      || afterOpen.ctimeNs !== afterRead.ctimeNs) fail('changed');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const LOCK_PREFIX = '${COMPARE_WRITE_LOCK_PREFIX}';
const LOCK_STALE_MS = ${COMPARE_WRITE_LOCK_STALE_MS};
const LOCK_ATTEMPTS = ${COMPARE_WRITE_LOCK_ATTEMPTS};
const LOCK_RETRY_MS = ${COMPARE_WRITE_LOCK_RETRY_MS};
const LOCK_OWNER_FILE = 'owner';

function lockPathFor(filename) {
  return LOCK_PREFIX + createHash('sha256').update(filename).digest('hex');
}

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Identity of the current holder: its recorded owner document, or, during the
 * sub-millisecond window between mkdir and the owner record being written, the
 * directory's own mtime.
 */
async function lockHolder(lock) {
  let record;
  try {
    const raw = await fs.readFile(path.join(lock, LOCK_OWNER_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed
      && typeof parsed.uuid === 'string'
      && typeof parsed.time === 'number'
      && Number.isFinite(parsed.time)) {
      record = parsed;
    }
  } catch {
    record = undefined;
  }
  if (record) return { token: 'owner.' + record.uuid, record, time: record.time };
  const stats = await fs.stat(lock);
  return { token: 'anonymous', record: undefined, time: stats.mtimeMs };
}

function holderIsRunning(record) {
  if (!record || record.host !== hostname() || !Number.isInteger(record.pid)) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== 'ESRCH';
  }
}

function holderIsStale(holder) {
  return !holderIsRunning(holder.record) || Date.now() - holder.time > LOCK_STALE_MS;
}

/**
 * Remove one abandoned lock. The claim file is named after the exact holder
 * record observed, so O_EXCL admits a single reclaimer per abandoned holder,
 * and the holder is re-read afterwards so a lock that was released and
 * re-taken in the meantime is never removed from its new owner.
 */
async function reclaimAbandonedLock(lock, holder) {
  const claim = path.join(lock, 'reclaim.' + holder.token);
  try {
    await fs.writeFile(claim, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  let current;
  try {
    current = await lockHolder(lock);
  } catch {
    return false;
  }
  if (current.token !== holder.token) {
    await fs.unlink(claim).catch(() => undefined);
    return false;
  }
  await fs.rm(lock, { recursive: true, force: true });
  return true;
}

async function acquireLock(filename) {
  const lock = lockPathFor(filename);
  const uuid = randomUUID();
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let holder;
      try {
        holder = await lockHolder(lock);
      } catch (holderError) {
        if (holderError && holderError.code === 'ENOENT') continue;
        throw holderError;
      }
      if (holderIsStale(holder) && await reclaimAbandonedLock(lock, holder)) continue;
      await pause(LOCK_RETRY_MS);
      continue;
    }
    const acquiredAt = Date.now();
    await fs.writeFile(
      path.join(lock, LOCK_OWNER_FILE),
      JSON.stringify({ uuid, pid: process.pid, host: hostname(), time: acquiredAt }),
      { flag: 'wx', mode: 0o600 }
    );
    return { lock, uuid, acquiredAt };
  }
  fail('busy', 'lock directory ' + lock + ' is held by another writer');
}

/**
 * Guard the destructive step: a holder that has itself aged into the stale
 * window, or whose lock was reclaimed, must never publish its temporary file.
 */
async function assertLockHeld(held) {
  if (Date.now() - held.acquiredAt > LOCK_STALE_MS / 2) {
    fail('busy', 'lock directory ' + held.lock + ' expired while the write was in progress');
  }
  let holder;
  try {
    holder = await lockHolder(held.lock);
  } catch {
    fail('busy', 'lock directory ' + held.lock + ' disappeared while the write was in progress');
  }
  if (!holder.record || holder.record.uuid !== held.uuid) {
    fail('busy', 'lock directory ' + held.lock + ' was taken over by another writer');
  }
}

async function releaseLock(held) {
  try {
    const holder = await lockHolder(held.lock);
    if (holder.record && holder.record.uuid !== held.uuid) return;
  } catch {
    return;
  }
  await fs.rm(held.lock, { recursive: true, force: true }).catch(() => undefined);
}

async function perform(request) {
  const { operation, filename, option } = request;
  if (!filename
    || filename !== path.basename(filename)
    || filename.includes('/')
    || filename.includes(String.fromCharCode(92))) {
    fail('invalid');
  }

  if (operation === 'read') {
    const beforeOpen = await existingFile(filename);
    let handle;
    try {
      handle = await fs.open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
      );
      const afterOpen = await handle.stat({ bigint: true });
      if (!afterOpen.isFile() || !sameIdentity(beforeOpen, afterOpen)) fail('changed');

      const maxBytes = Number(option);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('access');
      if (afterOpen.size > BigInt(maxBytes)) fail('too_large');

      const buffer = Buffer.alloc(Number(afterOpen.size));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }

      const probe = Buffer.alloc(1);
      const growth = await handle.read(probe, 0, 1, bytesRead);
      if (growth.bytesRead > 0) {
        if (bytesRead >= maxBytes) fail('too_large');
        fail('changed');
      }
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  if (operation === 'write') {
    const overwrite = option === 'overwrite';
    if (overwrite) {
      try {
        await existingFile(filename);
      } catch (error) {
        if (!(error instanceof OperationFailure) || error.code !== 'not_found') throw error;
      }
    }

    const temporary = '.' + filename + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      const content = Buffer.from(request.input || '', 'base64');
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      if (overwrite) await fs.rename(temporary, filename);
      else await fs.link(temporary, filename);
      return Buffer.alloc(0);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  if (operation === 'compare-write') {
    const temporary = '.' + filename + '.' + process.pid + '.' + randomUUID() + '.tmp';
    let held;
    try {
      const content = Buffer.from(request.input || '', 'base64');
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      held = await acquireLock(filename);
      if (request.expected === null) {
        try {
          await existingFile(filename);
          fail('conflict');
        } catch (error) {
          if (!(error instanceof OperationFailure) || error.code !== 'not_found') throw error;
        }
        await assertLockHeld(held);
        await fs.link(temporary, filename);
      } else {
        const expected = Buffer.from(request.expected || '', 'base64');
        let actual;
        try {
          actual = await readExactFile(filename, expected.length);
        } catch (error) {
          if (error instanceof OperationFailure && error.code === 'not_found') fail('conflict');
          throw error;
        }
        if (!actual.equals(expected)) fail('conflict');
        await assertLockHeld(held);
        await fs.rename(temporary, filename);
      }
      return Buffer.alloc(0);
    } finally {
      if (held) await releaseLock(held);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  if (operation === 'delete') {
    await existingFile(filename);
    await fs.unlink(filename);
    return Buffer.alloc(0);
  }

  fail('invalid');
}

function errorCode(error) {
  if (error instanceof OperationFailure) return error.code;
  if (error && error.code === 'ENOENT') return 'not_found';
  if (error && error.code === 'EEXIST') return 'exists';
  return 'access';
}

/**
 * A coarse, actionable cause built only from the errno symbol. Node's own
 * message embeds the failing path and is never forwarded.
 */
function errorDetail(error) {
  if (error instanceof OperationFailure) return error.detail;
  const code = error && typeof error.code === 'string' ? error.code : undefined;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied (' + code + ')';
    case 'EROFS':
      return 'read-only filesystem (EROFS)';
    case 'ENOSPC':
      return 'no space left on device (ENOSPC)';
    case 'EDQUOT':
      return 'disk quota exceeded (EDQUOT)';
    case 'ENOENT':
      return 'the workspace directory or file no longer exists (ENOENT)';
    case 'ENOTDIR':
      return 'the workspace path is not a directory (ENOTDIR)';
    case 'EXDEV':
      return 'the temporary file and the target are on different filesystems (EXDEV)';
    case 'ENOSYS':
    case 'EOPNOTSUPP':
    case 'ENOTSUP':
    case 'EINVAL':
      return 'the filesystem does not support this operation (' + code + ')';
    case 'EMFILE':
    case 'ENFILE':
      return 'too many open files (' + code + ')';
    case 'EIO':
      return 'a device I/O error occurred (EIO)';
    case 'ELOOP':
      return 'too many symbolic links (ELOOP)';
    case 'ENAMETOOLONG':
      return 'the filename is too long for this filesystem (ENAMETOOLONG)';
    default:
      return code;
  }
}

async function respond(value) {
  await new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + '\n', error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const [expectedDevice, expectedInode] = process.argv.slice(1);
let rootError;
let rootDetail;
try {
  const rootStats = await fs.stat('.', { bigint: true });
  if (!rootStats.isDirectory()
    || rootStats.dev.toString() !== expectedDevice
    || rootStats.ino.toString() !== expectedInode) {
    fail('changed', 'the workspace directory pinned at startup was replaced or removed');
  }
} catch (error) {
  rootError = errorCode(error);
  rootDetail = errorDetail(error);
}

await respond({ ready: rootError === undefined, error: rootError, detail: rootDetail });
if (rootError) process.exit(1);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let idleTimer;
const armIdleExit = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => process.exit(0),
    ${ANCHORED_FILE_WORKER_IDLE_TIMEOUT_MS}
  );
};
armIdleExit();

for await (const line of input) {
  clearTimeout(idleTimer);
  try {
    const result = await perform(JSON.parse(line));
    await respond({ ok: true, data: result.toString('base64') });
  } catch (error) {
    await respond({ ok: false, error: errorCode(error), detail: errorDetail(error) });
  }
  armIdleExit();
}
`;

/**
 * Return whether target is equal to, or a separator-delimited descendant of,
 * root. Both arguments must already be absolute paths.
 */
export function isPathContained(target: string, root: string): boolean {
  const relativePath = path.relative(root, target);
  if (relativePath === '') {
    return true;
  }

  const firstSegment = relativePath.split(path.sep, 1)[0];
  return firstSegment !== '..' && !path.isAbsolute(relativePath);
}

/**
 * Basename-only file access pinned to one directory identity. The pin is
 * revalidated before every operation: a root that was replaced by a symbolic
 * link — the redirection this store exists to defeat — is never adopted, while
 * a workspace that was deleted and recreated as a real directory at the same
 * configured path is re-pinned so the process does not have to be restarted.
 */
export class SafeFileStore {
  private rootResolution?: Promise<ResolvedSafeRoot>;
  private worker?: AnchoredFileWorker;

  constructor(private readonly rootDirectory: string) {}

  async read(
    filename: string,
    allowedExtensions: readonly string[],
    maxBytes: number
  ): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new SafeFilePathError('Invalid file import byte limit');
    }
    const target = await this.resolveTarget(filename, allowedExtensions, 'read');
    const content = await this.workerFor(target).run('read', filename, String(maxBytes));
    return content.toString('utf8');
  }

  async write(
    filename: string,
    allowedExtensions: readonly string[],
    content: string | Buffer,
    overwrite: boolean
  ): Promise<string> {
    const target = await this.resolveTarget(filename, allowedExtensions, 'write');
    await this.workerFor(target).run(
      'write',
      filename,
      overwrite ? 'overwrite' : 'no-overwrite',
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    );
    return target.candidatePath;
  }

  async compareAndWrite(
    filename: string,
    allowedExtensions: readonly string[],
    expectedContent: string | null,
    content: string
  ): Promise<string> {
    const target = await this.resolveTarget(filename, allowedExtensions, 'write');
    await this.workerFor(target).run(
      'compare-write',
      filename,
      '',
      Buffer.from(content, 'utf8'),
      expectedContent === null ? null : Buffer.from(expectedContent, 'utf8')
    );
    return target.candidatePath;
  }

  async delete(filename: string, allowedExtensions: readonly string[]): Promise<void> {
    const target = await this.resolveTarget(filename, allowedExtensions, 'delete');
    await this.workerFor(target).run('delete', filename, '');
  }

  private async resolveTarget(
    filename: string,
    allowedExtensions: readonly string[],
    access: FileAccess
  ): Promise<ResolvedSafeTarget> {
    assertSafeFilename(filename, allowedExtensions);
    let root: ResolvedSafeRoot;
    try {
      root = await this.resolveRoot();
    } catch (error) {
      if (error instanceof SafeFilePathError && error.code === 'not_found') {
        throw new SafeFilePathError(
          access === 'write' ? 'Diagram storage is unavailable' : 'File not found',
          'not_found',
          error.detail ?? 'the workspace directory does not exist'
        );
      }
      throw error;
    }

    const candidatePath = path.resolve(root.canonicalRoot, filename);
    if (!isPathContained(candidatePath, root.canonicalRoot)
      || candidatePath === root.canonicalRoot) {
      throw new SafeFilePathError('Invalid filename', 'invalid');
    }

    return { ...root, candidatePath, filename };
  }

  private async resolveRoot(): Promise<ResolvedSafeRoot> {
    const pinned = this.rootResolution;
    if (pinned) {
      // A cached failure is still reported as before; only a resolved pin is
      // revalidated against the directory that is at the configured path now.
      const root = await pinned;
      if (await this.pinnedRootIsCurrent(root)) return root;
      await this.assertReplacementIsNotRedirected();
      // A concurrent caller may already have re-pinned while this one waited.
      if (this.rootResolution === pinned) this.releasePinnedRoot();
    }
    return this.pinRoot();
  }

  private pinRoot(): Promise<ResolvedSafeRoot> {
    if (!this.rootResolution) {
      this.rootResolution = this.establishRoot().catch(error => {
        if (error instanceof SafeFilePathError && error.code === 'not_found') {
          this.rootResolution = undefined;
        }
        throw error;
      });
    }
    return this.rootResolution;
  }

  /** True while the pinned directory is still the one at the configured path. */
  private async pinnedRootIsCurrent(root: ResolvedSafeRoot): Promise<boolean> {
    let stats: BigIntStats;
    try {
      stats = await fs.stat(root.canonicalRoot, { bigint: true });
    } catch {
      return false;
    }
    return stats.isDirectory()
      && stats.dev.toString() === root.rootDevice
      && stats.ino.toString() === root.rootInode;
  }

  /**
   * A recreated workspace directory may be re-pinned; a symbolic link that
   * appeared where the pinned directory used to be is the redirection attack
   * this store exists to defeat and is refused for the life of the process.
   */
  private async assertReplacementIsNotRedirected(): Promise<void> {
    for (const candidate of new Set([this.rootDirectory, path.resolve(this.rootDirectory)])) {
      let link;
      try {
        link = await fs.lstat(candidate);
      } catch {
        continue;
      }
      if (link.isSymbolicLink()) {
        throw new SafeFilePathError(
          'File changed during operation',
          'changed',
          'the workspace path now resolves through a symbolic link that replaced the '
            + 'directory pinned at startup'
        );
      }
    }
  }

  private releasePinnedRoot(): void {
    this.rootResolution = undefined;
    this.worker?.dispose();
    this.worker = undefined;
  }

  private workerFor(target: ResolvedSafeTarget): AnchoredFileWorker {
    this.worker ??= new AnchoredFileWorker(target);
    return this.worker;
  }

  private async establishRoot(): Promise<ResolvedSafeRoot> {
    let initialRootStats: BigIntStats;
    try {
      initialRootStats = await fs.stat(this.rootDirectory, { bigint: true });
    } catch (error) {
      throw new SafeFilePathError(
        'File not found',
        'not_found',
        errnoDetail(error) ?? 'the workspace directory does not exist'
      );
    }
    if (!initialRootStats.isDirectory()) {
      throw new SafeFilePathError(
        'Diagram storage is unavailable',
        'not_file',
        'the workspace path is not a directory'
      );
    }

    let canonicalRoot: string;
    let rootStats: BigIntStats;
    try {
      canonicalRoot = await fs.realpath(this.rootDirectory);
      rootStats = await fs.stat(canonicalRoot, { bigint: true });
    } catch (error) {
      throw new SafeFilePathError(
        'File changed during operation',
        'changed',
        errnoDetail(error) ?? 'the workspace directory changed while it was being resolved'
      );
    }
    if (!rootStats.isDirectory()
      || initialRootStats.dev !== rootStats.dev
      || initialRootStats.ino !== rootStats.ino) {
      throw new SafeFilePathError(
        'File changed during operation',
        'changed',
        'the workspace directory changed while it was being resolved'
      );
    }

    return {
      canonicalRoot,
      rootDevice: rootStats.dev.toString(),
      rootInode: rootStats.ino.toString()
    };
  }
}

interface WorkerResponse {
  ready?: boolean;
  ok?: boolean;
  data?: string;
  error?: string;
  detail?: string;
}

class WorkerTransportError extends Error {}

class AnchoredFileWorker {
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private outputBuffer = '';
  private outputLines: string[] = [];
  private lineWaiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly target: ResolvedSafeTarget) {}

  run(
    operation: AnchoredOperation,
    filename: string,
    option: string,
    input: Buffer = Buffer.alloc(0),
    expected?: Buffer | null
  ): Promise<Buffer> {
    const result = this.queue.then(() => this.runWithRetry(
      operation,
      filename,
      option,
      input,
      expected
    ));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Stop the child anchored to a root that is no longer the pinned one. */
  dispose(): void {
    const child = this.child;
    this.child = undefined;
    this.startup = undefined;
    child?.kill();
    this.failWaiters();
  }

  private async runWithRetry(
    operation: AnchoredOperation,
    filename: string,
    option: string,
    input: Buffer,
    expected?: Buffer | null
  ): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.send(operation, filename, option, input, expected);
      } catch (error) {
        if (!(error instanceof WorkerTransportError) || attempt === 1) throw error;
        this.child?.kill();
        this.child = undefined;
        this.startup = undefined;
      }
    }
    throw new WorkerTransportError('Worker retry exhausted');
  }

  private async send(
    operation: AnchoredOperation,
    filename: string,
    option: string,
    input: Buffer,
    expected?: Buffer | null
  ): Promise<Buffer> {
    await this.ensureStarted();
    const child = this.child;
    if (!child || child.exitCode !== null) {
      throw new WorkerTransportError('Worker is not running');
    }
    this.setChildReferenced(child, true);

    const request = `${JSON.stringify({
      operation,
      filename,
      option,
      input: input.length === 0 ? undefined : input.toString('base64'),
      expected: expected === undefined
        ? undefined
        : expected === null
          ? null
          : expected.toString('base64')
    })}\n`;
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(request, error => {
            if (error) reject(error);
            else resolve();
          });
        });
      } catch {
        child.kill();
        throw new WorkerTransportError('Unable to write worker request');
      }

      const message = this.parseResponse(await this.nextLine());
      if (!message.ok) throw workerError(message.error || 'access', message.detail);
      return Buffer.from(message.data || '', 'base64');
    } finally {
      if (this.child === child && child.exitCode === null) {
        this.setChildReferenced(child, false);
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.startup) {
      return this.startup;
    }

    this.outputBuffer = '';
    this.outputLines = [];
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      ANCHORED_FILE_WORKER,
      this.target.rootDevice,
      this.target.rootInode
    ], {
      cwd: this.target.canonicalRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) this.consumeOutput(chunk);
    });
    child.stderr.resume();
    child.on('error', () => {
      if (this.child === child) this.failWaiters();
    });
    child.on('close', () => {
      if (this.child === child) {
        this.child = undefined;
        this.startup = undefined;
        this.failWaiters();
      }
    });

    this.startup = this.nextLine().then(line => {
      const response = this.parseResponse(line);
      if (!response.ready) throw workerError(response.error || 'access', response.detail);
    });
    return this.startup;
  }

  private setChildReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
    const method = referenced ? 'ref' : 'unref';
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const refable = stream as typeof stream & { ref?: () => void; unref?: () => void };
      refable[method]?.();
    }
  }

  private consumeOutput(chunk: Buffer): void {
    this.outputBuffer += chunk.toString('utf8');
    let newline = this.outputBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.outputBuffer.slice(0, newline);
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      const waiter = this.lineWaiters.shift();
      if (waiter) waiter.resolve(line);
      else this.outputLines.push(line);
      newline = this.outputBuffer.indexOf('\n');
    }
  }

  private nextLine(): Promise<string> {
    const line = this.outputLines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolve, reject) => {
      this.lineWaiters.push({ resolve, reject });
    });
  }

  private failWaiters(): void {
    const error = new WorkerTransportError('Worker exited before responding');
    for (const waiter of this.lineWaiters.splice(0)) waiter.reject(error);
  }

  private parseResponse(line: string): WorkerResponse {
    try {
      return JSON.parse(line) as WorkerResponse;
    } catch {
      throw new WorkerTransportError('Worker returned an invalid response');
    }
  }
}

function workerError(code: string, detail?: string): SafeFilePathError {
  switch (code) {
    case 'invalid':
      return new SafeFilePathError('Invalid filename', 'invalid', detail);
    case 'not_found':
      return new SafeFilePathError('File not found', 'not_found', detail);
    case 'not_file':
      return new SafeFilePathError('Diagram path is not a file', 'not_file', detail);
    case 'symlink':
      return new SafeFilePathError('Symbolic links are not allowed', 'symlink', detail);
    case 'too_large':
      return new SafeFilePathError(
        'Diagram file exceeds the configured byte limit',
        'too_large',
        detail
      );
    case 'exists':
      return new SafeFilePathError('File already exists', 'exists', detail);
    case 'changed':
      return new SafeFilePathError('File changed during operation', 'changed', detail);
    case 'conflict':
      return new SafeFilePathError('Document revision conflict', 'conflict', detail);
    case 'busy':
      return new SafeFilePathError('Diagram file is busy', 'busy', detail);
    default:
      return new SafeFilePathError('Unable to access diagram file', 'access', detail);
  }
}

/** Coarse, path-free cause for an errno raised in this process. */
export function errnoDetail(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case undefined:
      return undefined;
    case 'EACCES':
    case 'EPERM':
      return `permission denied (${code})`;
    case 'EROFS':
      return 'read-only filesystem (EROFS)';
    case 'ENOSPC':
      return 'no space left on device (ENOSPC)';
    case 'ENOENT':
      return 'the workspace directory does not exist (ENOENT)';
    case 'ENOTDIR':
      return 'the workspace path is not a directory (ENOTDIR)';
    case 'EEXIST':
      return 'the workspace path is already occupied by a file (EEXIST)';
    case 'ELOOP':
      return 'too many symbolic links (ELOOP)';
    default:
      return code;
  }
}

export function assertSafeFilename(filename: string, allowedExtensions: readonly string[]): void {
  if (typeof filename !== 'string'
    || filename.length === 0
    || filename.trim() !== filename
    || filename.includes('\0')
    || filename.includes('/')
    || filename.includes('\\')
    || path.posix.isAbsolute(filename)
    || path.win32.isAbsolute(filename)
    || /^[a-zA-Z]:/.test(filename)) {
    throw new SafeFilePathError('Invalid filename', 'invalid');
  }

  const filenameBytes = Buffer.byteLength(filename, 'utf8');
  if (filenameBytes > TOOL_INPUT_LIMITS.filename.maxUtf8Bytes) {
    throw new SafeFilePathError(
      `Filename must not exceed ${TOOL_INPUT_LIMITS.filename.maxUtf8Bytes} UTF-8 bytes`,
      'invalid'
    );
  }
  if (filenameBytes + TOOL_INPUT_LIMITS.filename.maxAtomicWriteSuffixBytes
    > TOOL_INPUT_LIMITS.filename.maxComponentBytes) {
    throw new SafeFilePathError(
      `Atomic filename must not exceed ${TOOL_INPUT_LIMITS.filename.maxComponentBytes} UTF-8 bytes`,
      'invalid'
    );
  }

  const extension = path.extname(filename).toLowerCase();
  const normalizedExtensions = allowedExtensions.map(value => value.toLowerCase());
  if (!normalizedExtensions.includes(extension)) {
    throw new SafeFilePathError(
      `File extension must be one of: ${normalizedExtensions.join(', ')}`,
      'invalid'
    );
  }

  const stem = filename.slice(0, -extension.length);
  if (stem.length === 0 || /^\.+$/.test(stem)) {
    throw new SafeFilePathError('Invalid filename', 'invalid');
  }
}
