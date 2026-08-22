import { MermaidParser } from '../../../src/converters/MermaidParser.js';
import type { NodeType } from '../../../src/converters/ASTTypes.js';

describe('MermaidParser event inference', () => {
  const parser = new MermaidParser();

  it.each([
    ['Start', 'start'],
    [' START ', 'start'],
    ['Begin', 'start'],
    ['End', 'end'],
    ['STOP', 'end'],
    ['Finish', 'end']
  ] as Array<[string, NodeType]>)('classifies the exact keyword %p as %s', (label, expectedType) => {
    const result = parser.parse(`flowchart TD\n  A[${label}]`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes[0].type).toBe(expectedType);
  });

  it.each([
    'Restart service',
    'Beginner review',
    'Weekend processing',
    'Pitstop check',
    'End-to-end test'
  ])('does not classify the incidental substring in %p as an event', label => {
    const result = parser.parse(`flowchart TD\n  A[${label}]`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes[0].type).toBe('process');
  });

  it.each([
    ['A{Start}', 'decision'],
    ['A[[End]]', 'data'],
    ['A[/Stop/]', 'subprocess']
  ] as Array<[string, NodeType]>)('preserves the explicit shape for %p', (definition, expectedType) => {
    const result = parser.parse(`flowchart TD\n  ${definition}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes[0].type).toBe(expectedType);
  });

  it.each([
    {
      name: 'source terminator',
      diagram: 'flowchart TD\n  A((Order Received)) --> B[Process Order]',
      nodeId: 'A',
      expectedType: 'start'
    },
    {
      name: 'sink terminator',
      diagram: 'flowchart TD\n  A[Process Order] --> B((Order Complete))',
      nodeId: 'B',
      expectedType: 'end'
    },
    {
      name: 'isolated terminator',
      diagram: 'flowchart TD\n  A((Wait for Signal))',
      nodeId: 'A',
      expectedType: 'terminator'
    },
    {
      name: 'terminator in a cycle',
      diagram: 'flowchart TD\n  A((Wait for Signal)) --> B[Retry]\n  B --> A',
      nodeId: 'A',
      expectedType: 'terminator'
    },
    {
      name: 'rectangular terminal task',
      diagram: 'flowchart TD\n  A[Process Order] --> B[Order Complete]',
      nodeId: 'B',
      expectedType: 'process'
    },
    {
      name: 'exact keyword before conflicting terminator topology',
      diagram: 'flowchart TD\n  A[Process Order] --> B((Start))',
      nodeId: 'B',
      expectedType: 'start'
    }
  ] as Array<{ name: string; diagram: string; nodeId: string; expectedType: NodeType }>)(
    'applies deterministic precedence for $name',
    ({ diagram, nodeId, expectedType }) => {
      const result = parser.parse(diagram);

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes.find(node => node.id === nodeId)?.type).toBe(expectedType);
    }
  );
});

describe('MermaidParser parallel edge IDs', () => {
  const parser = new MermaidParser();

  it.each([
    [
      'unlabeled edges',
      ['A((Start)) --> B((End))', 'A --> B'],
      ['A_to_B', 'A_to_B_2']
    ],
    [
      'labeled edges',
      ['A((Start)) -->|approved| B((End))', 'A -->|rejected| B'],
      ['A_to_B', 'A_to_B_2']
    ],
    [
      'dotted edges',
      ['A((Start)) -.-> B((End))', 'A -.-> B'],
      ['A_to_B', 'A_to_B_2']
    ],
    [
      'mixed edge styles',
      ['A((Start)) --> B((End))', 'A -->|approved| B', 'A -.->|retry| B'],
      ['A_to_B', 'A_to_B_2', 'A_to_B_3']
    ],
    [
      'identical duplicate edges',
      ['A((Start)) -->|same| B((End))', 'A -->|same| B'],
      ['A_to_B', 'A_to_B_2']
    ]
  ])('allocates unique occurrence suffixes for %s', (_name, edges, expectedIds) => {
    const source = ['flowchart TD', ...edges.map(edge => `  ${edge}`)].join('\n');
    const result = parser.parse(source);

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.map(edge => edge.id)).toEqual(expectedIds);
  });

  it('resets edge ID allocation for every parse', () => {
    const source = [
      'flowchart TD',
      '  A((Start)) --> B((End))',
      '  A -->|approved| B',
      '  A -.-> B'
    ].join('\n');

    const firstIds = parser.parse(source).ast?.edges.map(edge => edge.id);
    const secondIds = parser.parse(source).ast?.edges.map(edge => edge.id);

    expect(firstIds).toEqual(['A_to_B', 'A_to_B_2', 'A_to_B_3']);
    expect(secondIds).toEqual(firstIds);
  });
});

describe('MermaidParser diagnostics', () => {
  const parser = new MermaidParser();

  it.each([
    ['empty input', ''],
    ['whitespace-only input', ' \n\t'],
    ['comments-only input', '%% a comment\n  %% another comment'],
    ['a declaration without nodes', 'flowchart TD'],
    ['warning-only directives without nodes', 'flowchart TD\n  style A fill:#fff']
  ])('rejects %s because it has no convertible nodes', (_name, source) => {
    const result = parser.parse(source);

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code: 'EMPTY_DIAGRAM',
        line: expect.any(Number),
        column: expect.any(Number),
        message: 'Mermaid flowchart must contain at least one node'
      })
    ]));
  });

  it('keeps nonfatal directives as warnings when rejecting an otherwise empty document', () => {
    const result = parser.parse('flowchart TD\n  classDef highlighted fill:#fff');

    expect(result.errors.map(error => error.code)).toEqual(['EMPTY_DIAGRAM']);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_DIRECTIVE' })
    ]));
  });

  it('does not treat an arbitrary bare word as a declaration-less flowchart', () => {
    const result = parser.parse('nonsense');

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_SYNTAX',
        line: 1,
        column: 1,
        message: 'Expected a Mermaid graph/flowchart declaration or declaration-less flowchart syntax'
      })
    ]);
  });

  it.each([
    ['declaration-less nodes', 'A((Start)) --> B((End))'],
    ['chained edges', 'flowchart TD\n  A((Start)) --> B[Work] --> C((End))'],
    ['labeled edges', 'flowchart LR\n  A((Start)) -->|approved| B((End))'],
    ['dotted edges', 'graph TD\n  A((Start)) -.-> B((End))'],
    ['cyclic edges', 'flowchart TD\n  A[Work] --> B[Retry]\n  B --> A'],
    [
      'subgraphs',
      'flowchart TD\n  subgraph team[Team]\n    A((Start)) --> B((End))\n  end'
    ]
  ])('accepts supported %s', (_name, source) => {
    const result = parser.parse(source);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.length).toBeGreaterThan(0);
  });

  it.each([
    {
      name: 'header',
      source: 'flowchart DOWN\nA --> B',
      code: 'MALFORMED_HEADER',
      line: 1,
      column: 11
    },
    {
      name: 'node shape',
      source: 'flowchart TD\n  A[Missing close',
      code: 'MALFORMED_NODE',
      line: 2,
      column: 4
    },
    {
      name: 'edge connector',
      source: 'flowchart TD\n  A -> B',
      code: 'MALFORMED_EDGE',
      line: 2,
      column: 5
    },
    {
      name: 'subgraph declaration',
      source: 'flowchart TD\n  subgraph checkout[Missing close',
      code: 'MALFORMED_SUBGRAPH',
      line: 2,
      column: 20
    },
    {
      name: 'unmatched subgraph end',
      source: 'flowchart TD\n  end',
      code: 'UNEXPECTED_SUBGRAPH_END',
      line: 2,
      column: 3
    },
    {
      name: 'unknown structural line',
      source: 'flowchart TD\n  A is not a node definition',
      code: 'UNKNOWN_SYNTAX',
      line: 2,
      column: 5
    },
    {
      name: 'unsupported diagram declaration',
      source: 'sequenceDiagram',
      code: 'UNKNOWN_SYNTAX',
      line: 1,
      column: 1
    }
  ])('classifies a malformed $name as an error with its source location', ({ source, code, line, column }) => {
    const result = parser.parse(source);

    expect(result.ast).toBeUndefined();
    expect(result.errors.map(error => ({
      severity: error.severity,
      code: error.code,
      line: error.line,
      column: error.column,
      source: error.source
    }))).toEqual([{
      severity: 'error',
      code,
      line,
      column,
      source: source.split('\n')[line - 1]
    }]);
    expect(result.errors.every(error => error.line > 0 && error.column > 0)).toBe(true);
  });

  it.each([
    ['missing target', 'flowchart TD\n A -->', 7],
    ['invalid target identifier', 'flowchart TD\n A --> [B]', 8],
    ['trailing target content', 'flowchart TD\n A --> B trailing', 10],
    ['empty label', 'flowchart TD\n A -->|| B', 7],
    ['blank label', 'flowchart TD\n A -->|   | B', 7],
    ['unclosed label', 'flowchart TD\n A -->|yes B', 7]
  ])('reports a malformed edge with a useful column for $name', (_name, source, column) => {
    const result = parser.parse(source);

    expect(result.errors.map(error => ({ code: error.code, line: error.line, column: error.column }))).toEqual([
      { code: 'MALFORMED_EDGE', line: 2, column }
    ]);
  });

  it.each([
    ['style A fill:#fff', 'style'],
    ['classDef highlighted fill:#fff', 'classDef'],
    ['click A callback', 'click'],
    ['%%{init: {"theme": "neutral"}}%%', 'initialization']
  ])('classifies unsupported directive %p as a warning', (directive, name) => {
    const result = parser.parse(`flowchart TD\n  A((Start)) --> B((End))\n  ${directive}`);

    expect(result.errors).toEqual([]);
    expect(result.ast).toBeDefined();
    expect(result.warnings).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'UNSUPPORTED_DIRECTIVE',
        line: 3,
        column: 3,
        source: `  ${directive}`,
        message: expect.stringContaining(name)
      })
    ]);
  });

  it('keeps inline CSS class annotations as warning-only syntax', () => {
    const result = parser.parse('flowchart TD\n  A((Start)):::highlighted --> B((End))');

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_DIRECTIVE',
        line: 2,
        column: 13,
        message: 'Unsupported Mermaid CSS class "highlighted"; ignored'
      })
    ]);
  });

  it('parses a class annotation immediately followed by an edge', () => {
    const result = parser.parse('flowchart TD\n  A((Start)):::highlighted-->B((End))');

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges).toHaveLength(1);
    expect(result.warnings.map(warning => warning.code)).toEqual(['UNSUPPORTED_DIRECTIVE']);
  });

  it.each([
    ['labeled', 'A((Start)) -->|approved| B((End))', 'labeled', 'approved'],
    ['dotted', 'A((Start)) -.->|retry| B((End))', 'dotted', 'retry']
  ])('preserves valid %s connector semantics', (_name, edgeSource, type, label) => {
    const result = parser.parse(`flowchart TD\n  ${edgeSource}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges).toEqual([
      expect.objectContaining({ source: 'A', target: 'B', type, label })
    ]);
  });

  it('warns when dotted edge styling is dropped during BPMN conversion', () => {
    const result = parser.parse('flowchart TD\n  A((Start)) -.-> B((End))');

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_EDGE_STYLE',
        line: 2,
        column: 14,
        message: 'Dotted Mermaid edge A_to_B is converted without dotted styling'
      })
    ]);
  });

  it('reports an unclosed subgraph at the opening declaration', () => {
    const result = parser.parse('flowchart TD\n  subgraph team[Team]\n    A((Start)) --> B((End))');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'UNCLOSED_SUBGRAPH',
        line: 2,
        column: 3,
        source: '  subgraph team[Team]'
      })
    ]));
  });

  it('keeps multiple errors ordered by their 1-based source locations', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A[Missing close',
      '  B((Start)) --> C((End))',
      '    D -> E',
      '  F has trailing content'
    ].join('\n'));

    expect(result.errors.map(({ code, line, column }) => ({ code, line, column }))).toEqual([
      { code: 'MALFORMED_NODE', line: 2, column: 4 },
      { code: 'MALFORMED_EDGE', line: 4, column: 7 },
      { code: 'UNKNOWN_SYNTAX', line: 5, column: 5 }
    ]);
  });

  it.each([
    {
      name: 'duplicate subgraph IDs',
      source: 'flowchart TD\n  subgraph team[One]\n    A((Start))\n  end\n  subgraph team[Two]\n    B((End))\n  end',
      code: 'DUPLICATE_SUBGRAPH',
      line: 5,
      column: 3
    },
    {
      name: 'unowned root nodes beside subgraphs',
      source: 'flowchart TD\n  subgraph team[Team]\n    A((Start))\n  end\n  B((End))',
      code: 'MISSING_SUBGRAPH_OWNER',
      line: 5,
      column: 3
    },
    {
      name: 'nodes assigned to multiple subgraphs',
      source: 'flowchart TD\n  subgraph one[One]\n    A((Start))\n  end\n  subgraph two[Two]\n    A --> B((End))\n  end',
      code: 'MULTIPLE_SUBGRAPH_OWNERS',
      line: 5,
      column: 3
    },
    {
      name: 'nested subgraphs',
      source: 'flowchart TD\n  subgraph outer[Outer]\n    subgraph inner[Inner]\n      A((Start)) --> B((End))\n    end\n  end',
      code: 'UNSUPPORTED_NESTED_SUBGRAPH',
      line: 3,
      column: 5
    },
    {
      name: 'data objects used as flow endpoints',
      source: 'flowchart TD\n  A((Start)) --> B[[Record]]',
      code: 'UNSUPPORTED_EDGE_ENDPOINT',
      line: 2,
      column: 14
    }
  ])('rejects converter-incompatible structure: $name', ({ source, code, line, column }) => {
    const result = parser.parse(source);

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code, line, column })
    ]));
    expect(result.errors.every(error => error.line > 0 && error.column > 0)).toBe(true);
  });
});
