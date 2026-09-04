import {
  GENERIC_EVENT_LABELS,
  NEUTRAL_SUBTYPE_CLASSES,
  SUBTYPE_CLASS_NAMES,
  SUBTYPE_HOSTS,
  normalizeSubtypeClass
} from './ASTTypes.js';
import type {
  EdgeType,
  MermaidAST,
  MermaidEdge,
  MermaidNode,
  MermaidSubgraph,
  NodeType,
  ParseErrorCode,
  ParseError,
  ParseResult,
  ParseWarningCode,
  ParseWarning
} from './ASTTypes.js';

interface SourceLocation {
  line: number;
  column: number;
  source: string;
}

interface ParsedEndpoint {
  node: MermaidNode;
  start: number;
  end: number;
  explicit: boolean;
  classAnnotation?: {
    index: number;
    name: string;
  };
}

interface ParsedEndpointList {
  endpoints: ParsedEndpoint[];
  end: number;
}

interface StoredNode {
  node: MermaidNode;
  explicit: boolean;
}

interface EndpointFailure {
  code: 'MALFORMED_NODE' | 'MALFORMED_EDGE' | 'UNSUPPORTED_SHAPE';
  index: number;
  message: string;
}

/** A styling nuance Mermaid expresses that BPMN sequence flows cannot carry. */
type DroppedEdgeStyle = 'thick' | 'undirected';

interface ParsedConnector {
  type: EdgeType;
  label?: string;
  dropped: DroppedEdgeStyle[];
  end: number;
}

interface ConnectorFailure {
  code: 'MALFORMED_EDGE' | 'UNSUPPORTED_CONNECTOR';
  index: number;
  message: string;
}

interface MatchedConnector {
  type: EdgeType;
  label?: string;
  dropped: DroppedEdgeStyle[];
  length: number;
}

/** One `:::class` suffix, kept until the node's final type is known. */
interface PendingClassAnnotation {
  nodeId: string;
  name: string;
  location: SourceLocation;
}

interface OpenSubgraph {
  id: string;
  location: SourceLocation;
  /** False for a subgraph whose declaration was already reported as malformed. */
  declared: boolean;
}

/**
 * One Mermaid node shape. Supported shapes carry the BPMN-bound `type`;
 * everything else is valid Mermaid the BPMN subset deliberately refuses rather
 * than approximating, and carries the name and the supported alternative that
 * the diagnostic quotes back to the author.
 */
interface ShapeDefinition {
  open: string;
  close: string;
  type?: NodeType;
  name?: string;
  alternative?: string;
  quoted: RegExp;
  plain: RegExp;
}

interface ShapeMatch {
  shape: ShapeDefinition;
  label: string;
  length: number;
}

interface SubgraphDeclaration {
  id: string;
  title: string;
}

/** Mermaid entity codes (`#quot;`, `#35;`) usable inside a quoted label. */
const NAMED_ENTITY_CODES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  semi: ';',
  colon: ':',
  hash: '#',
  nbsp: '\u00a0'
};

interface ConnectorPattern {
  pattern: RegExp;
  type: EdgeType;
  dropped: DroppedEdgeStyle[];
}

/** Connectors with no inline label, longest-arrow form first. */
const BARE_CONNECTORS: ConnectorPattern[] = [
  { pattern: /^-\.+->/, type: 'dotted', dropped: [] },
  { pattern: /^-{2,}>/, type: 'directed', dropped: [] },
  { pattern: /^={2,}>/, type: 'directed', dropped: ['thick'] },
  { pattern: /^-\.+-(?!>)/, type: 'dotted', dropped: ['undirected'] },
  { pattern: /^-{3,}(?!>)/, type: 'directed', dropped: ['undirected'] },
  { pattern: /^={3,}(?!>)/, type: 'directed', dropped: ['thick', 'undirected'] }
];

/**
 * Connectors carrying Mermaid's inline label. The body is non-greedy and the
 * terminator is captured, so the earliest closing link wins and the label keeps
 * any `-` or `>` that precedes it.
 */
const LABELED_CONNECTORS: ConnectorPattern[] = [
  { pattern: /^-\.\s*(.+?)\s*(\.-+>?)/, type: 'dotted', dropped: [] },
  { pattern: /^={2}\s*(.+?)\s*(={2,}>?)/, type: 'directed', dropped: ['thick'] },
  { pattern: /^-{2}\s*(.+?)\s*(-{2,}>|-{3,}(?!>))/, type: 'directed', dropped: [] }
];

/** Valid Mermaid connectors the BPMN subset refuses, with the way out. */
const UNSUPPORTED_CONNECTORS: Array<{ pattern: RegExp; alternative: string }> = [
  {
    pattern: /^~{3,}/,
    alternative: 'an invisible link has no BPMN counterpart, so remove it or use --> for a sequence flow'
  },
  {
    pattern: /^<(?:-{2,}>|={2,}>|-\.+->)/,
    alternative: 'a BPMN sequence flow is one-directional, so use --> once per direction'
  },
  {
    pattern: /^(?:-{2,}|={2,})[ox](?=\s|$|[A-Za-z0-9_])/,
    alternative: 'circle and cross arrowheads have no BPMN counterpart, so use --> for a sequence flow'
  }
];

/** How each Mermaid node type is named back to the author in a diagnostic. */
const SUBTYPE_HOST_DESCRIPTIONS: Record<NodeType, string> = {
  process: 'a task',
  decision: 'a gateway',
  start: 'a start event',
  end: 'an end event',
  terminator: 'an intermediate event',
  subprocess: 'a subprocess',
  data: 'a data object'
};

/** One `;`-separated statement, with its 0-based start offset in the raw line. */
interface Statement {
  text: string;
  index: number;
}

export class MermaidParser {
  private readonly directionPattern = /^(graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*$/i;
  private readonly unsupportedDirectivePattern = /^(classDef|class|style|linkStyle|click|direction)\b/i;
  private readonly otherDiagramPattern = /^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|sankey-beta)\b/i;

