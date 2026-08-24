import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleAnchor = process.argv[1] && existsSync(process.argv[1])
  ? realpathSync(process.argv[1])
  : resolve(process.cwd(), 'package.json');
const requireFromHere = createRequire(moduleAnchor);

export const BPMN_AUTO_LAYOUT_VERSION = '2.0.0-alpha.2' as const;

export interface BpmnLayoutDiagnostic {
  code: string;
  message: string;
  elementId?: string;
  relatedElementIds?: string[];
}

export interface BpmnLayoutResult {
  xml: string;
  warnings: BpmnLayoutDiagnostic[];
}

export interface BpmnLayoutAdapter {
  readonly id?: string;
  readonly version?: string;
  layout(xml: string): Promise<BpmnLayoutResult>;
}

export type BpmnAutoLayoutV2Process = (xml: string) => Promise<unknown>;

export interface LayoutComplexityLimits {
  maxLayoutElements: number;
  maxLayoutConnections: number;
  maxLayoutDensity: number;
  maxLayoutBytes: number;
}

let activeLayoutSubprocesses = 0;
const layoutSubprocesses = new Set<ReturnType<typeof spawn>>();

export async function closeActiveLayoutSubprocesses(): Promise<void> {
  await Promise.all(Array.from(layoutSubprocesses, child => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
    child.kill('SIGKILL');
  })));
}

export class BpmnLayoutError extends Error {
  readonly code: string;
  readonly elementId?: string;
  readonly relatedElementIds?: string[];
  override readonly cause?: unknown;

  constructor(diagnostic: BpmnLayoutDiagnostic, cause?: unknown) {
    super(formatBpmnLayoutDiagnostic(diagnostic));
    this.name = 'BpmnLayoutError';
    this.code = diagnostic.code;
    this.elementId = diagnostic.elementId;
    this.relatedElementIds = diagnostic.relatedElementIds;
    this.cause = cause;
  }
}

/**
 * The sole production boundary around bpmn-auto-layout@2.0.0-alpha.2.
 * The package is an alpha without declarations, so its runtime values are
 * validated and copied into package-neutral project types here.
 */
export class BpmnAutoLayoutV2Adapter implements BpmnLayoutAdapter {
  readonly id = 'bpmn-auto-layout';
  readonly version = BPMN_AUTO_LAYOUT_VERSION;
  private readonly layoutProcess: BpmnAutoLayoutV2Process;

  constructor(
    layoutProcess?: BpmnAutoLayoutV2Process,
    timeoutMs = 5_000,
    maxConcurrentLayouts = 2
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Invalid BPMN layout timeout');
    }
    if (!Number.isSafeInteger(maxConcurrentLayouts) || maxConcurrentLayouts <= 0) {
      throw new Error('Invalid BPMN layout concurrency limit');
    }
    this.layoutProcess = layoutProcess
      ?? (xml => withLayoutSubprocessSlot(
        maxConcurrentLayouts,
        () => loadSelectedLayoutInSubprocess(xml, timeoutMs)
      ));
  }

  async layout(xml: string): Promise<BpmnLayoutResult> {
    let output: unknown;
    try {
      output = await this.layoutProcess(xml);
    } catch (error) {
      throw normalizeLayoutError(error);
    }

    if (!isRecord(output)
      || typeof output.xml !== 'string'
      || !Array.isArray(output.warnings)) {
      throw new BpmnLayoutError({
        code: 'INVALID_ADAPTER_RESULT',
        message: `bpmn-auto-layout@${this.version} returned an invalid result`
      });
    }

    return {
      xml: output.xml,
      warnings: output.warnings.map(normalizeLayoutWarning)
    };
  }
}

export function assertLayoutComplexity(
  elementCount: number,
  connectionCount: number,
  xmlByteLength: number,
  limits: LayoutComplexityLimits
): void {
  if (elementCount > limits.maxLayoutElements) {
    throw new Error(`Auto-layout rejected: element limit ${limits.maxLayoutElements} exceeded`);
  }
  if (connectionCount > limits.maxLayoutConnections) {
    throw new Error(
      `Auto-layout rejected: connection limit ${limits.maxLayoutConnections} exceeded`
    );
  }
  const density = connectionCount / Math.max(elementCount, 1);
  if (density > limits.maxLayoutDensity) {
    throw new Error(
      `Auto-layout rejected: connection density limit ${limits.maxLayoutDensity} exceeded`
    );
  }
  if (xmlByteLength > limits.maxLayoutBytes) {
    throw new Error(`Auto-layout rejected: byte limit ${limits.maxLayoutBytes} exceeded`);
  }
}

