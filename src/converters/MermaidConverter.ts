import { MermaidParser } from './MermaidParser.js';
import { SimpleBpmnGenerator } from '../core/SimpleBpmnGenerator.js';
import { BpmnDocumentSerializer } from '../core/BpmnDocument.js';
import {
  transposeDocumentGeometry,
  type LayoutOrientation
} from '../core/layout/LayoutOrientation.js';
import { config } from '../config/index.js';
import type { ResourceLimits } from '../config/index.js';
import {
  assertLayoutComplexity,
  BpmnAutoLayoutV2Adapter,
  formatBpmnLayoutDiagnostic,
  type BpmnLayoutAdapter
} from '../core/layout/BpmnLayoutAdapter.js';
import type { ConversionResult } from './types.js';
import { isGenericEventLabel } from './ASTTypes.js';
import type { 
  MermaidAST,
  ParseResult
} from './ASTTypes.js';

const MAX_MERMAID_DIAGNOSTICS = 20;
const MAX_MERMAID_DIAGNOSTIC_MESSAGE_LENGTH = 240;

interface FormattedMermaidDiagnostics {
  all: string[];
  warnings: string[];
}

function formatMermaidDiagnostics(parseResult: ParseResult): FormattedMermaidDiagnostics {
  const orderedDiagnostics = [...parseResult.errors, ...parseResult.warnings].sort((left, right) =>
    left.line - right.line
    || left.column - right.column
    || left.severity.localeCompare(right.severity)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  );
  const totals = {
    error: parseResult.errors.length,
    warning: parseResult.warnings.length
  };
  const seen = { error: 0, warning: 0 };
  const entries: Array<{ severity: 'error' | 'warning'; text: string }> = [];

  for (const diagnostic of orderedDiagnostics) {
    const severityIndex = seen[diagnostic.severity]++;
    if (severityIndex === MAX_MERMAID_DIAGNOSTICS) {
      const omittedCount = totals[diagnostic.severity] - MAX_MERMAID_DIAGNOSTICS;
      entries.push({
        severity: diagnostic.severity,
        text: `${diagnostic.line}:${diagnostic.column} [DIAGNOSTICS_TRUNCATED] `
          + `${omittedCount} additional ${diagnostic.severity} diagnostics omitted`
      });
    }
    if (severityIndex >= MAX_MERMAID_DIAGNOSTICS) continue;

    const singleLineMessage = diagnostic.message.replace(/\s+/g, ' ').trim();
    const message = singleLineMessage.length > MAX_MERMAID_DIAGNOSTIC_MESSAGE_LENGTH
      ? `${singleLineMessage.slice(0, MAX_MERMAID_DIAGNOSTIC_MESSAGE_LENGTH - 3)}...`
      : singleLineMessage;
    entries.push({
      severity: diagnostic.severity,
      text: `${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${message}`
    });
  }

  return {
    all: entries.map(entry => entry.text),
    warnings: entries.filter(entry => entry.severity === 'warning').map(entry => entry.text)
  };
}

export interface ConversionOptions {
  autoLayout?: boolean;
}

/** How each Mermaid direction maps onto the two layout orientations. */
const MERMAID_LAYOUT_ORIENTATION: Record<MermaidAST['direction'], LayoutOrientation> = {
  TD: 'top-to-bottom',
  TB: 'top-to-bottom',
  BT: 'top-to-bottom',
  LR: 'left-to-right',
  RL: 'left-to-right'
};

/**
 * Directions whose reading order runs backwards. BPMN has no notion of a
 * reversed reading order, so these are laid out forwards and reported.
 */
const REVERSED_MERMAID_DIRECTIONS: Partial<Record<MermaidAST['direction'], string>> = {
  BT: 'top to bottom',
  RL: 'left to right'
};

export class MermaidConverter {
  private parser: MermaidParser;
  private simpleGenerator: SimpleBpmnGenerator;
  private layoutAdapter: BpmnLayoutAdapter;
  private documentSerializer: BpmnDocumentSerializer;
  private resourceLimits: ResourceLimits;

