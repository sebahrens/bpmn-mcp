import { MermaidConverter } from '../../src/converters/MermaidConverter.js';
import { MermaidParser } from '../../src/converters/MermaidParser.js';

/**
 * Large-diagram bounds for the Mermaid -> BPMN pipeline (mcp-bpmn-5e7.13).
 *
 * The always-on cases bound *work* rather than the clock: element and flow
 * counts, serialized bytes per element, and how those bytes grow when the
 * diagram doubles. Those numbers do not move when the CI runner is busy, so
 * they can be tight enough to catch a quadratic regression the moment it lands.
 *
 * The 2,000-element benchmark is wall-clock bound and therefore opt-in, gated
 * the same way tests/integration/layout-candidates.test.ts is:
 *
 *   MCP_BPMN_PERF=1 npm run test:performance
 *
 * Auto-layout is switched off throughout: it is the browser-backed adapter's
 * cost, measured by its own suites, and mixing it in here would measure Chrome
 * rather than this pipeline.
 */
const BENCHMARK_ENABLED = process.env.MCP_BPMN_PERF === '1';
const describeBenchmark = BENCHMARK_ENABLED ? describe : describe.skip;

/** A chain with a gateway branch every tenth node, so edges outnumber nodes. */
function largeMermaidDiagram(nodeCount: number): string {
  const lines = ['flowchart TD', '  N0((Start))'];
  for (let index = 1; index < nodeCount - 1; index++) {
    lines.push(index % 10 === 0 ? `  N${index}{Check ${index}}` : `  N${index}[Step ${index}]`);
  }
  lines.push(`  N${nodeCount - 1}((End))`);
  for (let index = 0; index < nodeCount - 1; index++) {
    lines.push(`  N${index} --> N${index + 1}`);
  }
  // Every gateway also short-circuits two steps ahead: a second outgoing flow
  // per branch keeps the graph from being a trivial path.
  for (let index = 10; index < nodeCount - 2; index += 10) {
    lines.push(`  N${index} -->|skip| N${index + 2}`);
  }
  return lines.join('\n');
}

interface PipelineMeasurement {
  nodeCount: number;
  elementCount: number;
  flowCount: number;
  bytes: number;
  bytesPerElement: number;
  milliseconds: number;
}

async function measurePipeline(nodeCount: number): Promise<PipelineMeasurement> {
  const converter = new MermaidConverter();
  const source = largeMermaidDiagram(nodeCount);
  const startedAt = performance.now();
  const result = await converter.convert(source, { autoLayout: false });
  const milliseconds = performance.now() - startedAt;
  const bytes = Buffer.byteLength(result.xml, 'utf8');

  return {
    nodeCount,
    elementCount: result.elements.length,
    flowCount: result.flows.length,
    bytes,
    bytesPerElement: bytes / result.elements.length,
    milliseconds
  };
}

describe('large diagram work bounds', () => {
  // Measured on the development container: 500 nodes -> 500 elements, 548
  // flows, 245,256 bytes, 490.5 bytes/element (250 nodes: 488.1). The ceiling
  // is ~1.6x the measurement, which leaves room for extra DI attributes while
  // still failing on a serializer that starts emitting per-element quadratic
  // output. Bytes are deterministic, so this number does not flake.
  const MAX_BYTES_PER_ELEMENT = 800;

  it('converts a 500-node diagram into exactly the elements it declares', async () => {
    const measurement = await measurePipeline(500);
    const expectedFlows = 499 + Math.floor((500 - 3) / 10);

    expect(measurement.elementCount).toBe(500);
    expect(measurement.flowCount).toBe(expectedFlows);
    expect(measurement.bytesPerElement).toBeLessThan(MAX_BYTES_PER_ELEMENT);
  });

  it('grows serialized output linearly when the diagram doubles', async () => {
    const [small, large] = await Promise.all([
      measurePipeline(250),
      measurePipeline(500)
    ]);

    // Doubling the node count must not more than roughly double the bytes.
    // Measured ratio is ~2.02; 2.4 absorbs the fixed document preamble and any
    // ID-width growth, while a quadratic serializer would land near 4.
    expect(large.bytes / small.bytes).toBeLessThan(2.4);
    expect(large.elementCount).toBe(2 * small.elementCount);
  });

  it('allocates a unique ID for every element and flow at scale', () => {
    const parser = new MermaidParser();
    const result = parser.parse(largeMermaidDiagram(500));
    const edgeIds = result.ast?.edges.map(edge => edge.id) ?? [];

    expect(result.errors).toEqual([]);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });
});

describeBenchmark('2,000-element benchmark (MCP_BPMN_PERF=1)', () => {
  // 2,000 elements is the configured maxLayoutElements ceiling, so this is the
  // largest diagram the server accepts for layout. Measured on the development
  // container: 414 ms for parse + generate + serialize on an idle machine and
  // 890 ms with a type-check and a lint run competing for the same cores;
  // 2,198 flows, 998,134 bytes (499 bytes/element) every time.
  //
  // The budget is 8 s: ~19x the idle measurement and ~9x the measurement under
  // contention, so an oversubscribed runner will not flake it,
  // and a catastrophic regression (pathological backtracking, an accidental
  // exponential, a layout call sneaking back in) blows straight through it.
  //
  // It is deliberately a backstop and not the primary gate. An accidental
  // quadratic was injected into the generator's edge loop while calibrating
  // this: it moved 2,000 elements from 414 ms to 613 ms, which no
  // non-flaky wall-clock bound would catch. The byte and count bounds are the
  // machine-independent part that does catch that class of change.
  const BUDGET_MS = 8_000;

  it('converts 2,000 elements within the time budget', async () => {
    const measurement = await measurePipeline(2_000);

    // eslint-disable-next-line no-console
    console.log(
      `[perf] 2,000-element convert: ${measurement.milliseconds.toFixed(0)} ms, `
      + `${measurement.elementCount} elements, ${measurement.flowCount} flows, `
      + `${measurement.bytes} bytes (${measurement.bytesPerElement.toFixed(0)} bytes/element)`
    );

    expect(measurement.elementCount).toBe(2_000);
    expect(measurement.flowCount).toBe(1_999 + Math.floor((2_000 - 3) / 10));
    expect(measurement.bytesPerElement).toBeLessThan(800);
    expect(measurement.milliseconds).toBeLessThan(BUDGET_MS);
  }, 60_000);
});
