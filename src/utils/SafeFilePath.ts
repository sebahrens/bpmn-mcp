import { promises as fs } from 'fs';
import path from 'path';

export type FileAccess = 'read' | 'write' | 'delete';

export interface SafeFilePathOptions {
  rootDirectory: string;
  filename: string;
  allowedExtensions: readonly string[];
  access: FileAccess;
}

export class SafeFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFilePathError';
  }
}

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
 * Resolve a client-supplied basename beneath one configured root.
 *
 * Nested relative paths are intentionally unsupported. Existing symlinks are
 * rejected even when they currently point inside the root, keeping the policy
 * consistent across reads, writes, and deletes.
 */
export async function resolveSafeFilePath(options: SafeFilePathOptions): Promise<string> {
  const { rootDirectory, filename, allowedExtensions, access } = options;
  assertSafeFilename(filename, allowedExtensions);

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(rootDirectory);
  } catch {
    throw new SafeFilePathError(access === 'write'
      ? 'Diagram storage is unavailable'
      : 'File not found');
  }

  const candidatePath = path.resolve(canonicalRoot, filename);
  if (!isPathContained(candidatePath, canonicalRoot) || candidatePath === canonicalRoot) {
    throw new SafeFilePathError('Invalid filename');
  }

  let candidateStats;
  try {
    candidateStats = await fs.lstat(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SafeFilePathError('Unable to access diagram file');
    }
    if (access !== 'write') {
      throw new SafeFilePathError('File not found');
    }
    return candidatePath;
  }

  if (candidateStats.isSymbolicLink()) {
    throw new SafeFilePathError('Symbolic links are not allowed');
  }
  if (!candidateStats.isFile()) {
    throw new SafeFilePathError('Diagram path is not a file');
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await fs.realpath(candidatePath);
  } catch {
    throw new SafeFilePathError('Unable to access diagram file');
  }
  if (!isPathContained(canonicalCandidate, canonicalRoot)) {
    throw new SafeFilePathError('Invalid filename');
  }

  return canonicalCandidate;
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
    throw new SafeFilePathError('Invalid filename');
  }

  const extension = path.extname(filename).toLowerCase();
  const normalizedExtensions = allowedExtensions.map(value => value.toLowerCase());
  if (!normalizedExtensions.includes(extension)) {
    throw new SafeFilePathError(`File extension must be one of: ${normalizedExtensions.join(', ')}`);
  }

  const stem = filename.slice(0, -extension.length);
  if (stem.length === 0 || /^\.+$/.test(stem)) {
    throw new SafeFilePathError('Invalid filename');
  }
}