async function withLayoutSubprocessSlot<T>(
  maxConcurrentLayouts: number,
  operation: () => Promise<T>
): Promise<T> {
  if (activeLayoutSubprocesses >= maxConcurrentLayouts) {
    throw new BpmnLayoutError({
      code: 'LAYOUT_BUSY',
      message: `Concurrent auto-layout limit ${maxConcurrentLayouts} reached`
    });
  }
  activeLayoutSubprocesses++;
  try {
    return await operation();
  } finally {
    activeLayoutSubprocesses--;
  }
}

export function formatBpmnLayoutDiagnostic(diagnostic: BpmnLayoutDiagnostic): string {
  const element = diagnostic.elementId ? ` (${diagnostic.elementId})` : '';
  return `${diagnostic.code}: ${diagnostic.message}${element}`;
}

function normalizeLayoutWarning(value: unknown): BpmnLayoutDiagnostic {
  if (!isRecord(value)) {
    return {
      code: 'LAYOUT_WARNING',
      message: value instanceof Error ? value.message : String(value)
    };
  }
  return {
    code: stringValue(value.code, 'LAYOUT_WARNING'),
    message: stringValue(value.message, String(value)),
    ...(typeof value.elementId === 'string' ? { elementId: value.elementId } : {}),
    ...(Array.isArray(value.relatedElementIds)
      ? { relatedElementIds: value.relatedElementIds.filter(isString) }
      : {})
  };
}

/**
 * Always isolate the synchronous alpha layout implementation. A Promise race
 * cannot interrupt CPU work on the server thread, while this subprocess can be
 * terminated at the documented deadline.
 */
async function loadSelectedLayoutInSubprocess(
  xml: string,
  timeoutMs: number
): Promise<unknown> {
  // Eval modules resolve bare imports from the caller's cwd, not this package.
  const layoutModuleUrl = pathToFileURL(
    requireFromHere.resolve('bpmn-auto-layout')
  ).href;
  const runner = `
    let source = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) source += chunk;
    try {
      const { layoutProcess } = await import(process.argv[1]);
      const output = await layoutProcess(source);
      process.stdout.write(JSON.stringify({
        result: {
          xml: output.xml,
          warnings: (output.warnings || []).map(warning => ({
            code: warning.code,
            elementId: warning.elementId,
            message: warning.message,
            relatedElementIds: warning.relatedElementIds
          }))
        }
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        error: {
          code: error?.code ?? 'LAYOUT_FAILED',
          elementId: error && error.elementId,
          message: error?.message ?? String(error),
          relatedElementIds: error && error.relatedElementIds
        }
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', runner, layoutModuleUrl],
      {
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    layoutSubprocesses.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutError: Error | undefined;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    // A timeout can kill the child while a large XML payload is still being
    // flushed. Consume the resulting EPIPE instead of letting the writable
    // stream emit an unhandled error on the server process.
    child.stdin.on('error', error => {
      if (!settled && !timeoutError) finish(error);
    });
    child.on('error', error => {
      if (!timeoutError) finish(error);
    });
    child.on('close', code => {
      layoutSubprocesses.delete(child);
      if (timeoutError) {
        finish(timeoutError);
        return;
      }
      if (code !== 0) {
        finish(new Error(`bpmn-auto-layout subprocess exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const payload: unknown = JSON.parse(stdout);
        if (!isRecord(payload)) throw new Error('invalid response');
        if (isRecord(payload.error)) {
          throw new BpmnLayoutError(normalizeLayoutWarning(payload.error));
        }
        finish(undefined, payload.result);
      } catch (error) {
        finish(error instanceof Error
          ? error
          : new Error(`Invalid bpmn-auto-layout subprocess response: ${String(error)}`));
      }
    });
    const timeout = setTimeout(() => {
      timeoutError = new Error(`bpmn-auto-layout subprocess exceeded ${timeoutMs}ms`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdin.end(xml);
  });
}

function normalizeLayoutError(error: unknown): BpmnLayoutError {
  if (error instanceof BpmnLayoutError) return error;
  if (!isRecord(error)) {
    return new BpmnLayoutError({
      code: 'LAYOUT_FAILED',
      message: String(error)
    }, error);
  }
  return new BpmnLayoutError({
    code: stringValue(error.code, 'LAYOUT_FAILED'),
    message: stringValue(error.message, 'BPMN layout failed'),
    ...(typeof error.elementId === 'string' ? { elementId: error.elementId } : {}),
    ...(Array.isArray(error.relatedElementIds)
      ? { relatedElementIds: error.relatedElementIds.filter(isString) }
      : {})
  }, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
