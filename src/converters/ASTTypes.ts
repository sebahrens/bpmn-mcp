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

export interface MermaidNode {
  id: string;
  type: NodeType;
  label: string;
  shape?: string;
  style?: Record<string, string>;
  position?: {
    row?: number;
    column?: number;
  };
}

export interface MermaidEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
  style?: Record<string, string>;
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
  | 'UNEXPECTED_SUBGRAPH_END'
  | 'UNCLOSED_SUBGRAPH'
  | 'UNSUPPORTED_NESTED_SUBGRAPH'
  | 'UNKNOWN_SYNTAX'
  | 'DUPLICATE_EDGE'
  | 'DUPLICATE_SUBGRAPH'
  | 'MISSING_SUBGRAPH_OWNER'
  | 'MULTIPLE_SUBGRAPH_OWNERS'
  | 'UNSUPPORTED_EDGE_ENDPOINT';

export type ParseWarningCode =
  | 'UNSUPPORTED_DIRECTIVE'
  | 'UNSUPPORTED_EDGE_STYLE'
  | 'DUPLICATE_NODE'
  | 'MISSING_START'
  | 'MISSING_END'
  | 'DISCONNECTED_NODE';

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
