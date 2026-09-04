import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  assertSafeFilename,
  errnoDetail,
  SafeFileStore,
  SafeFilePathError
} from './SafeFilePath.js';

export interface SaveOptions {
  filename?: string;
  directory?: string;
  overwrite?: boolean;
  /** Exact prior content, or null when the target must not exist. */
  expectedContent?: string | null;
}

export interface SaveResult {
  success: boolean;
  filePath?: string;
  filename?: string;
  error?: string;
  conflict?: boolean;
}

export type RenderedArtifactFormat = 'svg' | 'png';

export class BpmnFileTooLargeError extends Error {
  constructor() {
    super('BPMN import exceeds the configured byte limit');
    this.name = 'BpmnFileTooLargeError';
  }
}

export class MermaidFileTooLargeError extends Error {
  constructor() {
    super('Mermaid import exceeds the configured byte limit');
    this.name = 'MermaidFileTooLargeError';
  }
}

/** Fallback cause when the failure carries no filesystem detail of its own. */
function storageFailureCause(code: SafeFilePathError['code']): string | undefined {
  switch (code) {
    case 'access':
      return 'the workspace is not accessible';
    case 'changed':
      return 'the workspace directory changed since it was resolved';
    case 'busy':
      return 'another writer holds the compare-and-write lock for this diagram';
    case 'not_found':
      return 'the workspace directory does not exist';
    case 'not_file':
      return 'the workspace path is not a directory';
    default:
      return undefined;
  }
}

export class FileManager {
  private defaultDirectory: string;
  private safeFiles: SafeFileStore;

  constructor(defaultDirectory?: string) {
    // Default directory: ~/mcp-bpmn/ on Unix-like, %USERPROFILE%\mcp-bpmn\ on Windows
    this.defaultDirectory = defaultDirectory || process.env.MCP_BPMN_DIAGRAMS_PATH ||
      path.join(os.homedir(), 'mcp-bpmn');
    this.safeFiles = new SafeFileStore(this.defaultDirectory);
  }

  /**
   * Ensure the directory exists, create if it doesn't
   */
  async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * Sanitize filename to prevent security issues
   */
  sanitizeFilename(filename: string): string {
    // Remove or replace unsafe characters
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/\.+/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .substring(0, 255);
  }

  /**
   * Generate a default filename based on current timestamp
   */
  generateDefaultFilename(processName?: string): string {
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .split('.')[0];
    
    const baseName = processName 
      ? this.sanitizeFilename(processName)
      : 'process';
    
    return `${baseName}_${timestamp}.bpmn`;
  }

  /**
   * Read one in-root BPMN file with memory proportional to its validated size.
   * A one-byte probe rejects a file that grows after the post-open size check.
   */
  async readBpmnFile(filename: string, maxBytes: number): Promise<string> {
    return this.readBoundedTextFile(
      filename,
      ['.bpmn'],
      maxBytes,
      () => new BpmnFileTooLargeError(),
      'Unable to read BPMN file'
    );
  }

  async readMermaidFile(filename: string, maxBytes: number): Promise<string> {
    return this.readBoundedTextFile(
      filename,
      ['.mmd', '.mermaid', '.txt'],
      maxBytes,
      () => new MermaidFileTooLargeError(),
      'Unable to read Mermaid file'
    );
  }

