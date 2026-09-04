import type { ParseErrorCode, ParseResult, ParseWarningCode } from '../../src/converters/ASTTypes.js';
import { MermaidParser } from '../../src/converters/MermaidParser.js';
import { FileManager } from '../../src/utils/FileManager.js';
import {
  createSeededRandom,
  generateMermaidDiagram,
  generateMermaidJunk,
  mutateText
} from '../helpers/seededRandom.js';

/**
 * Property/fuzz cover for the Mermaid front door (mcp-bpmn-5e7.13).
 *
 * The seed is pinned so a CI failure is reproducible: every case index derives
 * its own stream from PARSER_SEED, and the failure report prints the case index
 * and the exact input that broke the property.
 */
const PARSER_SEED = 0x5e7130;
const CASES = 400;

// The full ParseResult vocabulary. Kept literal on purpose: a new code has to
// be added here consciously, which is the moment to ask whether agents can act
// on it.
const ERROR_CODES: ReadonlySet<ParseErrorCode> = new Set<ParseErrorCode>([
  'EMPTY_DIAGRAM',
  'MALFORMED_HEADER',
  'MALFORMED_NODE',
  'MALFORMED_EDGE',
  'MALFORMED_SUBGRAPH',
  'UNSUPPORTED_SHAPE',
  'UNSUPPORTED_CONNECTOR',
  'UNEXPECTED_SUBGRAPH_END',
  'UNCLOSED_SUBGRAPH',
  'UNSUPPORTED_NESTED_SUBGRAPH',
  'UNKNOWN_SYNTAX',
  'DUPLICATE_SUBGRAPH',
  'MISSING_SUBGRAPH_OWNER',
  'MULTIPLE_SUBGRAPH_OWNERS',
  'UNSUPPORTED_EDGE_ENDPOINT'
]);

const WARNING_CODES: ReadonlySet<ParseWarningCode> = new Set<ParseWarningCode>([
  'UNSUPPORTED_DIRECTIVE',
  'UNSUPPORTED_EDGE_STYLE',
  'DUPLICATE_NODE',
  'MISSING_START',
  'MISSING_END',
  'DISCONNECTED_NODE',
  'IMPLICIT_PARALLEL_SPLIT'
]);

interface Offender {
  case: number;
  reason: string;
  input: string;
}

function describeInput(input: string): string {
  const rendered = JSON.stringify(input);
  return rendered.length > 300 ? `${rendered.slice(0, 300)}...` : rendered;
}

/** Every diagnostic must be structured enough for an agent to act on. */
function diagnosticProblems(result: ParseResult, input: string): string[] {
  const problems: string[] = [];
  const lineCount = input.split('\n').length;

  for (const error of result.errors) {
    if (!ERROR_CODES.has(error.code)) problems.push(`unknown error code ${error.code}`);
    if (error.severity !== 'error') problems.push(`error severity ${String(error.severity)}`);
    if (!Number.isInteger(error.line) || error.line < 1 || error.line > lineCount) {
      problems.push(`error line out of range: ${error.line} of ${lineCount}`);
    }
    if (!Number.isInteger(error.column) || error.column < 1) {
      problems.push(`error column out of range: ${error.column}`);
    }
    if (typeof error.message !== 'string' || !error.message) problems.push('empty error message');
    if (typeof error.source !== 'string') problems.push('missing error source line');
  }

  for (const warning of result.warnings) {
    if (!WARNING_CODES.has(warning.code)) problems.push(`unknown warning code ${warning.code}`);
    if (warning.severity !== 'warning') problems.push(`warning severity ${String(warning.severity)}`);
    if (!Number.isInteger(warning.line) || warning.line < 1 || warning.line > lineCount) {
      problems.push(`warning line out of range: ${warning.line} of ${lineCount}`);
    }
    if (!Number.isInteger(warning.column) || warning.column < 1) {
      problems.push(`warning column out of range: ${warning.column}`);
    }
    if (typeof warning.message !== 'string' || !warning.message) problems.push('empty warning message');
  }

  if (result.errors.length === 0 && !result.ast) {
    problems.push('no AST and no error explaining why');
  }
  if (result.ast) {
    const nodeIds = new Set(result.ast.nodes.map(node => node.id));
    const edgeIds = result.ast.edges.map(edge => edge.id);
    if (new Set(edgeIds).size !== edgeIds.length) problems.push('duplicate edge IDs');
    for (const edge of result.ast.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        problems.push(`edge ${edge.id} references an undeclared node`);
      }
    }
  }

  return problems;
}

