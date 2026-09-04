/**
 * Machine-readable failures for the MCP tool boundary.
 *
 * Every failed tool call returns a stable `code` and, where one exists, a
 * `recovery` sentence naming the next action. Agents branch on the code rather
 * than pattern-matching English prose, and hosts that surface structured
 * content can render the recovery hint directly.
 */
export const TOOL_ERROR_CODES = [
  /** A tool needing an active diagram was called before one was opened. */
  'no_current_diagram',
  /** Arguments failed schema validation before the tool ran. */
  'invalid_arguments',
  /** A referenced element id does not exist in the active diagram. */
  'element_not_found',
  /** A referenced connection id does not exist in the active diagram. */
  'connection_not_found',
  /** The id exists but names a different kind of object than the tool takes. */
  'wrong_object_kind',
  /** A required owning process or containing scope was missing or wrong. */
  'owner_or_scope_invalid',
  /** The requested change would produce invalid BPMN. */
  'invalid_bpmn',
  /** A geometry change was rejected for collisions or containment. */
  'geometry_rejected',
  /**
   * Optimistic-concurrency guard failed; refresh and retry. This and the three
   * codes below are raised by the engine's typed conflict errors and predate
   * the rest of this taxonomy; they are listed here so the set of codes a
   * caller can receive is complete.
   */
  'revision_conflict',
  /** Compare-and-set on BPMN DI geometry failed. */
  'geometry_conflict',
  /** Compare-and-set on connection semantics failed. */
  'semantic_conflict',
  /** No collision-free route could be found for a connection. */
  'routing_failed',
  /** A managed file already exists and the call did not authorize replacing it. */
  'file_exists',
  /** A managed file or diagram could not be found. */
  'file_not_found',
  /** Reading or writing the managed workspace failed. */
  'storage_unavailable',
  /** Diagram rendering needs a browser that is unavailable or failed to start. */
  'render_unavailable',
  /** A declared resource limit would be exceeded. */
  'limit_exceeded',
  /** The server is shutting down and is no longer accepting calls. */
  'server_shutting_down',
  /** Anything not yet classified. */
  'unexpected_error'
] as const;

export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];

/**
 * An error carrying everything an agent needs to react: what went wrong, why,
 * and what to do next. Additional `details` are merged into the structured
 * content so callers can act without re-parsing the message.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly recovery?: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { recovery?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.recovery = options.recovery;
    this.details = options.details ?? {};
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}
