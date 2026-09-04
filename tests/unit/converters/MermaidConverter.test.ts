import { MermaidConverter } from '../../../src/converters/MermaidConverter.js';

/**
 * `canConvert` and `analyze` were removed (mcp-bpmn-iqa.12): neither had a
 * production caller, and `preview_mermaid` builds its report from `convert`
 * output. These suites therefore pin the same diagnostics and the same node
 * census through `convert`, the one surviving entry point.
 */
const BPMN_CATEGORIES = {
  tasks: ['bpmn:Task'],
  subprocesses: ['bpmn:SubProcess'],
  dataObjects: ['bpmn:DataObjectReference'],
  gateways: ['bpmn:ExclusiveGateway'],
  events: ['bpmn:StartEvent', 'bpmn:EndEvent', 'bpmn:IntermediateThrowEvent']
} as const;

function censusByCategory(
  elements: ReadonlyArray<{ type: string }>
): Record<keyof typeof BPMN_CATEGORIES, number> {
  const census = { tasks: 0, subprocesses: 0, dataObjects: 0, gateways: 0, events: 0 };
  for (const element of elements) {
    for (const [category, types] of Object.entries(BPMN_CATEGORIES)) {
      if ((types as readonly string[]).includes(element.type)) {
        census[category as keyof typeof census]++;
      }
    }
  }
  return census;
}

describe('MermaidConverter node census', () => {
  const converter = new MermaidConverter();

  it.each([
    {
      name: 'terminator-shaped completion',
      diagram: 'flowchart TD\n  A((Start)) --> B[Process Order] --> C((Order Ended))',
      expected: { tasks: 1, subprocesses: 0, dataObjects: 0, gateways: 0, events: 2 }
    },
    {
      name: 'generic rectangular completion',
      diagram: 'flowchart TD\n  A[Start] --> B[End]',
      expected: { tasks: 0, subprocesses: 0, dataObjects: 0, gateways: 0, events: 2 }
    },
    {
      name: 'rectangular completion task',
      diagram: 'flowchart TD\n  A[Start] --> B[Order Complete]',
      expected: { tasks: 1, subprocesses: 0, dataObjects: 0, gateways: 0, events: 1 }
    },
    {
      name: 'process and subprocess activities',
      diagram: 'flowchart TD\n  A[Start] --> B[Review Order] --> C[/Manual follow-up/] --> D[End]',
      expected: { tasks: 1, subprocesses: 1, dataObjects: 0, gateways: 0, events: 2 }
    },
    {
      name: 'gateway and intermediate event',
      diagram: 'flowchart TD\n  A{Route} --> B((Wait)) --> C[Finish work]',
      expected: { tasks: 1, subprocesses: 0, dataObjects: 0, gateways: 1, events: 1 }
    }
  ])('maps every node to exactly one BPMN category for $name', async ({ diagram, expected }) => {
    const conversion = await converter.convert(diagram, { autoLayout: false });

    expect(censusByCategory(conversion.elements)).toEqual(expected);
    expect(
      expected.tasks
      + expected.subprocesses
      + expected.dataObjects
      + expected.gateways
      + expected.events
    ).toBe(conversion.stats.nodeCount);
  });
});