  /**
   * Shapes are matched longest-delimiter first, so `[(DB)]` is recognised as a
   * database rather than swallowed by the generic rectangle.
   */
  private readonly shapes: ShapeDefinition[] = ([
    { open: '[[', close: ']]', type: 'data' },
    {
      open: '[(',
      close: ')]',
      name: 'database (cylinder)',
      alternative: 'use ID[[Label]] for a data object, or ID[Label] for a task'
    },
    { open: '[/', close: '/]', type: 'subprocess' },
    { open: '[/', close: '\\]', name: 'trapezoid', alternative: 'use ID[Label] for a task' },
    { open: '[\\', close: '/]', name: 'alternate trapezoid', alternative: 'use ID[Label] for a task' },
    {
      open: '[\\',
      close: '\\]',
      name: 'alternate parallelogram',
      alternative: 'use ID[/Label/] for a subprocess, or ID[Label] for a task'
    },
    { open: '[', close: ']', type: 'process' },
    { open: '(((', close: ')))', name: 'double circle', alternative: 'use ID((Label)) for an event' },
    {
      open: '([',
      close: '])',
      name: 'stadium',
      alternative: 'use ID[Label] for a task, or ID((Label)) for an event'
    },
    { open: '((', close: '))', type: 'terminator' },
    { open: '(', close: ')', name: 'rounded rectangle', alternative: 'use ID[Label] for a task' },
    { open: '{{', close: '}}', name: 'hexagon', alternative: 'use ID{Label} for an exclusive gateway' },
    { open: '{', close: '}', type: 'decision' },
    { open: '>', close: ']', name: 'asymmetric', alternative: 'use ID[Label] for a task' }
  ] as Array<Omit<ShapeDefinition, 'quoted' | 'plain'>>).map(shape => ({
    ...shape,
    quoted: new RegExp(`^${this.escapeLiteral(shape.open)}\\s*"([^"]*)"\\s*${this.escapeLiteral(shape.close)}`),
    plain: new RegExp(`^${this.escapeLiteral(shape.open)}(.+?)${this.escapeLiteral(shape.close)}`)
  }));

  parse(mermaidCode: string): ParseResult {
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];
    const lines = mermaidCode.split('\n');
    const ast: MermaidAST = {
      type: 'flowchart',
      direction: 'TD',
      nodes: [],
      edges: [],
      subgraphs: []
    };
    const nodeMap = new Map<string, StoredNode>();
    const nodeLocations = new Map<string, SourceLocation>();
    const edgeLocations = new Map<MermaidEdge, SourceLocation>();
    const edgeIdOccurrences = new Map<string, number>();
    const subgraphLocations = new Map<MermaidSubgraph, SourceLocation>();
    const openSubgraphs: OpenSubgraph[] = [];
    const classAnnotations: PendingClassAnnotation[] = [];
    let firstContentLocation: SourceLocation | undefined;
    let recognizedDocumentSyntax = false;

    for (let index = 0; index < lines.length; index++) {
      const source = lines[index];
      const lineTrimmed = source.trim();
      const lineLocation: SourceLocation = {
        line: index + 1,
        column: source.length - source.trimStart().length + 1,
        source
      };

      if (!lineTrimmed) continue;

      // Comments are evaluated per line, before statement splitting, so that a
      // semicolon inside comment prose never starts a new statement.
      if (lineTrimmed.startsWith('%%{')) {
        warnings.push(this.warning(
          'UNSUPPORTED_DIRECTIVE',
          lineLocation,
          'Unsupported Mermaid initialization directive; ignored'
        ));
        firstContentLocation ??= lineLocation;
        continue;
      }
      if (lineTrimmed.startsWith('%%')) continue;

      for (const statement of this.splitStatements(source)) {
        const trimmed = statement.text;
        const location: SourceLocation = {
          line: index + 1,
          column: statement.index + 1,
          source
        };

        // A trailing comment ends the line: everything after it is prose.
        if (trimmed.startsWith('%%')) break;

        firstContentLocation ??= location;

        if (/^(graph|flowchart)(?:\b|TD|TB|LR|RL|BT)/i.test(trimmed)) {
          const directionMatch = trimmed.match(this.directionPattern);
          if (!directionMatch) {
            errors.push(this.error(
              'MALFORMED_HEADER',
              this.at(location, this.headerErrorIndex(trimmed)),
              'Expected "graph" or "flowchart" followed by TD, TB, LR, RL, or BT'
            ));
          } else {
            ast.direction = directionMatch[2].toUpperCase() as MermaidAST['direction'];
            recognizedDocumentSyntax = true;
          }
          continue;
        }

        if (this.otherDiagramPattern.test(trimmed)) {
          errors.push(this.error(
            'UNKNOWN_SYNTAX',
            location,
            'Only Mermaid graph and flowchart diagrams can be converted to BPMN'
          ));
          continue;
        }

        if (/^subgraph\b/i.test(trimmed)) {
          const declaration = this.parseSubgraphDeclaration(trimmed, ast.subgraphs);
          if (!declaration) {
            errors.push(this.error(
              'MALFORMED_SUBGRAPH',
              this.at(location, this.subgraphErrorIndex(trimmed)),
              'Expected subgraph syntax: subgraph <id>[<title>], subgraph "<title>", or subgraph <title>'
            ));
            // The subgraph is still open as far as the author is concerned, so
            // its "end" must not be reported a second time as unexpected. The
            // placeholder ID cannot match a Mermaid identifier, so the open
            // subgraph collects no nodes.
            openSubgraphs.push({ id: `#malformed_${openSubgraphs.length}`, location, declared: false });
            continue;
          }

          const subgraph: MermaidSubgraph = {
            id: declaration.id,
            title: declaration.title,
            nodes: []
          };
          if (openSubgraphs.length > 0) {
            errors.push(this.error(
              'UNSUPPORTED_NESTED_SUBGRAPH',
              location,
              'Nested Mermaid subgraphs are not supported for BPMN conversion'
            ));
          }
          ast.subgraphs.push(subgraph);
          subgraphLocations.set(subgraph, location);
          openSubgraphs.push({ id: subgraph.id, location, declared: true });
          recognizedDocumentSyntax = true;
          continue;
        }

        if (/^end\b/i.test(trimmed)) {
          if (trimmed !== 'end') {
            errors.push(this.error(
              'MALFORMED_SUBGRAPH',
              this.at(location, 3),
              'Subgraph terminator must be exactly "end"'
            ));
          } else if (openSubgraphs.length === 0) {
            errors.push(this.error(
              'UNEXPECTED_SUBGRAPH_END',
              location,
              'Unexpected subgraph terminator without a matching subgraph'
            ));
          } else {
            openSubgraphs.pop();
          }
          continue;
        }

        const directiveMatch = trimmed.match(this.unsupportedDirectivePattern);
        if (directiveMatch) {
          warnings.push(this.warning(
            'UNSUPPORTED_DIRECTIVE',
            location,
            `Unsupported Mermaid directive "${directiveMatch[1]}"; ignored`
          ));
          continue;
        }

        this.parseStructuralLine(
          trimmed,
          location,
          ast,
          nodeMap,
          nodeLocations,
          edgeLocations,
          edgeIdOccurrences,
          openSubgraphs,
          classAnnotations,
          errors,
          warnings
        );
        recognizedDocumentSyntax ||= this.hasDeclarationlessStructure(trimmed);
      }
    }