  /**
   * Resolve policy first, then size and read the opened file descriptor. A
   * one-byte probe rejects growth after the post-open size check.
   */
  private async readBoundedTextFile(
    filename: string,
    allowedExtensions: string[],
    maxBytes: number,
    tooLarge: () => Error,
    readErrorMessage: string
  ): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Invalid file import byte limit');
    }

    try {
      return await this.safeFiles.read(filename, allowedExtensions, maxBytes);
    } catch (error) {
      if (error instanceof SafeFilePathError && error.code === 'too_large') {
        throw tooLarge();
      }
      if (error instanceof SafeFilePathError) {
        throw error;
      }
      if (error instanceof BpmnFileTooLargeError || error instanceof MermaidFileTooLargeError) {
        throw error;
      }
      throw new Error(readErrorMessage);
    }
  }

  /**
   * Save BPMN XML content to file
   */
  async saveBpmnFile(
    xmlContent: string, 
    options: SaveOptions = {}
  ): Promise<SaveResult> {
    let filename: string | undefined;
    try {
      if (options.directory
        && path.resolve(options.directory) !== path.resolve(this.defaultDirectory)) {
        return {
          success: false,
          error: 'Invalid save directory'
        };
      }

      filename = options.filename;
      if (filename === undefined) {
        // Extract process name from XML if available
        const processNameMatch = xmlContent.match(/name="([^"]+)"/);
        const processName = processNameMatch?.[1];
        filename = this.generateDefaultFilename(processName);
      } else {
        if (path.extname(filename) === '' && !filename.toLowerCase().endsWith('.bpmn')) {
          filename += '.bpmn';
        }
      }

      assertSafeFilename(filename, ['.bpmn']);
      await this.ensureDirectory(this.defaultDirectory);

      const filePath = Object.prototype.hasOwnProperty.call(options, 'expectedContent')
        ? await this.safeFiles.compareAndWrite(
          filename,
          ['.bpmn'],
          options.expectedContent ?? null,
          xmlContent
        )
        : await this.safeFiles.write(
          filename,
          ['.bpmn'],
          xmlContent,
          options.overwrite === true
        );

      return {
        success: true,
        filePath,
        filename
      };

    } catch (error) {
      const conflict = error instanceof SafeFilePathError && error.code === 'conflict';
      return {
        success: false,
        ...(conflict ? { conflict: true } : {}),
        error: error instanceof SafeFilePathError
          ? error.code === 'conflict'
            ? 'Document revision conflict'
            : error.code === 'exists' && filename
            ? `File already exists: ${filename}. Use overwrite option to replace.`
            : error.code === 'access'
              || error.code === 'changed'
              || error.code === 'busy'
              || error.code === 'not_found'
              || error.code === 'not_file'
              ? this.describeStorageFailure('Unable to save BPMN file', filename, error)
              : error.message
          : (error as NodeJS.ErrnoException).code === 'EEXIST' && filename
            ? `File already exists: ${filename}. Use overwrite option to replace.`
            : this.describeStorageFailure('Unable to save BPMN file', filename, error)
      };
    }
  }

  /**
   * Persistence failures name the managed workspace and one coarse cause, so an
   * agent can tell a permission problem from a workspace that disappeared
   * without another round trip. The workspace path is already disclosed by
   * get_diagrams_path and get_workspace; file contents never are.
   */
  private describeStorageFailure(
    action: string,
    filename: string | undefined,
    error: unknown
  ): string {
    const cause = error instanceof SafeFilePathError
      ? error.detail ?? storageFailureCause(error.code)
      : errnoDetail(error);
    return `${action}${filename ? ` "${filename}"` : ''}`
      + ` in workspace ${this.defaultDirectory}${cause ? `: ${cause}` : ''}`;
  }

  async deleteBpmnFile(filename: string): Promise<void> {
    await this.safeFiles.delete(filename, ['.bpmn']);
  }

  /**
   * Persist renderer-owned output through the same anchored managed-store
   * boundary as BPMN documents. Binary PNG bytes must never be coerced through
   * UTF-8, while SVG remains an exact renderer-produced string.
   */
  async saveRenderedArtifact(
    content: string | Buffer,
    filename: string,
    format: RenderedArtifactFormat,
    overwrite: boolean,
    maxBytes: number
  ): Promise<SaveResult> {
    const extension = format === 'svg' ? '.svg' : '.png';
    const byteLength = typeof content === 'string'
      ? Buffer.byteLength(content, 'utf8')
      : content.byteLength;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return { success: false, error: 'Invalid rendered artifact byte limit' };
    }
    if (byteLength > maxBytes) {
      return {
        success: false,
        error: 'Rendered artifact exceeds the configured byte limit'
      };
    }

    try {
      assertSafeFilename(filename, [extension]);
      await this.ensureDirectory(this.defaultDirectory);
      const filePath = await this.safeFiles.write(
        filename,
        [extension],
        content,
        overwrite
      );
      return { success: true, filePath, filename };
    } catch (error) {
      return {
        success: false,
        error: error instanceof SafeFilePathError
          ? error.code === 'exists'
            ? `File already exists: ${filename}. Use overwrite option to replace.`
            : error.code === 'access'
              || error.code === 'changed'
              || error.code === 'busy'
              || error.code === 'not_found'
              || error.code === 'not_file'
              ? this.describeStorageFailure('Unable to save rendered artifact', filename, error)
              : error.message
          : (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? `File already exists: ${filename}. Use overwrite option to replace.`
            : this.describeStorageFailure('Unable to save rendered artifact', filename, error)
      };
    }
  }

  /**
   * Get the default output directory
   */
  getDefaultDirectory(): string {
    return this.defaultDirectory;
  }
}
