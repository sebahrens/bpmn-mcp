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
  end: number;
  explicit: boolean;
  classAnnotation?: {
    index: number;
    name: string;
  };
}

interface StoredNode {
  node: MermaidNode;
  explicit: boolean;
}

interface EndpointFailure {
  code: 'MALFORMED_NODE' | 'MALFORMED_EDGE';
  index: number;
  message: string;
}

interface ParsedConnector {
  type: EdgeType;
  label?: string;
  end: number;
}

interface ConnectorFailure {
  index: number;
  message: string;
}

interface OpenSubgraph {
  id: string;
  location: SourceLocation;
}

export class MermaidParser {
  private readonly directionPattern = /^(graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*$/i;
  private readonly subgraphPattern = /^subgraph\s+(\w+)\s*\[([^\]]+)\]\s*$/i;
  private readonly unsupportedDirectivePattern = /^(classDef|class|style|linkStyle|click|direction)\b/i;
  private readonly otherDiagramPattern = /^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|sankey-beta)\b/i;

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
    let firstContentLocation: SourceLocation | undefined;
    let recognizedDocumentSyntax = false;

    for (let index = 0; index < lines.length; index++) {
      const source = lines[index];
      const leadingWhitespace = source.length - source.trimStart().length;
      const trimmed = source.trim();
      const location: SourceLocation = {
        line: index + 1,
        column: leadingWhitespace + 1,
        source
      };

      if (!trimmed) continue;

      if (trimmed.startsWith('%%{')) {
        warnings.push(this.warning(
          'UNSUPPORTED_DIRECTIVE',
          location,
          'Unsupported Mermaid initialization directive; ignored'
        ));
        firstContentLocation ??= location;
        continue;
      }
      if (trimmed.startsWith('%%')) continue;

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
        const match = trimmed.match(this.subgraphPattern);
        if (!match) {
          errors.push(this.error(
            'MALFORMED_SUBGRAPH',
            this.at(location, this.subgraphErrorIndex(trimmed)),
            'Expected subgraph syntax: subgraph <id>[<title>]'
          ));
          continue;
        }

        const subgraph: MermaidSubgraph = {
          id: match[1],
          title: match[2].trim(),
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
        openSubgraphs.push({ id: subgraph.id, location });
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
        errors,
        warnings
      );
      recognizedDocumentSyntax ||= this.hasDeclarationlessStructure(trimmed);
    }

    for (const openSubgraph of openSubgraphs) {
      errors.push(this.error(
        'UNCLOSED_SUBGRAPH',
        openSubgraph.location,
        `Subgraph "${openSubgraph.id}" is missing a closing "end"`
      ));
    }

    this.inferNodeTypes(ast);
    this.validateAST(
      ast,
      nodeLocations,
      edgeLocations,
      subgraphLocations,
      firstContentLocation ?? { line: 1, column: 1, source: lines[0] ?? '' },
      recognizedDocumentSyntax,
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

  private parseStructuralLine(
    text: string,
    location: SourceLocation,
    ast: MermaidAST,
    nodeMap: Map<string, StoredNode>,
    nodeLocations: Map<string, SourceLocation>,
    edgeLocations: Map<MermaidEdge, SourceLocation>,
    edgeIdOccurrences: Map<string, number>,
    openSubgraphs: OpenSubgraph[],
    errors: ParseError[],
    warnings: ParseWarning[]
  ): void {
    const first = this.parseEndpoint(text, 0);
    if ('message' in first) {
      errors.push(this.error(first.code, this.at(location, first.index), first.message));
      return;
    }
    this.addClassAnnotationWarning(first, location, warnings);

    let cursor = this.skipWhitespace(text, first.end);
    if (cursor === text.length) {
      this.addNode(first.node, location, true, ast, nodeMap, nodeLocations, openSubgraphs, warnings);
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

    this.addNode(first.node, location, first.explicit, ast, nodeMap, nodeLocations, openSubgraphs, warnings);
    let sourceNode = first.node;

    while (cursor < text.length) {
      const connector = this.parseConnector(text, cursor);
      if ('message' in connector) {
        errors.push(this.error('MALFORMED_EDGE', this.at(location, connector.index), connector.message));
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

      const target = this.parseEndpoint(text, targetStart);
      if ('message' in target) {
        errors.push(this.error(target.code, this.at(location, target.index), target.message));
        return;
      }
      this.addClassAnnotationWarning(target, location, warnings);

      this.addNode(
        target.node,
        this.at(location, targetStart),
        target.explicit,
        ast,
        nodeMap,
        nodeLocations,
        openSubgraphs,
        warnings
      );
      const edge: MermaidEdge = {
        id: this.allocateEdgeId(sourceNode.id, target.node.id, edgeIdOccurrences),
        source: sourceNode.id,
        target: target.node.id,
        type: connector.type,
        label: connector.label
      };
      ast.edges.push(edge);
      edgeLocations.set(edge, this.at(location, cursor));
      this.addToCurrentSubgraph(sourceNode.id, ast, openSubgraphs);
      this.addToCurrentSubgraph(target.node.id, ast, openSubgraphs);

      sourceNode = target.node;
      cursor = this.skipWhitespace(text, target.end);
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

  private allocateEdgeId(
    sourceId: string,
    targetId: string,
    occurrences: Map<string, number>
  ): string {
    const baseId = `${sourceId}_to_${targetId}`;
    const occurrence = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, occurrence);
    return occurrence === 1 ? baseId : `${baseId}_${occurrence}`;
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
    if (!shapeText || /^\s/.test(shapeText) || this.looksLikeConnector(shapeText) || shapeText.startsWith(':::')) {
      return this.withClassAnnotation(text, {
        node: { id, type: 'process', label: id },
        end: shapeStart,
        explicit: false
      });
    }

    const shapes: Array<{ pattern: RegExp; type: NodeType }> = [
      { pattern: /^\[\[([^\]]+)\]\]/, type: 'data' },
      { pattern: /^\[\/([^/]+)\/\]/, type: 'subprocess' },
      { pattern: /^\[([^\]]+)\]/, type: 'process' },
      { pattern: /^\{([^}]+)\}/, type: 'decision' },
      { pattern: /^\(\(([^)]+)\)\)/, type: 'terminator' }
    ];
    const connectorIndex = shapeText.search(/-->|-\.->/);

    for (const shape of shapes) {
      const match = shapeText.match(shape.pattern);
      if (match && (connectorIndex < 0 || match[0].length <= connectorIndex)) {
        return this.withClassAnnotation(text, {
          node: { id, type: shape.type, label: match[1].trim() },
          end: shapeStart + match[0].length,
          explicit: true
        });
      }
    }

    if (/^[\[({]/.test(shapeText)) {
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

  private withClassAnnotation(text: string, endpoint: ParsedEndpoint): ParsedEndpoint {
    const annotation = text.slice(endpoint.end).match(/^:::([A-Za-z_]\w*(?:-[A-Za-z0-9_]+)*)(?=\s|-->|-\.->|$)/);
    if (!annotation) return endpoint;
    return {
      ...endpoint,
      end: endpoint.end + annotation[0].length,
      explicit: true,
      classAnnotation: { index: endpoint.end, name: annotation[1] }
    };
  }

  private addClassAnnotationWarning(
    endpoint: ParsedEndpoint,
    location: SourceLocation,
    warnings: ParseWarning[]
  ): void {
    if (!endpoint.classAnnotation) return;
    warnings.push(this.warning(
      'UNSUPPORTED_DIRECTIVE',
      this.at(location, endpoint.classAnnotation.index),
      `Unsupported Mermaid CSS class "${endpoint.classAnnotation.name}"; ignored`
    ));
  }

  private parseConnector(text: string, start: number): ParsedConnector | ConnectorFailure {
    const connectorMatch = text.slice(start).match(/^(-->|-\.->)/);
    if (!connectorMatch) {
      return { index: start, message: 'Expected a supported edge connector: --> or -.->' };
    }

    const type: EdgeType = connectorMatch[1] === '-.->' ? 'dotted' : 'directed';
    let cursor = this.skipWhitespace(text, start + connectorMatch[0].length);
    let label: string | undefined;

    if (text[cursor] === '|') {
      const labelEnd = text.indexOf('|', cursor + 1);
      if (labelEnd < 0 || labelEnd === cursor + 1) {
        return { index: cursor, message: 'Edge labels must be non-empty and enclosed by | characters' };
      }
      label = text.slice(cursor + 1, labelEnd).trim();
      if (!label) {
        return { index: cursor, message: 'Edge labels must not be blank' };
      }
      cursor = this.skipWhitespace(text, labelEnd + 1);
    }

    return { type: label === undefined ? type : type === 'directed' ? 'labeled' : type, label, end: cursor };
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
    const startKeywords = new Set(['start', 'begin']);
    const endKeywords = new Set(['end', 'stop', 'finish']);

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
    errors: ParseError[],
    warnings: ParseWarning[]
  ): void {
    const edgeIds = new Set<string>();
    const subgraphIds = new Set<string>();
    const ownerByNode = new Map<string, string>();

    for (const edge of ast.edges) {
      const edgeLocation = edgeLocations.get(edge) ?? fallbackLocation;
      if (edgeIds.has(edge.id)) {
        errors.push(this.error(
          'DUPLICATE_EDGE',
          edgeLocation,
          `Duplicate Mermaid edge ID: ${edge.id}`
        ));
      }
      edgeIds.add(edge.id);
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
      }
    }

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

    if (ast.subgraphs.length > 0) {
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
    return /^(-->|-\.->)/.test(text) || /^[-.=]+>/.test(text) || /^-+/.test(text);
  }

  private hasDeclarationlessStructure(text: string): boolean {
    return /(?:-->|-\.->)/.test(text)
      || /^\w+(?:\[\[|\[\/|\[|\{|\(\(|:::)/.test(text);
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
