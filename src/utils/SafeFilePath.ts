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
    readonly code: SafeFilePathErrorCode = 'access'
  ) {
    super(message);
    this.name = 'SafeFilePathError';
  }
}

export type SafeFilePathErrorCode =
  | 'access'
  | 'changed'
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

type AnchoredOperation = 'read' | 'write' | 'delete';

const ANCHORED_FILE_WORKER_IDLE_TIMEOUT_MS = 5_000;

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
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

class OperationFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new OperationFailure(code);
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
try {
  const rootStats = await fs.stat('.', { bigint: true });
  if (!rootStats.isDirectory()
    || rootStats.dev.toString() !== expectedDevice
    || rootStats.ino.toString() !== expectedInode) {
    fail('changed');
  }
} catch (error) {
  rootError = errorCode(error);
}

await respond({ ready: rootError === undefined, error: rootError });
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
    await respond({ ok: false, error: errorCode(error) });
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
 * Basename-only file access pinned to one directory identity for this store's
 * lifetime. A replaced root path is never adopted by a later operation.
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
    content: string,
    overwrite: boolean
  ): Promise<string> {
    const target = await this.resolveTarget(filename, allowedExtensions, 'write');
    await this.workerFor(target).run(
      'write',
      filename,
      overwrite ? 'overwrite' : 'no-overwrite',
      Buffer.from(content, 'utf8')
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
        throw new SafeFilePathError(access === 'write'
          ? 'Diagram storage is unavailable'
          : 'File not found', 'not_found');
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

  private resolveRoot(): Promise<ResolvedSafeRoot> {
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

  private workerFor(target: ResolvedSafeTarget): AnchoredFileWorker {
    this.worker ??= new AnchoredFileWorker(target);
    return this.worker;
  }

  private async establishRoot(): Promise<ResolvedSafeRoot> {
    let initialRootStats: BigIntStats;
    try {
      initialRootStats = await fs.stat(this.rootDirectory, { bigint: true });
    } catch {
      throw new SafeFilePathError('File not found', 'not_found');
    }
    if (!initialRootStats.isDirectory()) {
      throw new SafeFilePathError('Diagram storage is unavailable', 'not_file');
    }

    let canonicalRoot: string;
    let rootStats: BigIntStats;
    try {
      canonicalRoot = await fs.realpath(this.rootDirectory);
      rootStats = await fs.stat(canonicalRoot, { bigint: true });
    } catch {
      throw new SafeFilePathError('File changed during operation', 'changed');
    }
    if (!rootStats.isDirectory()
      || initialRootStats.dev !== rootStats.dev
      || initialRootStats.ino !== rootStats.ino) {
      throw new SafeFilePathError('File changed during operation', 'changed');
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
    input: Buffer = Buffer.alloc(0)
  ): Promise<Buffer> {
    const result = this.queue.then(() => this.runWithRetry(
      operation,
      filename,
      option,
      input
    ));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runWithRetry(
    operation: AnchoredOperation,
    filename: string,
    option: string,
    input: Buffer
  ): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.send(operation, filename, option, input);
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
    input: Buffer
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
      input: input.length === 0 ? undefined : input.toString('base64')
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
      if (!message.ok) throw workerError(message.error || 'access');
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
      if (!response.ready) throw workerError(response.error || 'access');
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

function workerError(code: string): SafeFilePathError {
  switch (code) {
    case 'invalid':
      return new SafeFilePathError('Invalid filename', 'invalid');
    case 'not_found':
      return new SafeFilePathError('File not found', 'not_found');
    case 'not_file':
      return new SafeFilePathError('Diagram path is not a file', 'not_file');
    case 'symlink':
      return new SafeFilePathError('Symbolic links are not allowed', 'symlink');
    case 'too_large':
      return new SafeFilePathError('Diagram file exceeds the configured byte limit', 'too_large');
    case 'exists':
      return new SafeFilePathError('File already exists', 'exists');
    case 'changed':
      return new SafeFilePathError('File changed during operation', 'changed');
    default:
      return new SafeFilePathError('Unable to access diagram file');
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