describe('MermaidConverter parser validity', () => {
  const converter = new MermaidConverter();
  const malformed = 'flowchart TD\n  A((Start)) --> B[Missing close';

  it('reports every located, categorized error in one parse failure', async () => {
    const source = [
      'flowchart TD',
      '  A[Missing close',
      '  B((Start)) --> C((End))',
      '    -> E',
      '  F has trailing content'
    ].join('\n');
    const diagnostics = [
      '2:4 [MALFORMED_NODE] Malformed shape for node "A"',
      '4:5 [MALFORMED_EDGE] Expected a Mermaid node identifier',
      '5:5 [UNKNOWN_SYNTAX] Unrecognized Mermaid flowchart syntax'
    ];
    const failure = `Failed to parse Mermaid diagram:\n${diagnostics.join('\n')}`;

    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
  });

  it('keeps mixed warnings and errors source-ordered in the parse failure', async () => {
    const source = [
      'flowchart TD',
      '  A((Start)) -.-> B((End))',
      '  C[Missing close',
      '  style A fill:#fff'
    ].join('\n');
    const diagnostics = [
      '2:14 [UNSUPPORTED_EDGE_STYLE] Dotted Mermaid edge A_to_B is converted without dotted styling',
      '3:4 [MALFORMED_NODE] Malformed shape for node "C"',
      '4:3 [UNSUPPORTED_DIRECTIVE] Unsupported Mermaid directive "style"; ignored'
    ];
    const failure = `Failed to parse Mermaid diagram:\n${diagnostics.join('\n')}`;

    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
  });

  it('surfaces located, categorized warnings on a successful conversion', async () => {
    const source = [
      'flowchart TD',
      '  A((Start)) -.-> B((End))',
      '  style A fill:#fff'
    ].join('\n');
    const diagnostics = [
      '2:14 [UNSUPPORTED_EDGE_STYLE] Dotted Mermaid edge A_to_B is converted without dotted styling',
      '3:3 [UNSUPPORTED_DIRECTIVE] Unsupported Mermaid directive "style"; ignored'
    ];

    await expect(converter.convert(source, { autoLayout: false })).resolves.toMatchObject({
      warnings: diagnostics
    });
  });

  it('bounds a large diagnostic set at twenty entries plus a truncation notice', async () => {
    const source = [
      'flowchart TD',
      ...Array.from({ length: 25 }, (_, index) => `  N${index}[Missing close`)
    ].join('\n');
    const errors = [
      ...Array.from({ length: 20 }, (_, index) =>
        `${index + 2}:${3 + `N${index}`.length} [MALFORMED_NODE] Malformed shape for node "N${index}"`
      ),
      '22:6 [DIAGNOSTICS_TRUNCATED] 5 additional error diagnostics omitted'
    ];

    expect(errors).toHaveLength(21);
    const failure = `Failed to parse Mermaid diagram:\n${errors.join('\n')}`;
    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
  });

  it('uses stable tie-breakers for diagnostics at the same source location', async () => {
    const source = 'flowchart TD\n  A((Start)) -.-> B[[Record]]';
    const errors = [
      '2:14 [UNSUPPORTED_EDGE_ENDPOINT] Edge A_to_B cannot connect a BPMN flow to a data object'
    ];
    const warnings = [
      '1:1 [MISSING_END] No explicit end node found. Consider adding an end event.',
      '2:14 [UNSUPPORTED_EDGE_STYLE] Dotted Mermaid edge A_to_B is converted without dotted styling',
      '2:19 [DISCONNECTED_NODE] Node "B" has no outgoing connections'
    ];
    const failure = `Failed to parse Mermaid diagram:\n${[
      warnings[0],
      errors[0],
      warnings[1],
      warnings[2]
    ].join('\n')}`;

    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
  });

  it('uses the same per-category bounds for large mixed diagnostic sets', async () => {
    const source = [
      'flowchart TD',
      ...Array.from({ length: 25 }, (_, index) => [
        `  style N${index} fill:#fff`,
        `  N${index}[Missing close`
      ]).flat()
    ].join('\n');
    const visibleWarnings = Array.from({ length: 20 }, (_, index) =>
      `${2 + (index * 2)}:3 [UNSUPPORTED_DIRECTIVE] Unsupported Mermaid directive "style"; ignored`
    );
    const visibleErrors = Array.from({ length: 20 }, (_, index) => {
      const nodeId = `N${index}`;
      return `${3 + (index * 2)}:${3 + nodeId.length} [MALFORMED_NODE] Malformed shape for node "${nodeId}"`;
    });
    const warnings = [
      ...visibleWarnings,
      '42:3 [DIAGNOSTICS_TRUNCATED] 5 additional warning diagnostics omitted'
    ];
    const errors = [
      ...visibleErrors,
      '43:6 [DIAGNOSTICS_TRUNCATED] 5 additional error diagnostics omitted'
    ];
    const diagnostics = visibleWarnings.flatMap((warning, index) => [warning, visibleErrors[index]]);
    diagnostics.push(warnings.at(-1)!, errors.at(-1)!);
    const failure = `Failed to parse Mermaid diagram:\n${diagnostics.join('\n')}`;

    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
  });

  it('bounds individual diagnostic messages consistently', async () => {
    const subgraphId = 'N'.repeat(260);
    const source = [
      'flowchart TD',
      `  subgraph ${subgraphId}[One]`,
      '    A((Start)) --> B((End))',
      '  end',
      `  subgraph ${subgraphId}[Two]`,
      '    C((Start)) --> D((End))',
      '  end'
    ].join('\n');
    const message = `Duplicate Mermaid subgraph ID: ${subgraphId}`;
    const diagnostic = `5:3 [DUPLICATE_SUBGRAPH] ${message.slice(0, 237)}...`;
    const failure = `Failed to parse Mermaid diagram:\n${diagnostic}`;

    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
  });

  it.each([
    ['empty input', ''],
    ['comments-only input', '%% comments do not define a diagram'],
    ['declaration-only input', 'flowchart TD'],
    ['wholly unrecognized input', 'nonsense']
  ])('rejects %s with a parse failure', async (_name, source) => {
    await expect(converter.convert(source, { autoLayout: false }))
      .rejects.toThrow('Failed to parse Mermaid diagram');
  });

  it.each([
    ['declaration-less syntax', 'A((Start)) --> B((End))', 2, 1],
    ['chained edges', 'flowchart TD\nA((Start)) --> B[Work] --> C((End))', 3, 2],
    ['labeled edges', 'flowchart LR\nA((Start)) -->|approved| B((End))', 2, 1],
    ['dotted edges', 'graph TD\nA((Start)) -.-> B((End))', 2, 1],
    ['cycles', 'flowchart TD\nA[Work] --> B[Retry]\nB --> A', 2, 2],
    [
      'subgraphs',
      'flowchart TD\nsubgraph team[Team]\nA((Start)) --> B((End))\nend',
      2,
      1
    ]
  ])('accepts supported %s', async (_name, source, nodeCount, edgeCount) => {
    await expect(converter.convert(source, { autoLayout: false })).resolves.toMatchObject({
      stats: { nodeCount, edgeCount }
    });
  });

  // A whole-graph analysis run against a half-parsed graph reported "A has no
  // outgoing connections" for an edge the author did write; the malformed
  // target is the only real fault here (mcp-bpmn-j21.13).
  it('rejects malformed input with the located diagnostic and nothing else', async () => {
    await expect(converter.convert(malformed)).rejects.toEqual(new Error(
      'Failed to parse Mermaid diagram:\n2:19 [MALFORMED_NODE] Malformed shape for node "B"'
    ));
  });

  it('converts warning-only input and keeps the warnings', async () => {
    const diagram = 'flowchart TD\n  A((Start)) --> B((End))\n  style A fill:#fff';

    await expect(converter.convert(diagram, { autoLayout: false })).resolves.toMatchObject({
      stats: { nodeCount: 2, edgeCount: 1 },
      warnings: expect.arrayContaining([expect.stringContaining('Unsupported Mermaid directive "style"')])
    });
  });

  // ConversionOptions.validateOutput went with canConvert and analyze
  // (mcp-bpmn-iqa.12): it had no caller either, and the two warnings it could
  // append can never fire, because the generator emits the events the AST
  // declares. That guarantee is asserted directly instead.
  it('emits the start and end events the diagram declares', async () => {
    const conversion = await converter.convert(
      'flowchart TD\n  A((Start)) --> B[Work] --> C((End))',
      { autoLayout: false }
    );

    expect(conversion.xml).toContain('startEvent');
    expect(conversion.xml).toContain('endEvent');
    expect(conversion.warnings).toEqual([]);
  });

  it('retains labeled-flow support after parser validation', async () => {
    const diagram = 'flowchart TD\n  A((Start)) -->|approved| B((End))';

    const conversion = await converter.convert(diagram, { autoLayout: false });

    expect(conversion.flows).toEqual([expect.objectContaining({ label: 'approved' })]);
  });

  it.each([
    [
      'duplicate subgraph IDs',
      'flowchart TD\n  subgraph team[One]\n    A((Start))\n  end\n  subgraph team[Two]\n    B((End))\n  end',
      'Duplicate Mermaid subgraph ID: team'
    ],
    [
      'mixed root and subgraph ownership',
      'flowchart TD\n  subgraph team[Team]\n    A((Start))\n  end\n  B((End))',
      'Mermaid node B is not owned by a subgraph'
    ],
    [
      'multiple subgraph ownership',
      'flowchart TD\n  subgraph one[One]\n    A((Start))\n  end\n  subgraph two[Two]\n    A --> B((End))\n  end',
      'Mermaid node A belongs to multiple subgraphs'
    ],
    [
      'nested subgraphs',
      'flowchart TD\n  subgraph outer[Outer]\n    subgraph inner[Inner]\n      A((Start)) --> B((End))\n    end\n  end',
      'Nested Mermaid subgraphs are not supported for BPMN conversion'
    ]
  ])('rejects $name', async (_name, source, message) => {
    await expect(converter.convert(source, { autoLayout: false })).rejects.toThrow(message);
  });
});
