import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import {
  assertSafeFilename,
  isPathContained,
  resolveSafeFilePath,
  SafeFilePathError
} from './SafeFilePath.js';

export interface SaveOptions {
  filename?: string;
  directory?: string;
  overwrite?: boolean;
}

export interface SaveResult {
  success: boolean;
  filePath?: string;
  filename?: string;
  error?: string;
}

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

export class FileManager {
  private defaultDirectory: string;

  constructor(defaultDirectory?: string) {
    // Default directory: ~/mcp-bpmn/ on Unix-like, %USERPROFILE%\mcp-bpmn\ on Windows
    this.defaultDirectory = defaultDirectory || process.env.MCP_BPMN_DIAGRAMS_PATH ||
      path.join(os.homedir(), 'mcp-bpmn');
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
   * Validate that the target path is within allowed directory
   */
  validatePath(targetPath: string, allowedDir: string): boolean {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedAllowed = path.resolve(allowedDir);

    return isPathContained(resolvedTarget, resolvedAllowed);
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

    const filePath = await resolveSafeFilePath({
      rootDirectory: this.defaultDirectory,
      filename,
      allowedExtensions,
      access: 'read'
    });

    let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      fileHandle = await fs.open(filePath, 'r');
      const fileInfo = await fileHandle.stat();
      if (!fileInfo.isFile()) {
        throw new Error(readErrorMessage);
      }
      if (fileInfo.size > maxBytes) {
        throw tooLarge();
      }

      const buffer = Buffer.alloc(fileInfo.size);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await fileHandle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead
        );
        if (result.bytesRead === 0) {
          break;
        }
        bytesRead += result.bytesRead;
      }

      const growthProbe = Buffer.alloc(1);
      const growthResult = await fileHandle.read(growthProbe, 0, 1, bytesRead);
      if (growthResult.bytesRead > 0) {
        if (bytesRead >= maxBytes) {
          throw tooLarge();
        }
        throw new Error('File changed while it was being read');
      }
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch (error) {
      if (error instanceof BpmnFileTooLargeError || error instanceof MermaidFileTooLargeError) {
        throw error;
      }
      throw new Error(readErrorMessage);
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }

  /**
   * Save BPMN XML content to file
   */
  async saveBpmnFile(
    xmlContent: string, 
    options: SaveOptions = {}
  ): Promise<SaveResult> {
    try {
      if (options.directory
        && path.resolve(options.directory) !== path.resolve(this.defaultDirectory)) {
        return {
          success: false,
          error: 'Invalid save directory'
        };
      }

      let filename = options.filename;
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

      const filePath = await resolveSafeFilePath({
        rootDirectory: this.defaultDirectory,
        filename,
        allowedExtensions: ['.bpmn'],
        access: 'write'
      });

      // Check if file exists and overwrite is not allowed
      if (!options.overwrite) {
        try {
          await fs.access(filePath);
          return {
            success: false,
            error: `File already exists: ${filename}. Use overwrite option to replace.`
          };
        } catch {
          // File doesn't exist, we can proceed
        }
      }

      // Write beside the destination and rename only after the complete XML is
      // on disk. A failed write/rename therefore leaves the previous diagram
      // intact rather than exposing a truncated file.
      const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
      );
      try {
        await fs.writeFile(temporaryPath, xmlContent, { encoding: 'utf8', flag: 'wx' });
        if (options.overwrite) {
          await fs.rename(temporaryPath, filePath);
        } else {
          // Installing the temporary inode with link is an atomic no-clobber
          // operation. If another writer won the race after the access check,
          // link fails with EEXIST and its file remains untouched.
          await fs.link(temporaryPath, filePath);
        }
      } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }

      return {
        success: true,
        filePath,
        filename
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof SafeFilePathError
          ? error.message
          : 'Unable to save BPMN file'
      };
    }
  }

  /**
   * List BPMN files in the output directory
   */
  async listBpmnFiles(directory?: string): Promise<string[]> {
    const targetDir = directory || this.defaultDirectory;
    
    try {
      await this.ensureDirectory(targetDir);
      const files = await fs.readdir(targetDir);
      return files
        .filter(file => file.endsWith('.bpmn'))
        .sort((a, b) => b.localeCompare(a)); // Sort by name, newest first
    } catch {
      return [];
    }
  }

  /**
   * Get the default output directory
   */
  getDefaultDirectory(): string {
    return this.defaultDirectory;
  }

  /**
   * Get file stats
   */
  async getFileInfo(filePath: string): Promise<{
    exists: boolean;
    size?: number;
    modified?: Date;
  }> {
    try {
      const stats = await fs.stat(filePath);
      return {
        exists: true,
        size: stats.size,
        modified: stats.mtime
      };
    } catch {
      return {
        exists: false
      };
    }
  }
}