  constructor(
    layoutAdapter: BpmnLayoutAdapter = new BpmnAutoLayoutV2Adapter(
      undefined,
      config.resourceLimits.layoutTimeoutMs,
      config.resourceLimits.maxConcurrentLayouts
    ),
    resourceLimits: ResourceLimits = config.resourceLimits
  ) {
    this.parser = new MermaidParser();
    this.simpleGenerator = new SimpleBpmnGenerator();
    this.layoutAdapter = layoutAdapter;
    this.documentSerializer = new BpmnDocumentSerializer();
    this.resourceLimits = { ...resourceLimits };
  }

  async convert(
    mermaidCode: string, 
    options: ConversionOptions = {}
  ): Promise<ConversionResult> {
    const warnings: string[] = [];

    const parseResult = this.parser.parse(mermaidCode);
    const diagnostics = formatMermaidDiagnostics(parseResult);
    
    if (!parseResult.ast) {
      throw this.parseFailure(diagnostics.all);
    }

    warnings.push(...diagnostics.warnings);

    const ast = parseResult.ast;
    const processName = this.generateProcessName(ast);

    if (options.autoLayout !== false) {
      assertLayoutComplexity(
        ast.nodes.length,
        ast.edges.length,
        0,
        this.resourceLimits
      );
    }

    // Generate semantic BPMN once, then route both live auto-layout paths
    // through the selected XML adapter. The generator's canonical geometry is
    // retained only when callers explicitly opt out of automatic layout.
    const result = await this.simpleGenerator.generateBpmn(ast, processName);
    if (options.autoLayout !== false) {
      assertLayoutComplexity(
        ast.nodes.length,
        ast.edges.length,
        Buffer.byteLength(result.xml, 'utf8'),
        this.resourceLimits
      );
      const layout = await this.layoutAdapter.layout(result.xml);
      const laidOut = await this.documentSerializer.parse(layout.xml, config.bpmnImportLimits);
      // The layout engine only ranks left to right. A Mermaid diagram that
      // declares a vertical direction is reflected onto that axis instead of
      // silently coming out horizontal.
      const orientation = MERMAID_LAYOUT_ORIENTATION[ast.direction];
      if (orientation === 'top-to-bottom') {
        transposeDocumentGeometry(laidOut.document);
        layout.xml = await this.documentSerializer.serialize(laidOut.document, true);
      }
      const reversedDirection = REVERSED_MERMAID_DIRECTIONS[ast.direction];
      if (reversedDirection) {
        warnings.push(
          `Mermaid direction ${ast.direction} is read back to front; the diagram was `
          + `laid out ${reversedDirection}, which keeps the flow order intact.`
        );
      }
      result.xml = layout.xml;
      for (const element of result.elements) {
        const laidOutElement = laidOut.elements.get(element.id);
        if (!laidOutElement) continue;
        element.x = laidOutElement.position.x;
        element.y = laidOutElement.position.y;
      }
      result.warnings.push(...layout.warnings.map(formatBpmnLayoutDiagnostic));
    }
    result.warnings.push(...warnings);

    // Add stats for compatibility
    result.stats = {
      nodeCount: ast.nodes.length,
      edgeCount: ast.edges.length
    };
    
    return result;
  }

  private generateProcessName(ast: MermaidAST): string {
    // The start label is used verbatim. Stripping "start"/"begin" out of it
    // mangled ordinary names ("Order Started" became "Order ed"), so a label
    // that is only the generic keyword falls back to the neutral name instead.
    const startLabel = ast.nodes.find(n => n.type === 'start')?.label.trim() ?? '';
    if (!startLabel || isGenericEventLabel('start', startLabel)) {
      return 'Converted Process';
    }
    return startLabel;
  }

  private parseFailure(errors: readonly string[]): Error {
    return new Error(`Failed to parse Mermaid diagram:\n${errors.join('\n')}`);
  }
}