    for (const openSubgraph of openSubgraphs) {
      // A malformed declaration was already reported once; a second diagnostic
      // for the "end" it never got would just be noise.
      if (!openSubgraph.declared) continue;
      errors.push(this.error(
        'UNCLOSED_SUBGRAPH',
        openSubgraph.location,
        `Subgraph "${openSubgraph.id}" is missing a closing "end"`
      ));
    }

    this.inferNodeTypes(ast);
    // Subtype steering is resolved only now: an event's legal definitions
    // depend on whether it ended up a start, an end or an intermediate event,
    // which type inference has only just decided (mcp-bpmn-j21.12).
    this.applyClassAnnotations(ast, classAnnotations, errors, warnings);
    // A line that failed to parse takes its nodes, its edges and its subgraph
    // membership with it, so every analysis that reads the graph as a whole is
    // now reading a graph the author never wrote. One unsupported shape used to
    // produce three further diagnostics pointing at correctly written nodes
    // (mcp-bpmn-j21.13). Those analyses are withheld until the structure parses;
    // nothing is lost, because a document with errors cannot convert anyway and
    // they all run on the next attempt.
    const structureIsComplete = errors.length === 0;
    this.validateAST(
      ast,
      nodeLocations,
      edgeLocations,
      subgraphLocations,
      firstContentLocation ?? { line: 1, column: 1, source: lines[0] ?? '' },
      recognizedDocumentSyntax,
      structureIsComplete,
      errors,
      warnings
    );

    errors.sort(this.compareDiagnostics);
    warnings.sort(this.compareDiagnostics);

