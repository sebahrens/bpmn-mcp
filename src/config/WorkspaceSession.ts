import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs';
import path from 'node:path';
import { isPathContained } from '../utils/SafeFilePath.js';

export const WORKSPACE_CONFIG_FILENAME = '.mcp-bpmn.json';
const MAX_WORKSPACE_CONFIG_BYTES = 16 * 1024;

export type WorkspaceSource =
  | 'environment'
  | 'repository_config'
  | 'launch_cwd'
  | 'selection';

export interface WorkspaceInfo {
  launchCwd: string;
  startupBoundary: string;
  workspace: string;
  source: WorkspaceSource;
  configPath?: string;
}

/**
 * One immutable launch boundary and one mutable, session-scoped workspace.
 * Resolving paths never changes process.cwd(), so package imports remain
 * anchored to the installed executable.
 */
export class WorkspaceSession {
  private currentWorkspace: string;
  private currentSource: WorkspaceSource;

  private constructor(
    private readonly launchCwd: string,
    private readonly startupBoundary: string,
    workspace: string,
    source: WorkspaceSource,
    private readonly configPath?: string
  ) {
    this.currentWorkspace = workspace;
    this.currentSource = source;
  }

  static fromLaunch(
    launchDirectory = process.cwd(),
    environment: NodeJS.ProcessEnv = process.env
  ): WorkspaceSession {
    const launchCwd = canonicalExistingDirectory(launchDirectory, 'launch cwd');
    const override = environment.MCP_BPMN_DIAGRAMS_PATH;
    if (override !== undefined) {
      if (!path.isAbsolute(override) || hasDotSegment(override)) {
        throw new Error('MCP_BPMN_DIAGRAMS_PATH must be an absolute path without dot segments');
      }
      const workspace = canonicalDirectory(override, 'MCP_BPMN_DIAGRAMS_PATH');
      return new WorkspaceSession(
        launchCwd,
        launchCwd,
        workspace,
        'environment'
      );
    }

    const configPath = path.join(launchCwd, WORKSPACE_CONFIG_FILENAME);
    const configuredPath = readRepositoryConfig(configPath);
    if (configuredPath !== undefined) {
      const workspace = canonicalDescendant(launchCwd, configuredPath);
      return new WorkspaceSession(
        launchCwd,
        launchCwd,
        workspace,
        'repository_config',
        configPath
      );
    }

    return new WorkspaceSession(launchCwd, launchCwd, launchCwd, 'launch_cwd');
  }

  static fixed(workspace: string): WorkspaceSession {
    const canonical = canonicalDirectory(workspace, 'workspace');
    return new WorkspaceSession(canonical, canonical, canonical, 'launch_cwd');
  }

  get path(): string {
    return this.currentWorkspace;
  }

  getInfo(): WorkspaceInfo {
    return {
      launchCwd: this.launchCwd,
      startupBoundary: this.startupBoundary,
      workspace: this.currentWorkspace,
      source: this.currentSource,
      ...(this.configPath ? { configPath: this.configPath } : {})
    };
  }

  resolveSelection(relativePath: string): string {
    return canonicalDescendant(this.startupBoundary, relativePath);
  }

  activateSelection(workspace: string): {
    changed: boolean;
    info: Omit<WorkspaceInfo, 'source'> & { source: 'selection' };
  } {
    if (!isPathContained(workspace, this.startupBoundary)
      || workspace === this.startupBoundary) {
      throw new Error('Workspace path must be a descendant of the startup boundary');
    }
    const changed = workspace !== this.currentWorkspace;
    this.currentWorkspace = workspace;
    this.currentSource = 'selection';
    return {
      changed,
      info: { ...this.getInfo(), source: 'selection' }
    };
  }
}

function readRepositoryConfig(configPath: string): string | undefined {
  let initial;
  try {
    initial = lstatSync(configPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Unable to inspect ${WORKSPACE_CONFIG_FILENAME}`);
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error(`${WORKSPACE_CONFIG_FILENAME} must be a regular, non-symlinked file`);
  }
  if (initial.size > BigInt(MAX_WORKSPACE_CONFIG_BYTES)) {
    throw new Error(`${WORKSPACE_CONFIG_FILENAME} exceeds ${MAX_WORKSPACE_CONFIG_BYTES} bytes`);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      configPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.dev !== initial.dev
      || opened.ino !== initial.ino
      || opened.size !== initial.size) {
      throw new Error(`${WORKSPACE_CONFIG_FILENAME} changed while being read`);
    }
    const buffer = Buffer.alloc(MAX_WORKSPACE_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_WORKSPACE_CONFIG_BYTES) {
      throw new Error(`${WORKSPACE_CONFIG_FILENAME} exceeds ${MAX_WORKSPACE_CONFIG_BYTES} bytes`);
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (afterRead.dev !== opened.dev
      || afterRead.ino !== opened.ino
      || afterRead.size !== BigInt(bytesRead)) {
      throw new Error(`${WORKSPACE_CONFIG_FILENAME} changed while being read`);
    }
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!isPlainObject(parsed)
      || Object.keys(parsed).length !== 1
      || typeof parsed.path !== 'string') {
      throw new Error(`${WORKSPACE_CONFIG_FILENAME} must contain exactly { "path": "relative/path" }`);
    }
    return parsed.path;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${WORKSPACE_CONFIG_FILENAME} must contain valid JSON`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalDescendant(boundary: string, relativePath: string): string {
  if (typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.trim() !== relativePath
    || relativePath.includes('\0')
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || /^[a-zA-Z]:/.test(relativePath)
    || hasDotSegment(relativePath)) {
    throw new Error('Workspace path must be a relative descendant without dot segments');
  }

  const segments = relativePath.split(/[\\/]/);
  let current = boundary;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error('Workspace path must not traverse symbolic links');
      }
      if (!stats.isDirectory()) {
        throw new Error('Workspace path components must be directories');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        mkdirSync(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        const stats = lstatSync(candidate);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error('Workspace path components must be non-symlinked directories');
        }
      }
    }
    current = candidate;
  }

  const canonical = canonicalExistingDirectory(current, 'workspace');
  if (!isPathContained(canonical, boundary) || canonical === boundary) {
    throw new Error('Workspace path must be a descendant of the startup boundary');
  }
  return canonical;
}

function canonicalDirectory(directory: string, label: string): string {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error(`${label} could not be created`);
  }
  return canonicalExistingDirectory(directory, label);
}

function canonicalExistingDirectory(directory: string, label: string): string {
  try {
    const canonical = realpathSync(directory);
    if (!statSync(canonical).isDirectory()) throw new Error();
    return canonical;
  } catch {
    throw new Error(`${label} must resolve to a directory`);
  }
}

function hasDotSegment(value: string): boolean {
  return value.split(/[\\/]/).some(segment => segment === '.' || segment === '..');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
