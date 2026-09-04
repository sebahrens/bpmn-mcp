export type NodeType = 
  | 'start'
  | 'end'
  | 'process'
  | 'decision'
  | 'subprocess'
  | 'data'
  | 'terminator';

export type EdgeType =
  | 'directed'
  | 'labeled'
  | 'dotted';

/**
 * Labels that carry no information beyond the event semantics they already
 * imply. Matching is exact on the trimmed, lower-cased label: an incidental
 * substring ("Restart", "Send Invoice", "Pending") is a real name and must be
 * preserved. Shared so that type inference and BPMN naming agree.
 */
export const GENERIC_EVENT_LABELS: Record<'start' | 'end', ReadonlySet<string>> = {
  start: new Set(['start', 'begin']),
  end: new Set(['end', 'stop', 'finish'])
};

export function isGenericEventLabel(type: 'start' | 'end', label: string): boolean {
  return GENERIC_EVENT_LABELS[type].has(label.trim().toLowerCase());
}

/**
 * BPMN refinements an author can steer from Mermaid with the `:::class` node
 * suffix, which every Mermaid renderer accepts, so a steered diagram still
 * draws (mcp-bpmn-j21.12). The suffix refines what the shape already decided;
 * it never changes a task into a gateway.
 */
export type TaskSubtype =
  | 'user'
  | 'service'
  | 'script'
  | 'businessRule'
  | 'manual'
  | 'receive'
  | 'send';

export type GatewaySubtype =
  | 'parallel'
  | 'inclusive'
  | 'eventBased'
  | 'complex';

/** Event definitions, spelled as the BPMN event-definition names. */
export type EventSubtype =
  | 'message'
  | 'timer'
  | 'error'
  | 'signal'
  | 'conditional'
  | 'escalation'
  | 'compensation'
  | 'cancel'
  | 'terminate';

export type NodeSubtype = TaskSubtype | GatewaySubtype | EventSubtype;

/**
 * The Mermaid node types each subtype may refine. For events this is BPMN's own
 * legality table (see EVENT_DEFINITION_RULES in BpmnDocument): a timer can start
 * or interrupt a flow but cannot end one, and an error can only end one. Writing
 * a subtype where BPMN does not allow it is reported against the author's own
 * Mermaid, not against generated BPMN ids much later.
 */
export const SUBTYPE_HOSTS: Record<NodeSubtype, ReadonlySet<NodeType>> = {
  user: new Set<NodeType>(['process']),
  service: new Set<NodeType>(['process']),
  script: new Set<NodeType>(['process']),
  businessRule: new Set<NodeType>(['process']),
  manual: new Set<NodeType>(['process']),
  receive: new Set<NodeType>(['process']),
  send: new Set<NodeType>(['process']),
  parallel: new Set<NodeType>(['decision']),
  inclusive: new Set<NodeType>(['decision']),
  eventBased: new Set<NodeType>(['decision']),
  complex: new Set<NodeType>(['decision']),
  message: new Set<NodeType>(['start', 'end', 'terminator']),
  timer: new Set<NodeType>(['start', 'terminator']),
  signal: new Set<NodeType>(['start', 'end', 'terminator']),
  conditional: new Set<NodeType>(['start', 'terminator']),
  escalation: new Set<NodeType>(['end', 'terminator']),
  compensation: new Set<NodeType>(['end', 'terminator']),
  error: new Set<NodeType>(['end']),
  cancel: new Set<NodeType>(['end']),
  terminate: new Set<NodeType>(['end'])
};

/**
 * An intermediate event carrying one of these catches rather than throws. A
 * mid-flow message is therefore received; to send one, use a send task
 * (`:::send`), which is how BPMN says it anyway.
 */
export const INTERMEDIATE_CATCH_SUBTYPES: ReadonlySet<NodeSubtype> = new Set<NodeSubtype>([
  'message',
  'timer',
  'conditional',
  'signal'
]);

/**
 * Class names that name the default a shape already carries. They are accepted
 * so an author can spell every branch of a diagram the same way, and refine
 * nothing.
 */
export const NEUTRAL_SUBTYPE_CLASSES: Record<string, NodeType> = {
  task: 'process',
  exclusive: 'decision'
};

/**
 * Class-name spellings, matched on the name with case, `-` and `_` ignored, so
 * `:::businessRule`, `:::business-rule` and `:::BUSINESS_RULE` are one class.
 */
export const SUBTYPE_CLASS_NAMES: Record<string, NodeSubtype> = Object.fromEntries(
  (Object.keys(SUBTYPE_HOSTS) as NodeSubtype[]).map(subtype => [normalizeSubtypeClass(subtype), subtype])
);

export function normalizeSubtypeClass(name: string): string {
  return name.replace(/[-_]/g, '').toLowerCase();
}

export interface MermaidNode {
  id: string;
  type: NodeType;
  label: string;
  /** BPMN refinement asked for with `:::class`, already checked against `type`. */
  subtype?: NodeSubtype;
}

export interface MermaidEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
}

export interface MermaidSubgraph {
  id: string;
  title: string;
  nodes: string[];
  subgraphs?: MermaidSubgraph[];
}

export interface MermaidAST {
  type: 'flowchart';
  direction: 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  subgraphs: MermaidSubgraph[];
}

export type ParseErrorCode =
  | 'EMPTY_DIAGRAM'
  | 'MALFORMED_HEADER'
  | 'MALFORMED_NODE'
  | 'MALFORMED_EDGE'
  | 'MALFORMED_SUBGRAPH'
  | 'UNSUPPORTED_SHAPE'
  | 'UNSUPPORTED_CONNECTOR'
  | 'UNEXPECTED_SUBGRAPH_END'
  | 'UNCLOSED_SUBGRAPH'
  | 'UNSUPPORTED_NESTED_SUBGRAPH'
  | 'UNKNOWN_SYNTAX'
  | 'DUPLICATE_SUBGRAPH'
  | 'MISSING_SUBGRAPH_OWNER'
  | 'MULTIPLE_SUBGRAPH_OWNERS'
  | 'UNSUPPORTED_EDGE_ENDPOINT'
  | 'INVALID_NODE_SUBTYPE';

export type ParseWarningCode =
  | 'UNSUPPORTED_DIRECTIVE'
  | 'UNSUPPORTED_EDGE_STYLE'
  | 'DUPLICATE_NODE'
  | 'MISSING_START'
  | 'MISSING_END'
  | 'DISCONNECTED_NODE'
  | 'IMPLICIT_PARALLEL_SPLIT';

export type ParseDiagnosticCode = ParseErrorCode | ParseWarningCode;

export interface ParseDiagnostic<TCode extends ParseDiagnosticCode> {
  line: number;
  column: number;
  message: string;
  code: TCode;
  source: string;
}

export interface ParseError extends ParseDiagnostic<ParseErrorCode> {
  severity: 'error';
}

export interface ParseWarning extends ParseDiagnostic<ParseWarningCode> {
  severity: 'warning';
}

export interface ParseResult {
  ast?: MermaidAST;
  errors: ParseError[];
  warnings: ParseWarning[];
}