    return {
      ast: errors.length === 0 ? ast : undefined,
      errors,
      warnings
    };
  }

  /**
   * Splits a raw line into `;`-separated Mermaid statements, the canonical
   * separator in Mermaid's own documentation. Semicolons inside shapes
   * (`[...]`, `{...}`, `(...)`), quoted text, edge labels (`|...|`) or HTML
   * entities (`&#59;`, `&amp;#59;`) belong to the label and never split.
   * Each statement keeps its 0-based offset in the line so that diagnostics
   * still report the author's real column.
   */
  private splitStatements(source: string): Statement[] {
    const statements: Statement[] = [];
    let depth = 0;
    let inQuotes = false;
    let inEdgeLabel = false;
    let segmentStart = 0;

    const push = (start: number, end: number): void => {
      const segment = source.slice(start, end);
      const text = segment.trim();
      if (text) statements.push({ text, index: start + (segment.length - segment.trimStart().length) });
    };

    for (let cursor = 0; cursor < source.length; cursor++) {
      const character = source[cursor];
      if (character === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (inQuotes) continue;
      if (character === '&') {
        const entity = source.slice(cursor).match(/^&#?[0-9A-Za-z]+;/);
        if (entity) {
          cursor += entity[0].length - 1;
          continue;
        }
      }
      if (character === '[' || character === '(' || character === '{') {
        depth++;
        continue;
      }
      if (character === ']' || character === ')' || character === '}') {
        if (depth > 0) depth--;
        continue;
      }
      // A trailing comment ends the statement text; semicolons inside its prose
      // are not separators.
      if (character === '%' && source[cursor + 1] === '%' && depth === 0 && !inEdgeLabel) break;
      if (character === '|' && depth === 0) {
        inEdgeLabel = !inEdgeLabel;
        continue;
      }
      if (character === ';' && depth === 0 && !inEdgeLabel) {
        push(segmentStart, cursor);
        segmentStart = cursor + 1;
      }
    }
    push(segmentStart, source.length);

    return statements;
  }

  private parseStructuralLine(
    text: string,
    location: SourceLocation,
    ast: MermaidAST,
    nodeMap: Map<string, StoredNode>,
    nodeLocations: Map<string, SourceLocation>,
    edgeLocations: Map<MermaidEdge, SourceLocation>,
    edgeIdOccurrences: Map<string, number>,
    openSubgraphs: OpenSubgraph[],
    classAnnotations: PendingClassAnnotation[],
    errors: ParseError[],
    warnings: ParseWarning[]
  ): void {
    const first = this.parseEndpointList(text, 0);
    if ('message' in first) {
      errors.push(this.error(first.code, this.at(location, first.index), first.message));
      return;
    }

    let cursor = this.skipWhitespace(text, first.end);
    if (cursor === text.length) {
      for (const endpoint of first.endpoints) {
        this.recordClassAnnotation(endpoint, location, classAnnotations);
        this.addNode(
          endpoint.node,
          this.at(location, endpoint.start),
          true,
          ast,
          nodeMap,
          nodeLocations,
          openSubgraphs,
          warnings
        );
      }
      return;
    }

    if (!this.looksLikeConnector(text.slice(cursor))) {
      errors.push(this.error(
        'UNKNOWN_SYNTAX',
        this.at(location, cursor),
        'Unrecognized Mermaid flowchart syntax'
      ));
      return;
    }

    for (const endpoint of first.endpoints) {
      this.recordClassAnnotation(endpoint, location, classAnnotations);
      this.addNode(
        endpoint.node,
        this.at(location, endpoint.start),
        endpoint.explicit,
        ast,
        nodeMap,
        nodeLocations,
        openSubgraphs,
        warnings
      );
    }
    let sourceNodes = first.endpoints.map(endpoint => endpoint.node);

    while (cursor < text.length) {
      const connector = this.parseConnector(text, cursor);
      if ('message' in connector) {
        errors.push(this.error(connector.code, this.at(location, connector.index), connector.message));
        return;
      }

      const targetStart = this.skipWhitespace(text, connector.end);
      if (targetStart >= text.length) {
        errors.push(this.error(
          'MALFORMED_EDGE',
          this.at(location, connector.end),
          'Expected a target node after the edge connector'
        ));
        return;
      }

      const targets = this.parseEndpointList(text, targetStart);
      if ('message' in targets) {
        errors.push(this.error(targets.code, this.at(location, targets.index), targets.message));
        return;
      }

      for (const endpoint of targets.endpoints) {
        this.recordClassAnnotation(endpoint, location, classAnnotations);
        this.addNode(
          endpoint.node,
          this.at(location, endpoint.start),
          endpoint.explicit,
          ast,
          nodeMap,
          nodeLocations,
          openSubgraphs,
          warnings
        );
      }

      // `A & B --> C & D` is Mermaid shorthand for the cartesian product of
      // both endpoint lists, so every source reaches every target.
      for (const sourceNode of sourceNodes) {
        for (const target of targets.endpoints) {
          const edge: MermaidEdge = {
            id: this.allocateEdgeId(sourceNode.id, target.node.id, edgeIdOccurrences),
            source: sourceNode.id,
            target: target.node.id,
            type: connector.type,
            label: connector.label
          };
          ast.edges.push(edge);
          edgeLocations.set(edge, this.at(location, cursor));
          for (const dropped of connector.dropped) {
            warnings.push(this.warning(
              'UNSUPPORTED_EDGE_STYLE',
              this.at(location, cursor),
              this.droppedStyleMessage(dropped, edge.id)
            ));
          }
          this.addToCurrentSubgraph(sourceNode.id, ast, openSubgraphs);
          this.addToCurrentSubgraph(target.node.id, ast, openSubgraphs);
        }
      }

      sourceNodes = targets.endpoints.map(endpoint => endpoint.node);
      cursor = this.skipWhitespace(text, targets.end);
      if (cursor < text.length && !this.looksLikeConnector(text.slice(cursor))) {
        errors.push(this.error(
          'MALFORMED_EDGE',
          this.at(location, cursor),
          'Unexpected content after the target node'
        ));
        return;
      }
    }
  }

  private droppedStyleMessage(dropped: DroppedEdgeStyle, edgeId: string): string {
    return dropped === 'thick'
      ? `Thick Mermaid edge ${edgeId} is converted without thick styling`
      : `Undirected Mermaid edge ${edgeId} is converted as a directed BPMN sequence flow`;
  }

  /**
   * Parses one endpoint, or the `&`-separated endpoint list Mermaid uses for
   * fan-out (`A --> B & C`). A `&` inside a shape, a quoted label or an HTML
   * entity belongs to the text and never separates endpoints.
   */
  private parseEndpointList(text: string, start: number): ParsedEndpointList | EndpointFailure {
    const endpoints: ParsedEndpoint[] = [];
    let cursor = start;

    for (;;) {
      const endpoint = this.parseEndpoint(text, cursor);
      if ('message' in endpoint) return endpoint;
      endpoints.push(endpoint);

      const next = this.skipWhitespace(text, endpoint.end);
      if (text[next] !== '&' || /^&#?[0-9A-Za-z]+;/.test(text.slice(next))) {
        return { endpoints, end: endpoint.end };
      }
      cursor = this.skipWhitespace(text, next + 1);
      if (cursor >= text.length) {
        return {
          code: 'MALFORMED_EDGE',
          index: next,
          message: 'Expected another Mermaid node identifier after "&"'
        };
      }
    }
  }

  /**
   * Parallel edges between the same pair need distinct IDs. The occurrence
   * suffix is joined with `-` rather than `_` because node IDs match `\w+` and
   * so can never contain `-`: `A_to_B-2` therefore cannot collide with the base
   * ID of any other edge, including the `A --> B_2` edge whose base is
   * `A_to_B_2`. `-` is also a legal XML NCName character, so an ID built this
   * way stays usable as a BPMN xsd:ID (mcp-bpmn-j21.9).
   */
  private allocateEdgeId(
    sourceId: string,
    targetId: string,
    occurrences: Map<string, number>
  ): string {
    const baseId = `${sourceId}_to_${targetId}`;
    const occurrence = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, occurrence);
    return occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
  }

  private parseEndpoint(text: string, start: number): ParsedEndpoint | EndpointFailure {
    const idMatch = text.slice(start).match(/^(\w+)/);
    if (!idMatch) {
      return {
        code: 'MALFORMED_EDGE',
        index: start,
        message: 'Expected a Mermaid node identifier'
      };
    }

    const id = idMatch[1];
    const shapeStart = start + id.length;
    const shapeText = text.slice(shapeStart);
    if (!shapeText
      || /^[\s&]/.test(shapeText)
      || this.looksLikeConnector(shapeText)
      || shapeText.startsWith(':::')) {
      return this.withClassAnnotation(text, {
        node: { id, type: 'process', label: id },
        start,
        end: shapeStart,
        explicit: false
      });
    }

    const shape = this.matchShape(shapeText);
    if (shape) {
      if (!shape.shape.type) {
        return {
          code: 'UNSUPPORTED_SHAPE',
          index: shapeStart,
          message: `The Mermaid ${shape.shape.name} shape "${shape.shape.open}...${shape.shape.close}" `
            + `on node "${id}" is valid Mermaid but is not part of the supported BPMN subset; `
            + `${shape.shape.alternative}.`
        };
      }
      return this.withClassAnnotation(text, {
        node: { id, type: shape.shape.type, label: shape.label },
        start,
        end: shapeStart + shape.length,
        explicit: true
      });
    }

    // Mermaid 11's typed shape syntax is valid but carries a shape vocabulary
    // far wider than the BPMN subset, so it is named rather than guessed at.
    if (/^@\s*\{/.test(shapeText)) {
      return {
        code: 'UNSUPPORTED_SHAPE',
        index: shapeStart,
        message: `The Mermaid typed-shape syntax "@{...}" on node "${id}" is valid Mermaid but is `
          + 'not part of the supported BPMN subset; use ID[Label] for a task, ID{Label} for an '
          + 'exclusive gateway, ID[/Label/] for a subprocess, ID[[Label]] for a data object, or '
          + 'ID((Label)) for an event.'
      };
    }

    if (/^[[({>]/.test(shapeText)) {
      return {
        code: 'MALFORMED_NODE',
        index: shapeStart,
        message: `Malformed shape for node "${id}"`
      };
    }

    return {
      code: 'MALFORMED_NODE',
      index: shapeStart,
      message: `Unexpected content after node identifier "${id}"`
    };
  }

  /**
   * Matches the longest Mermaid shape at the start of `shapeText`. A quoted
   * body is tried first for every shape so that `["Check [urgent]"]` keeps its
   * bracket and loses its quotes, and so that an arrow inside a quoted label is
   * text rather than a connector.
   */
  private matchShape(shapeText: string): ShapeMatch | undefined {
    const connectorIndex = shapeText.search(/-{2,}>|={2,}>|-\.+->/);

    for (const shape of this.shapes) {
      const quoted = shapeText.match(shape.quoted);
      if (quoted) {
        return { shape, label: this.decodeQuotedLabel(quoted[1]), length: quoted[0].length };
      }
      const plain = shapeText.match(shape.plain);
      // An unquoted body that reaches past a connector is an unclosed shape,
      // not a label: `A[Broken --> B[End]` stays a malformed node.
      if (plain && (connectorIndex < 0 || plain[0].length <= connectorIndex)) {
        return { shape, label: plain[1].trim(), length: plain[0].length };
      }
    }
    return undefined;
  }

  /**
   * A quoted Mermaid label is verbatim text: the quotes are delimiters, an
   * enclosing backtick pair marks a markdown string, and `#quot;`-style entity
   * codes are the only way to write characters the delimiters would otherwise
   * eat.
   */
  private decodeQuotedLabel(raw: string): string {
    let label = raw.trim();
    if (label.length >= 2 && label.startsWith('`') && label.endsWith('`')) {
      label = label.slice(1, -1).trim();
    }
    return label.replace(/#(\d+|[A-Za-z]+);/g, (entity, code: string) => {
      if (/^\d+$/.test(code)) {
        const codePoint = Number(code);
        return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      }
      return NAMED_ENTITY_CODES[code.toLowerCase()] ?? entity;
    });
  }

  private escapeLiteral(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Accepts every subgraph form Mermaid's own documentation leads with:
   * `subgraph id[Title]`, `subgraph id["Title"]`, `subgraph "Title"` and
   * `subgraph Title`. A title without an explicit ID gets a derived, unique ID,
   * because BPMN participants are addressed by ID.
   */
  private parseSubgraphDeclaration(
    text: string,
    existing: readonly MermaidSubgraph[]
  ): SubgraphDeclaration | undefined {
    const rest = text.replace(/^subgraph\b/i, '').trim();
    if (!rest) return undefined;

    const identified = rest.match(/^(\w+)\s*\[\s*(?:"([^"]*)"|([^\]]+))\s*\]$/);
    if (identified) {
      const title = (identified[2] !== undefined
        ? this.decodeQuotedLabel(identified[2])
        : identified[3].trim());
      return title ? { id: identified[1], title } : undefined;
    }

    const quoted = rest.match(/^"([^"]*)"$/);
    if (quoted) {
      const title = this.decodeQuotedLabel(quoted[1]);
      return title ? { id: this.deriveSubgraphId(title, existing), title } : undefined;
    }

    // A bare title must not contain shape delimiters: `subgraph id[Missing`
    // stays a malformed declaration rather than becoming a literal title.
    if (/^[^[\]{}()"|<>]+$/.test(rest)) {
      const title = rest.trim();
      return /^\w+$/.test(title)
        ? { id: title, title }
        : { id: this.deriveSubgraphId(title, existing), title };
    }
    return undefined;
  }

  private deriveSubgraphId(title: string, existing: readonly MermaidSubgraph[]): string {
    const base = title.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'subgraph';
    const taken = new Set(existing.map(subgraph => subgraph.id));
    if (!taken.has(base)) return base;
    let occurrence = 2;
    while (taken.has(`${base}_${occurrence}`)) occurrence++;
    return `${base}_${occurrence}`;
  }

  private withClassAnnotation(text: string, endpoint: ParsedEndpoint): ParsedEndpoint {
    const annotation = text.slice(endpoint.end).match(/^:::([A-Za-z_]\w*(?:-[A-Za-z0-9_]+)*)(?=[\s&=~<-]|$)/);
    if (!annotation) return endpoint;
    return {
      ...endpoint,
      end: endpoint.end + annotation[0].length,
      explicit: true,
      classAnnotation: { index: endpoint.end, name: annotation[1] }
    };
  }

  private recordClassAnnotation(
    endpoint: ParsedEndpoint,
    location: SourceLocation,
    classAnnotations: PendingClassAnnotation[]
  ): void {
    if (!endpoint.classAnnotation) return;
    classAnnotations.push({
      nodeId: endpoint.node.id,
      name: endpoint.classAnnotation.name,
      location: this.at(location, endpoint.classAnnotation.index)
    });
  }

  /**
   * Resolves every `:::class` suffix against the node's final type. A class in
   * the steering vocabulary refines the node, a class naming the default a shape
   * already carries is accepted and refines nothing, and everything else stays
   * the styling hook it has always been: warned about once and ignored.
   */
  private applyClassAnnotations(
    ast: MermaidAST,
    classAnnotations: readonly PendingClassAnnotation[],
    errors: ParseError[],
    warnings: ParseWarning[]
  ): void {
    const nodesById = new Map(ast.nodes.map(node => [node.id, node]));

    for (const annotation of classAnnotations) {
      const node = nodesById.get(annotation.nodeId);
      if (!node) continue;
      const normalized = normalizeSubtypeClass(annotation.name);

      const neutralHost = NEUTRAL_SUBTYPE_CLASSES[normalized];
      if (neutralHost !== undefined) {
        if (neutralHost !== node.type) {
          errors.push(this.error(
            'INVALID_NODE_SUBTYPE',
            annotation.location,
            this.subtypeHostFailure(annotation.name, node, [neutralHost])
          ));
        }
        continue;
      }

      const subtype = SUBTYPE_CLASS_NAMES[normalized];
      if (subtype === undefined) {
        warnings.push(this.warning(
          'UNSUPPORTED_DIRECTIVE',
          annotation.location,
          `Unsupported Mermaid CSS class "${annotation.name}"; ignored`
        ));
        continue;
      }

      if (!SUBTYPE_HOSTS[subtype].has(node.type)) {
        errors.push(this.error(
          'INVALID_NODE_SUBTYPE',
          annotation.location,
          this.subtypeHostFailure(annotation.name, node, [...SUBTYPE_HOSTS[subtype]])
        ));
        continue;
      }

      if (node.subtype !== undefined && node.subtype !== subtype) {
        errors.push(this.error(
          'INVALID_NODE_SUBTYPE',
          annotation.location,
          `Mermaid node ${node.id} is already refined as ":::${node.subtype}", so `
            + `":::${annotation.name}" conflicts with it; give a node one BPMN subtype class.`
        ));
        continue;
      }
      node.subtype = subtype;
    }
  }

  private subtypeHostFailure(
    name: string,
    node: MermaidNode,
    hosts: readonly NodeType[]
  ): string {
    const legal = hosts.map(host => SUBTYPE_HOST_DESCRIPTIONS[host]);
    const named = legal.length > 1
      ? `${legal.slice(0, -1).join(', ')} or ${legal.at(-1)}`
      : legal[0];
    return `The BPMN subtype class ":::${name}" cannot refine Mermaid node ${node.id}, `
      + `which is ${SUBTYPE_HOST_DESCRIPTIONS[node.type]}; it applies to ${named}.`;
  }

  private parseConnector(text: string, start: number): ParsedConnector | ConnectorFailure {
    const rest = text.slice(start);
    const unsupported = this.unsupportedConnector(rest);
    if (unsupported) {
      return {
        code: 'UNSUPPORTED_CONNECTOR',
        index: start,
        message: `The Mermaid connector "${unsupported.text}" is valid Mermaid but is not part of `
          + `the supported BPMN subset; ${unsupported.alternative}.`
      };
    }

    const connectorMatch = this.matchConnector(rest);
    if (!connectorMatch) {
      return {
        code: 'MALFORMED_EDGE',
        index: start,
        message: 'Expected a supported edge connector: -->, ---, ==>, -.->, "-- text -->", '
          + '"-. text .->", or -->|text|'
      };
    }
    if (connectorMatch.label !== undefined && !connectorMatch.label) {
      return { code: 'MALFORMED_EDGE', index: start, message: 'Edge labels must not be blank' };
    }

    const type = connectorMatch.type;
    let cursor = this.skipWhitespace(text, start + connectorMatch.length);
    let label = connectorMatch.label;

    if (text[cursor] === '|') {
      if (label !== undefined) {
        return {
          code: 'MALFORMED_EDGE',
          index: cursor,
          message: 'Use either "-- text -->" or -->|text| to label an edge, not both'
        };
      }
      const labelEnd = text.indexOf('|', cursor + 1);
      if (labelEnd < 0 || labelEnd === cursor + 1) {
        return {
          code: 'MALFORMED_EDGE',
          index: cursor,
          message: 'Edge labels must be non-empty and enclosed by | characters'
        };
      }
      label = text.slice(cursor + 1, labelEnd).trim();
      if (!label) {
        return { code: 'MALFORMED_EDGE', index: cursor, message: 'Edge labels must not be blank' };
      }
      cursor = this.skipWhitespace(text, labelEnd + 1);
    }

    return {
      type: label === undefined ? type : type === 'directed' ? 'labeled' : type,
      label,
      dropped: connectorMatch.dropped,
      end: cursor
    };
  }

  /**
   * The supported connector grammar. Arrowless (`---`) and thick (`==>`) links
   * convert as ordinary sequence flows and report the styling BPMN drops;
   * Mermaid's primary inline label form (`-- text -->`) takes the earliest
   * terminator, so a label may itself contain `-` or `>`.
   */
  private matchConnector(rest: string): MatchedConnector | undefined {
    for (const candidate of BARE_CONNECTORS) {
      const match = rest.match(candidate.pattern);
      if (match) {
        return { type: candidate.type, dropped: candidate.dropped, length: match[0].length };
      }
    }

    for (const candidate of LABELED_CONNECTORS) {
      const match = rest.match(candidate.pattern);
      if (!match) continue;
      return {
        type: candidate.type,
        label: match[1].trim(),
        dropped: match[2].endsWith('>') ? candidate.dropped : [...candidate.dropped, 'undirected'],
        length: match[0].length
      };
    }
    return undefined;
  }

  /**
   * Connectors Mermaid accepts that the BPMN subset intentionally refuses. They
   * are named explicitly so the author is not told that valid Mermaid is
   * malformed.
   */
  private unsupportedConnector(rest: string): { text: string; alternative: string } | undefined {
    for (const candidate of UNSUPPORTED_CONNECTORS) {
      const match = rest.match(candidate.pattern);
      if (match) return { text: match[0], alternative: candidate.alternative };
    }
    return undefined;
  }

  private addNode(
    node: MermaidNode,
    location: SourceLocation,
    explicit: boolean,
    ast: MermaidAST,
    nodeMap: Map<string, StoredNode>,
    nodeLocations: Map<string, SourceLocation>,
    openSubgraphs: OpenSubgraph[],
    warnings: ParseWarning[]
  ): void {
    const stored = nodeMap.get(node.id);
    if (stored) {
      if (explicit) {
        if (stored.explicit) {
          warnings.push(this.warning(
            'DUPLICATE_NODE',
            location,
            `Duplicate node definition: ${node.id}`
          ));
        } else {
          Object.assign(stored.node, node);
          stored.explicit = true;
          nodeLocations.set(node.id, location);
        }
      }
    } else {
      nodeMap.set(node.id, { node, explicit });
      nodeLocations.set(node.id, location);
      ast.nodes.push(node);
    }
    this.addToCurrentSubgraph(node.id, ast, openSubgraphs);
  }

  private addToCurrentSubgraph(nodeId: string, ast: MermaidAST, openSubgraphs: OpenSubgraph[]): void {
    const current = openSubgraphs.at(-1);
    if (!current) return;
    const subgraph = ast.subgraphs.find(candidate => candidate.id === current.id);
    if (subgraph && !subgraph.nodes.includes(nodeId)) subgraph.nodes.push(nodeId);
  }

  private inferNodeTypes(ast: MermaidAST): void {
    const startKeywords = GENERIC_EVENT_LABELS.start;
    const endKeywords = GENERIC_EVENT_LABELS.end;

    for (const node of ast.nodes) {
      if (node.type !== 'terminator' && node.type !== 'process') continue;

      const normalizedLabel = node.label.trim().toLowerCase();
      if (startKeywords.has(normalizedLabel)) {
        node.type = 'start';
      } else if (endKeywords.has(normalizedLabel)) {
        node.type = 'end';
      } else if (node.type === 'terminator') {
        const hasIncoming = ast.edges.some(edge => edge.target === node.id);
        const hasOutgoing = ast.edges.some(edge => edge.source === node.id);

        if (!hasIncoming && hasOutgoing) {
          node.type = 'start';
        } else if (hasIncoming && !hasOutgoing) {
          node.type = 'end';
        }
      }
    }
  }

  private validateAST(
    ast: MermaidAST,
    nodeLocations: Map<string, SourceLocation>,
    edgeLocations: Map<MermaidEdge, SourceLocation>,
    subgraphLocations: Map<MermaidSubgraph, SourceLocation>,
    fallbackLocation: SourceLocation,
    recognizedDocumentSyntax: boolean,
    /** False once a line failed to parse, so the graph is missing content. */
    structureIsComplete: boolean,
    errors: ParseError[],
    warnings: ParseWarning[]
  ): void {
    const subgraphIds = new Set<string>();
    const ownerByNode = new Map<string, string>();

    for (const subgraph of ast.subgraphs) {
      const subgraphLocation = subgraphLocations.get(subgraph) ?? fallbackLocation;
      if (subgraphIds.has(subgraph.id)) {
        errors.push(this.error(
          'DUPLICATE_SUBGRAPH',
          subgraphLocation,
          `Duplicate Mermaid subgraph ID: ${subgraph.id}`
        ));
      }
      subgraphIds.add(subgraph.id);

      for (const nodeId of subgraph.nodes) {
        const existingOwner = ownerByNode.get(nodeId);
        if (existingOwner && existingOwner !== subgraph.id) {
          errors.push(this.error(
            'MULTIPLE_SUBGRAPH_OWNERS',
            subgraphLocation,
            `Mermaid node ${nodeId} belongs to multiple subgraphs`
          ));
        } else {
          ownerByNode.set(nodeId, subgraph.id);
        }
      }
    }

    for (const edge of ast.edges) {
      // Edge IDs are allocated, not authored: `allocateEdgeId` guarantees they
      // are unique, so there is no duplicate case left to report here.
      const edgeLocation = edgeLocations.get(edge) ?? fallbackLocation;
      if (edge.type === 'dotted') {
        warnings.push(this.warning(
          'UNSUPPORTED_EDGE_STYLE',
          edgeLocation,
          `Dotted Mermaid edge ${edge.id} is converted without dotted styling`
        ));
      }
      const sourceNode = ast.nodes.find(node => node.id === edge.source);
      const targetNode = ast.nodes.find(node => node.id === edge.target);
      if (sourceNode?.type === 'data' || targetNode?.type === 'data') {
        errors.push(this.error(
          'UNSUPPORTED_EDGE_ENDPOINT',
          edgeLocation,
          `Edge ${edge.id} cannot connect a BPMN flow to a data object`
        ));
        continue;
      }
      const crossBoundaryFailure = this.crossBoundaryEndpointFailure(
        edge,
        sourceNode,
        targetNode,
        ownerByNode
      );
      if (crossBoundaryFailure) {
        errors.push(this.error('UNSUPPORTED_EDGE_ENDPOINT', edgeLocation, crossBoundaryFailure));
      }
    }

    if (structureIsComplete && ast.subgraphs.length > 0) {
      for (const node of ast.nodes) {
        if (!ownerByNode.has(node.id)) {
          errors.push(this.error(
            'MISSING_SUBGRAPH_OWNER',
            nodeLocations.get(node.id) ?? fallbackLocation,
            `Mermaid node ${node.id} is not owned by a subgraph`
          ));
        }
      }
    }

    if (ast.nodes.length === 0) {
      if (errors.length === 0) {
        errors.push(this.error(
          'EMPTY_DIAGRAM',
          fallbackLocation,
          'Mermaid flowchart must contain at least one node'
        ));
      }
      return;
    }

    if (!recognizedDocumentSyntax && errors.length === 0) {
      errors.push(this.error(
        'UNKNOWN_SYNTAX',
        fallbackLocation,
        'Expected a Mermaid graph/flowchart declaration or declaration-less flowchart syntax'
      ));
      return;
    }

    if (!structureIsComplete) return;

    if (!ast.nodes.some(node => node.type === 'start')) {
      warnings.push(this.warning(
        'MISSING_START',
        fallbackLocation,
        'No explicit start node found. Consider adding a start event.'
      ));
    }
    if (!ast.nodes.some(node => node.type === 'end')) {
      warnings.push(this.warning(
        'MISSING_END',
        fallbackLocation,
        'No explicit end node found. Consider adding an end event.'
      ));
    }

    for (const node of ast.nodes) {
      const nodeLocation = nodeLocations.get(node.id) ?? fallbackLocation;
      const hasIncoming = ast.edges.some(edge => edge.target === node.id);
      const hasOutgoing = ast.edges.some(edge => edge.source === node.id);

      if (!hasIncoming && node.type !== 'start') {
        warnings.push(this.warning(
          'DISCONNECTED_NODE',
          nodeLocation,
          `Node "${node.id}" has no incoming connections`
        ));
      }
      if (!hasOutgoing && node.type !== 'end') {
        warnings.push(this.warning(
          'DISCONNECTED_NODE',
          nodeLocation,
          `Node "${node.id}" has no outgoing connections`
        ));
      }
    }

    this.warnImplicitParallelSplits(ast, nodeLocations, ownerByNode, fallbackLocation, warnings);
  }

  /**
   * Mermaid draws two arrows out of a node to mean "one of these happens";
   * BPMN reads two outgoing sequence flows from a non-gateway as a parallel
   * (AND) split, where every branch runs. The conversion is left alone — that
   * is what the diagram says — but the author is told at their own node, since
   * validation cannot flag it: the generated BPMN is perfectly legal.
   */
  private warnImplicitParallelSplits(
    ast: MermaidAST,
    nodeLocations: Map<string, SourceLocation>,
    ownerByNode: Map<string, string>,
    fallbackLocation: SourceLocation,
    warnings: ParseWarning[]
  ): void {
    const outgoingByNode = new Map<string, number>();
    for (const edge of ast.edges) {
      const sourceOwner = ownerByNode.get(edge.source);
      const targetOwner = ownerByNode.get(edge.target);
      // A cross-subgraph edge becomes a message flow, which is not a split.
      if (sourceOwner && targetOwner && sourceOwner !== targetOwner) continue;
      outgoingByNode.set(edge.source, (outgoingByNode.get(edge.source) ?? 0) + 1);
    }

    for (const node of ast.nodes) {
      const outgoing = outgoingByNode.get(node.id) ?? 0;
      if (outgoing < 2 || node.type === 'decision') continue;
      warnings.push(this.warning(
        'IMPLICIT_PARALLEL_SPLIT',
        nodeLocations.get(node.id) ?? fallbackLocation,
        `Node "${node.id}" has ${outgoing} outgoing connections and is not a decision, so it `
          + 'converts to a BPMN parallel (AND) split in which every branch runs. '
          + `Write it as a decision node ${node.id}{...} if the branches are alternatives.`
      ));
    }
  }

  /**
   * A Mermaid edge between two subgraphs becomes a BPMN message flow. BPMN
   * only lets message flows touch interaction nodes, and forbids a start event
   * as source or an end event as target. Rejecting those here — against the
   * author's own Mermaid ids, with a line and column — replaces an opaque
   * failure raised much later against generated BPMN ids.
   */
  private crossBoundaryEndpointFailure(
    edge: MermaidEdge,
    sourceNode: MermaidNode | undefined,
    targetNode: MermaidNode | undefined,
    ownerByNode: Map<string, string>
  ): string | undefined {
    if (!sourceNode || !targetNode) return undefined;
    const sourceOwner = ownerByNode.get(sourceNode.id);
    const targetOwner = ownerByNode.get(targetNode.id);
    if (!sourceOwner || !targetOwner || sourceOwner === targetOwner) return undefined;

    const crossing = `Edge ${edge.id} cannot cross subgraphs "${sourceOwner}" and "${targetOwner}"`;
    if (sourceNode.type === 'decision' || targetNode.type === 'decision') {
      const gateway = sourceNode.type === 'decision' ? sourceNode : targetNode;
      return `${crossing} because Mermaid node ${gateway.id} is a gateway; `
        + 'a BPMN message flow cannot start or end at a gateway. '
        + 'Connect the subgraphs with a task or event instead.';
    }
    if (sourceNode.type === 'start') {
      return `${crossing} because Mermaid node ${sourceNode.id} is a start event; `
        + 'a BPMN message flow cannot start at a start event. '
        + 'Send the message from a task or an end event instead.';
    }
    if (targetNode.type === 'end') {
      return `${crossing} because Mermaid node ${targetNode.id} is an end event; `
        + 'a BPMN message flow cannot end at an end event. '
        + 'Receive the message at a task or a start event instead.';
    }
    return undefined;
  }

  private warning(code: ParseWarningCode, location: SourceLocation, message: string): ParseWarning {
    return { severity: 'warning', code, ...location, message };
  }

  private error(code: ParseErrorCode, location: SourceLocation, message: string): ParseError {
    return { severity: 'error', code, ...location, message };
  }

  private at(location: SourceLocation, zeroBasedOffset: number): SourceLocation {
    return { ...location, column: location.column + zeroBasedOffset };
  }

  private skipWhitespace(text: string, start: number): number {
    let cursor = start;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    return cursor;
  }

  private looksLikeConnector(text: string): boolean {
    return /^(?:[-=~]|<[-.=])/.test(text);
  }

  private hasDeclarationlessStructure(text: string): boolean {
    return /(?:-{2,}|={2,}|-\.)/.test(text)
      || /^\w+(?:\[|\{|\(|:::)/.test(text);
  }

  private headerErrorIndex(text: string): number {
    const keyword = text.match(/^(graph|flowchart)\b/i)?.[0];
    if (!keyword) return 0;
    return this.skipWhitespace(text, keyword.length);
  }

  private subgraphErrorIndex(text: string): number {
    const openingBracket = text.indexOf('[');
    return openingBracket >= 0 ? openingBracket : Math.min('subgraph'.length, text.length);
  }

  private compareDiagnostics(
    left: { line: number; column: number },
    right: { line: number; column: number }
  ): number {
    return left.line - right.line || left.column - right.column;
  }
}
