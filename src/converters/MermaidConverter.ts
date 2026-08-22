import { MermaidParser } from './MermaidParser.js';
import { SimpleBpmnGenerator } from '../core/SimpleBpmnGenerator.js';
import { BpmnDocumentSerializer } from '../core/BpmnDocument.js';
import { config } from '../config/index.js';
import type { ResourceLimits } from '../config/index.js';
import {
  assertLayoutComplexity,
  BpmnAutoLayoutV2Adapter,
  formatBpmnLayoutDiagnostic,
  type BpmnLayoutAdapter
} from '../core/layout/BpmnLayoutAdapter.js';
import type { ConversionResult } from './types.js';
import type { 
  MermaidAST,
  ParseResult
} from './ASTTypes.js';

const MAX_MERMAID_DIAGNOSTICS = 20;
const MAX_MERMAID_DIAGNOSTIC_MESSAGE_LENGTH = 240;

interface FormattedMermaidDiagnostics {
  all: string[];
  errors: string[];
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
    errors: entries.filter(entry => entry.severity === 'error').map(entry => entry.text),
    warnings: entries.filter(entry => entry.severity === 'warning').map(entry => entry.text)
  };
}

export interface ConversionOptions {
  autoLayout?: boolean;
  validateOutput?: boolean;
  includeDataObjects?: boolean;
  preview?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  suggestions?: string[];
  supportedFeatures?: string[];
  unsupportedFeatures?: string[];
}

export interface AnalysisResult {
  nodeCount: number;
  edgeCount: number;
  subgraphCount: number;
  warnings: string[];
  complexity: 'simple' | 'medium' | 'complex';
  estimatedBpmnElements: {
    tasks: number;
    subprocesses: number;
    dataObjects: number;
    gateways: number;
    events: number;
    pools: number;
    flows: number;
  };
}

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
    
    if (options.validateOutput) {
      // Basic validation
      if (!result.xml.includes('startEvent') && ast.nodes.some(n => n.type === 'start')) {
        result.warnings.push('Start event may not be properly converted');
      }
      if (!result.xml.includes('endEvent') && ast.nodes.some(n => n.type === 'end')) {
        result.warnings.push('End event may not be properly converted');
      }
    }
    
    // Add stats for compatibility
    result.stats = {
      nodeCount: ast.nodes.length,
      edgeCount: ast.edges.length
    };
    
    return result;
  }

  async canConvert(mermaidCode: string): Promise<ValidationResult> {
    try {
      const parseResult = this.parser.parse(mermaidCode);
      const diagnostics = formatMermaidDiagnostics(parseResult);
      
      if (!parseResult.ast) {
        return {
          valid: false,
          errors: diagnostics.errors,
          warnings: diagnostics.warnings,
          suggestions: [
            'Check Mermaid syntax',
            'Ensure all nodes are properly defined',
            'Verify edge connections'
          ]
        };
      }

      const supportedFeatures = this.identifySupportedFeatures(parseResult.ast);
      const unsupportedFeatures = this.identifyUnsupportedFeatures(mermaidCode);

      return {
        valid: true,
        errors: [],
        warnings: diagnostics.warnings,
        supportedFeatures,
        unsupportedFeatures,
        suggestions: unsupportedFeatures.length > 0 
          ? [`Note: The following features will be approximated: ${unsupportedFeatures.join(', ')}`]
          : undefined
      };
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        warnings: [],
        suggestions: ['Ensure valid Mermaid flowchart syntax']
      };
    }
  }

  async analyze(mermaidCode: string): Promise<AnalysisResult> {
    const parseResult = this.parser.parse(mermaidCode);
    const diagnostics = formatMermaidDiagnostics(parseResult);
    
    if (!parseResult.ast) {
      throw this.parseFailure(diagnostics.all);
    }

    const ast = parseResult.ast;
    const nodeCount = ast.nodes.length;
    const edgeCount = ast.edges.length;
    const subgraphCount = ast.subgraphs.length;

    const decisionNodes = ast.nodes.filter(n => n.type === 'decision').length;
    const complexity = this.calculateComplexity(nodeCount, edgeCount, decisionNodes);

    return {
      nodeCount,
      edgeCount,
      subgraphCount,
      warnings: diagnostics.warnings,
      complexity,
      estimatedBpmnElements: {
        // Final parser types are mutually exclusive, so every node contributes
        // to at most one semantic category.
        tasks: ast.nodes.filter(n => n.type === 'process').length,
        subprocesses: ast.nodes.filter(n => n.type === 'subprocess').length,
        dataObjects: ast.nodes.filter(n => n.type === 'data').length,
        gateways: decisionNodes,
        events: ast.nodes.filter(n => ['start', 'end', 'terminator'].includes(n.type)).length,
        pools: subgraphCount,
        flows: edgeCount
      }
    };
  }




  private generateProcessName(ast: MermaidAST): string {
    const startNode = ast.nodes.find(n => n.type === 'start');
    if (startNode) {
      return startNode.label.replace(/start|begin/gi, '').trim() || 'Converted Process';
    }
    return 'Converted Process';
  }

  private parseFailure(errors: readonly string[]): Error {
    return new Error(`Failed to parse Mermaid diagram:\n${errors.join('\n')}`);
  }


  private calculateComplexity(
    nodeCount: number,
    edgeCount: number,
    decisionCount: number
  ): 'simple' | 'medium' | 'complex' {
    const score = nodeCount + (edgeCount * 0.5) + (decisionCount * 2);
    
    if (score < 10) return 'simple';
    if (score < 20) return 'medium';
    return 'complex';
  }

  private identifySupportedFeatures(ast: MermaidAST): string[] {
    const features: string[] = [];
    
    if (ast.nodes.some(n => n.type === 'process')) features.push('Tasks');
    if (ast.nodes.some(n => n.type === 'subprocess')) features.push('Subprocesses');
    if (ast.nodes.some(n => n.type === 'data')) features.push('Data objects');
    if (ast.nodes.some(n => n.type === 'decision')) features.push('Gateways');
    if (ast.nodes.some(n => ['start', 'end', 'terminator'].includes(n.type))) features.push('Events');
    if (ast.subgraphs.length > 0) features.push('Pools');
    if (ast.edges.some(e => e.label)) features.push('Labeled flows');
    
    return features;
  }

  private identifyUnsupportedFeatures(mermaidCode: string): string[] {
    const unsupported: string[] = [];
    
    if (mermaidCode.includes('linkStyle')) unsupported.push('Link styles');
    if (mermaidCode.includes('click')) unsupported.push('Click events');
    if (mermaidCode.includes(':::')) unsupported.push('CSS classes');
    if (mermaidCode.includes('style ')) unsupported.push('Inline styles');
    if (mermaidCode.includes('-.->')) unsupported.push('Dotted edge styles');
    
    return unsupported;
  }
}
