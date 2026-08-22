import { MermaidConverter } from '../../../src/converters/MermaidConverter.js';

describe('MermaidConverter analysis', () => {
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
  ])('counts final node types exclusively for $name', async ({ diagram, expected }) => {
    const analysis = await converter.analyze(diagram);

    expect(analysis.estimatedBpmnElements).toMatchObject(expected);
    expect(
      expected.tasks
      + expected.subprocesses
      + expected.dataObjects
      + expected.gateways
      + expected.events
    ).toBe(analysis.nodeCount);
  });
});

describe('MermaidConverter parser validity', () => {
  const converter = new MermaidConverter();
  const malformed = 'flowchart TD\n  A((Start)) --> B[Missing close';

  it('surfaces the same located, categorized errors from every entry point', async () => {
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
    await expect(converter.canConvert(source)).resolves.toMatchObject({
      valid: false,
      errors: diagnostics
    });
    await expect(converter.analyze(source)).rejects.toEqual(new Error(failure));
  });

  it('keeps mixed warnings and errors source-ordered in failed entry points', async () => {
    const source = [
      'flowchart TD',
      '  A((Start)) -.-> B((End))',
      '  C[Missing close',
      '  style A fill:#fff'
    ].join('\n');
    const warnings = [
      '2:14 [UNSUPPORTED_EDGE_STYLE] Dotted Mermaid edge A_to_B is converted without dotted styling',
      '4:3 [UNSUPPORTED_DIRECTIVE] Unsupported Mermaid directive "style"; ignored'
    ];
    const errors = ['3:4 [MALFORMED_NODE] Malformed shape for node "C"'];
    const diagnostics = [warnings[0], errors[0], warnings[1]];
    const failure = `Failed to parse Mermaid diagram:\n${diagnostics.join('\n')}`;

    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
    await expect(converter.canConvert(source)).resolves.toMatchObject({ errors, warnings });
    await expect(converter.analyze(source)).rejects.toEqual(new Error(failure));
  });

  it('surfaces the same located, categorized warnings from every entry point', async () => {
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
    await expect(converter.canConvert(source)).resolves.toMatchObject({ warnings: diagnostics });
    await expect(converter.analyze(source)).resolves.toMatchObject({ warnings: diagnostics });
  });

  it('bounds large diagnostic sets consistently', async () => {
    const source = [
      'flowchart TD',
      ...Array.from({ length: 25 }, (_, index) => `  N${index}[Missing close`)
    ].join('\n');
    const validation = await converter.canConvert(source);

    expect(validation.errors).toHaveLength(21);
    expect(validation.errors.at(-1)).toBe(
      '22:6 [DIAGNOSTICS_TRUNCATED] 5 additional error diagnostics omitted'
    );

    const failure = `Failed to parse Mermaid diagram:\n${validation.errors.join('\n')}`;
    await expect(converter.convert(source, { autoLayout: false })).rejects.toEqual(new Error(failure));
    await expect(converter.analyze(source)).rejects.toEqual(new Error(failure));
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
    await expect(converter.canConvert(source)).resolves.toMatchObject({ errors, warnings });
    await expect(converter.analyze(source)).rejects.toEqual(new Error(failure));
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
    await expect(converter.canConvert(source)).resolves.toMatchObject({ errors, warnings });
    await expect(converter.analyze(source)).rejects.toEqual(new Error(failure));
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
    await expect(converter.canConvert(source)).resolves.toMatchObject({ errors: [diagnostic] });
    await expect(converter.analyze(source)).rejects.toEqual(new Error(failure));
  });

  it.each([
    ['empty input', ''],
    ['comments-only input', '%% comments do not define a diagram'],
    ['declaration-only input', 'flowchart TD'],
    ['wholly unrecognized input', 'nonsense']
  ])('rejects %s consistently from convert, canConvert, and analyze', async (_name, source) => {
    await expect(converter.convert(source, { autoLayout: false }))
      .rejects.toThrow('Failed to parse Mermaid diagram');
    await expect(converter.canConvert(source)).resolves.toMatchObject({ valid: false });
    await expect(converter.analyze(source)).rejects.toThrow('Failed to parse Mermaid diagram');
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
  ])('accepts supported %s consistently at every converter entry point', async (
    _name,
    source,
    nodeCount,
    edgeCount
  ) => {
    await expect(converter.convert(source, { autoLayout: false })).resolves.toMatchObject({
      stats: { nodeCount, edgeCount }
    });
    await expect(converter.canConvert(source)).resolves.toMatchObject({ valid: true, errors: [] });
    await expect(converter.analyze(source)).resolves.toMatchObject({ nodeCount, edgeCount });
  });

  it('rejects malformed input consistently from convert, canConvert, and analyze', async () => {
    await expect(converter.convert(malformed)).rejects.toThrow('Malformed shape for node "B"');
    await expect(converter.canConvert(malformed)).resolves.toMatchObject({
      valid: false,
      errors: ['2:19 [MALFORMED_NODE] Malformed shape for node "B"']
    });
    await expect(converter.analyze(malformed)).rejects.toThrow('Failed to parse Mermaid diagram');
  });

  it('accepts warning-only input consistently from convert, canConvert, and analyze', async () => {
    const diagram = 'flowchart TD\n  A((Start)) --> B((End))\n  style A fill:#fff';

    await expect(converter.convert(diagram, { autoLayout: false })).resolves.toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('Unsupported Mermaid directive "style"')])
    });
    await expect(converter.canConvert(diagram)).resolves.toMatchObject({ valid: true, errors: [] });
    await expect(converter.analyze(diagram)).resolves.toMatchObject({ nodeCount: 2, edgeCount: 1 });
  });

  it('retains labeled-flow support after parser validation', async () => {
    const diagram = 'flowchart TD\n  A((Start)) -->|approved| B((End))';

    await expect(converter.canConvert(diagram)).resolves.toMatchObject({
      valid: true,
      supportedFeatures: expect.arrayContaining(['Labeled flows'])
    });
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
  ])('rejects $name consistently at every converter entry point', async (_name, source, message) => {
    await expect(converter.convert(source, { autoLayout: false })).rejects.toThrow(message);
    await expect(converter.canConvert(source)).resolves.toMatchObject({ valid: false });
    await expect(converter.analyze(source)).rejects.toThrow('Failed to parse Mermaid diagram');
  });
});