describe('MermaidParser diagnostic properties', () => {
  const parser = new MermaidParser();

  it(`returns typed diagnostics and never throws over ${CASES} seeded inputs`, () => {
    const offenders: Offender[] = [];

    for (let index = 0; index < CASES; index++) {
      const random = createSeededRandom(PARSER_SEED + index);
      const kind = index % 4;
      let input: string;
      if (kind === 0) {
        input = generateMermaidJunk(random);
      } else if (kind === 1) {
        input = mutateText(random, generateMermaidDiagram(random).source);
      } else if (kind === 2) {
        input = generateMermaidDiagram(random).source;
      } else {
        input = mutateText(random, generateMermaidJunk(random));
      }

      let result: ParseResult;
      try {
        result = parser.parse(input);
      } catch (error) {
        offenders.push({
          case: index,
          reason: `threw ${(error as Error)?.message ?? String(error)}`,
          input: describeInput(input)
        });
        continue;
      }

      for (const problem of diagnosticProblems(result, input)) {
        offenders.push({ case: index, reason: problem, input: describeInput(input) });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('parses a well-formed generated diagram without errors', () => {
    const offenders: Offender[] = [];

    for (let index = 0; index < 150; index++) {
      const random = createSeededRandom(PARSER_SEED + 1_000 + index);
      const { source, nodeIds } = generateMermaidDiagram(random);
      const result = parser.parse(source);

      if (result.errors.length > 0) {
        offenders.push({
          case: index,
          reason: result.errors.map(error => `${error.code}: ${error.message}`).join('; '),
          input: describeInput(source)
        });
        continue;
      }
      const parsedIds = new Set(result.ast?.nodes.map(node => node.id) ?? []);
      const missing = nodeIds.filter(id => !parsedIds.has(id));
      if (missing.length > 0) {
        offenders.push({
          case: index,
          reason: `dropped declared nodes ${missing.join(', ')}`,
          input: describeInput(source)
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('re-parses identically for the same input', () => {
    const offenders: Offender[] = [];

    for (let index = 0; index < 100; index++) {
      const random = createSeededRandom(PARSER_SEED + 2_000 + index);
      const input = index % 2 === 0
        ? generateMermaidDiagram(random).source
        : generateMermaidJunk(random);
      const first = JSON.stringify(parser.parse(input));
      const second = JSON.stringify(new MermaidParser().parse(input));

      if (first !== second) {
        offenders.push({ case: index, reason: 'parse is not deterministic', input: describeInput(input) });
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('FileManager.sanitizeFilename properties', () => {
  const fileManager = new FileManager();

  it('never yields a separator, a traversal segment, or an overlong name', () => {
    const offenders: Offender[] = [];

    for (let index = 0; index < 500; index++) {
      const random = createSeededRandom(PARSER_SEED + 3_000 + index);
      // Reuse the Mermaid junk alphabet: it already carries slashes, dots,
      // quotes, control-ish whitespace and non-ASCII code points.
      const input = generateMermaidJunk(random);
      const sanitized = fileManager.sanitizeFilename(input);

      const reasons: string[] = [];
      if (/[/\\]/.test(sanitized)) reasons.push('contains a path separator');
      if (sanitized.split(/[/\\]/).some(segment => segment === '..')) reasons.push('contains a traversal segment');
      if (sanitized.includes('..')) reasons.push('contains consecutive dots');
      if (sanitized.length > 255) reasons.push(`length ${sanitized.length} exceeds 255`);
      for (const reason of reasons) {
        offenders.push({ case: index, reason, input: describeInput(input) });
      }
    }

    expect(offenders).toEqual([]);
  });
});
