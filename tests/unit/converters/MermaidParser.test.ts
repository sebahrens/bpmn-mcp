import { MermaidParser } from '../../../src/converters/MermaidParser.js';
import type { NodeSubtype, NodeType } from '../../../src/converters/ASTTypes.js';

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

// The occurrence suffix is joined with `-`, not `_`: a `_`-joined suffix made
// the second `A --> B` edge collide with a first `A --> B_2` edge and the
// parser rejected the diagram (mcp-bpmn-j21.9). See
// MermaidParser.edge-ids.test.ts for the collision cases themselves.
describe('MermaidParser parallel edge IDs', () => {
  const parser = new MermaidParser();

  it.each([
    [
      'unlabeled edges',
      ['A((Start)) --> B((End))', 'A --> B'],
      ['A_to_B', 'A_to_B-2']
    ],
    [
      'labeled edges',
      ['A((Start)) -->|approved| B((End))', 'A -->|rejected| B'],
      ['A_to_B', 'A_to_B-2']
    ],
    [
      'dotted edges',
      ['A((Start)) -.-> B((End))', 'A -.-> B'],
      ['A_to_B', 'A_to_B-2']
    ],
    [
      'mixed edge styles',
      ['A((Start)) --> B((End))', 'A -->|approved| B', 'A -.->|retry| B'],
      ['A_to_B', 'A_to_B-2', 'A_to_B-3']
    ],
    [
      'identical duplicate edges',
      ['A((Start)) -->|same| B((End))', 'A -->|same| B'],
      ['A_to_B', 'A_to_B-2']
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

    expect(firstIds).toEqual(['A_to_B', 'A_to_B-2', 'A_to_B-3']);
    expect(secondIds).toEqual(firstIds);
  });
});

describe('MermaidParser implicit node upgrades', () => {
  const parser = new MermaidParser();

  it.each([
    ['process', 'A[Review order]', 'process', 'Review order'],
    ['decision', 'A{Approved?}', 'decision', 'Approved?'],
    ['subprocess', 'A[/Manual review/]', 'subprocess', 'Manual review'],
    ['terminator', 'A((Wait for signal))', 'terminator', 'Wait for signal']
  ] as Array<[string, string, NodeType, string]>) (
    'upgrades an implicit endpoint with a later explicit %s declaration',
    (_shape, definition, expectedType, expectedLabel) => {
      const result = parser.parse([
        'flowchart TD',
        '  S((Start)) --> A',
        '  A --> E((End))',
        `  ${definition}`
      ].join('\n'));

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes).toHaveLength(3);
      expect(result.ast?.nodes.find(node => node.id === 'A')).toMatchObject({
        id: 'A',
        type: expectedType,
        label: expectedLabel
      });
      expect(result.warnings.map(warning => warning.code)).not.toContain('DUPLICATE_NODE');
    }
  );

  it('uses the upgraded declaration location for later node diagnostics', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A --> E((End))',
      '    A[Review order]'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.warnings.filter(warning => warning.code === 'DISCONNECTED_NODE')).toEqual([
      expect.objectContaining({
        code: 'DISCONNECTED_NODE',
        line: 3,
        column: 5,
        source: '    A[Review order]',
        message: 'Node "A" has no incoming connections'
      })
    ]);
  });

  it('keeps a later explicit class annotation with the upgraded declaration semantics', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A --> E((End))',
      '  A[Review order]:::highlighted'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.find(node => node.id === 'A')).toMatchObject({
      type: 'process',
      label: 'Review order'
    });
    expect(result.warnings.filter(warning => [
      'DISCONNECTED_NODE',
      'UNSUPPORTED_DIRECTIVE'
    ].includes(warning.code))).toEqual([
      expect.objectContaining({
        code: 'DISCONNECTED_NODE',
        line: 3,
        column: 3
      }),
      expect.objectContaining({
        code: 'UNSUPPORTED_DIRECTIVE',
        line: 3,
        column: 18,
        message: 'Unsupported Mermaid CSS class "highlighted"; ignored'
      })
    ]);
  });

  it('treats a class-only edge endpoint as the first explicit definition before rejecting a later shape', () => {
    const result = parser.parse([
      'flowchart TD',
      '  S((Start)) --> A:::highlighted',
      '  A[Later label]'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.filter(node => node.id === 'A')).toEqual([
      expect.objectContaining({ id: 'A', type: 'process', label: 'A' })
    ]);
    expect(result.warnings.filter(warning => warning.code === 'UNSUPPORTED_DIRECTIVE')).toEqual([
      expect.objectContaining({
        line: 2,
        column: 19,
        source: '  S((Start)) --> A:::highlighted',
        message: 'Unsupported Mermaid CSS class "highlighted"; ignored'
      })
    ]);
    expect(result.warnings.filter(warning => warning.code === 'DUPLICATE_NODE')).toEqual([
      expect.objectContaining({
        line: 3,
        column: 3,
        source: '  A[Later label]',
        message: 'Duplicate node definition: A'
      })
    ]);
  });

  it('preserves edge and subgraph references while upgrading in place', () => {
    const result = parser.parse([
      'flowchart TD',
      '  subgraph team[Team]',
      '    S((Start)) --> A',
      '    A[Review order]',
      '    A --> E((End))',
      '  end'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.filter(node => node.id === 'A')).toEqual([
      expect.objectContaining({ type: 'process', label: 'Review order' })
    ]);
    expect(result.ast?.edges).toEqual([
      expect.objectContaining({ source: 'S', target: 'A' }),
      expect.objectContaining({ source: 'A', target: 'E' })
    ]);
    expect(result.ast?.subgraphs[0].nodes).toEqual(['S', 'A', 'E']);
  });

  it('treats shaped edge endpoints as explicit and keeps the first explicit definition', () => {
    const result = parser.parse([
      'flowchart TD',
      '  S((Start)) --> A[First label]',
      '  A{Second label} --> E((End))'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toHaveLength(3);
    expect(result.ast?.nodes.find(node => node.id === 'A')).toMatchObject({
      type: 'process',
      label: 'First label'
    });
    expect(result.warnings.filter(warning => warning.code === 'DUPLICATE_NODE')).toEqual([
      expect.objectContaining({
        line: 3,
        column: 3,
        source: '  A{Second label} --> E((End))',
        message: 'Duplicate node definition: A'
      })
    ]);
  });

  it('emits one deterministic warning for a genuine repeated explicit declaration', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A --> E((End))',
      '  A[First label]',
      '    A{Second label}'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toHaveLength(2);
    expect(result.ast?.nodes.find(node => node.id === 'A')).toMatchObject({
      type: 'process',
      label: 'First label'
    });
    expect(result.warnings.filter(warning => warning.code === 'DUPLICATE_NODE')).toEqual([
      expect.objectContaining({ line: 4, column: 5, message: 'Duplicate node definition: A' })
    ]);
  });

  it('upgrades an implicit endpoint to data semantics before endpoint validation', () => {
    const result = parser.parse([
      'flowchart TD',
      '  S((Start)) --> A',
      '  A[[Customer record]]'
    ].join('\n'));

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_EDGE_ENDPOINT',
        line: 2,
        column: 14,
        message: 'Edge S_to_A cannot connect a BPMN flow to a data object'
      })
    ]);
    expect(result.warnings.map(warning => warning.code)).not.toContain('DUPLICATE_NODE');
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

describe('MermaidParser semicolon statement terminators', () => {
  const parser = new MermaidParser();

  it('accepts a semicolon-terminated header and statements', () => {
    const result = parser.parse('graph TD;\n  A((Start)) --> B[Work];\n  B --> C((End));');

    expect(result.errors).toEqual([]);
    expect(result.ast?.direction).toBe('TD');
    expect(result.ast?.nodes.map(node => node.id)).toEqual(['A', 'B', 'C']);
    expect(result.ast?.edges.map(edge => edge.id)).toEqual(['A_to_B', 'B_to_C']);
  });

  it('parses several statements sharing one physical line', () => {
    const result = parser.parse('graph LR; A((Start)) --> B[Work]; B --> C((End));');

    expect(result.errors).toEqual([]);
    expect(result.ast?.direction).toBe('LR');
    expect(result.ast?.nodes.map(node => node.type)).toEqual(['start', 'process', 'end']);
    expect(result.ast?.edges).toHaveLength(2);
  });

  it('reports a diagnostic at the author column of a later statement on the same line', () => {
    const result = parser.parse('flowchart TD; A --> B; C -> D');

    expect(result.ast).toBeUndefined();
    expect(result.errors.map(({ code, line, column }) => ({ code, line, column }))).toEqual([
      { code: 'MALFORMED_EDGE', line: 1, column: 26 }
    ]);
    expect(result.errors[0].source).toBe('flowchart TD; A --> B; C -> D');
  });

  it('keeps semicolons that belong to shapes, quotes, edge labels, and HTML entities', () => {
    const result = parser.parse([
      'flowchart TD;',
      '  A["Pause; resume"] --> B[Ship &amp;#59; invoice];',
      '  B -->|approved; audited| C{Ready; set?};'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toEqual([
      // The quotes are Mermaid delimiters, not part of the author's name.
      { id: 'A', type: 'process', label: 'Pause; resume' },
      { id: 'B', type: 'process', label: 'Ship &amp;#59; invoice' },
      { id: 'C', type: 'decision', label: 'Ready; set?' }
    ]);
    expect(result.ast?.edges.map(edge => edge.label)).toEqual([undefined, 'approved; audited']);
  });

  it('accepts semicolons on subgraph declarations and terminators', () => {
    const result = parser.parse([
      'graph LR;',
      '  subgraph buyer[Buyer];',
      '    S((Start)) --> T[Send order];',
      '  end;',
      '  subgraph seller[Seller];',
      '    U[Receive order] --> E((End));',
      '  end;',
      '  T --> U;'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.subgraphs.map(subgraph => subgraph.id)).toEqual(['buyer', 'seller']);
    expect(result.ast?.subgraphs.map(subgraph => subgraph.nodes)).toEqual([['S', 'T'], ['U', 'E']]);
  });

  it('keeps semicolons inside comments out of statement splitting', () => {
    const result = parser.parse([
      'flowchart TD;',
      '  %% ship; then invoice',
      '  A((Start)) --> B((End)); %% done; finally'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.map(node => node.id)).toEqual(['A', 'B']);
    expect(result.ast?.edges.map(edge => edge.id)).toEqual(['A_to_B']);
  });
});

describe('MermaidParser cross-subgraph edge endpoints', () => {
  const parser = new MermaidParser();
  const diagram = (rootEdge: string): string => [
    'flowchart TD',
    'subgraph a[A]',
    '  S((Start)) --> T[Task] --> G{Which?}',
    'end',
    'subgraph b[B]',
    '  U[Work] --> E((End))',
    'end',
    rootEdge
  ].join('\n');

  it.each([
    [
      'a gateway source',
      'G --> U',
      'Edge G_to_U cannot cross subgraphs "a" and "b" because Mermaid node G is a gateway'
    ],
    [
      'a gateway target',
      'U --> G',
      'Edge U_to_G cannot cross subgraphs "b" and "a" because Mermaid node G is a gateway'
    ],
    [
      'a start-event source',
      'S --> U',
      'Edge S_to_U cannot cross subgraphs "a" and "b" because Mermaid node S is a start event'
    ],
    [
      'an end-event target',
      'T --> E',
      'Edge T_to_E cannot cross subgraphs "a" and "b" because Mermaid node E is an end event'
    ]
  ])('rejects %s with the author Mermaid ids and a source location', (_name, rootEdge, message) => {
    const result = parser.parse(diagram(rootEdge));
    const endpointErrors = result.errors.filter(error => error.code === 'UNSUPPORTED_EDGE_ENDPOINT');

    expect(result.ast).toBeUndefined();
    expect(endpointErrors).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'UNSUPPORTED_EDGE_ENDPOINT',
        line: 8,
        column: 3,
        source: rootEdge,
        message: expect.stringContaining(message)
      })
    ]);
    expect(endpointErrors[0].message).not.toMatch(/Gateway_|StartEvent_|EndEvent_|Task_|MessageFlow_/);
  });

  it.each([
    ['task to task', 'T --> U'],
    ['end event as the message source', 'E --> T'],
    ['start event as the message target', 'U --> S']
  ])('keeps a BPMN-valid cross-subgraph edge with %s', (_name, rootEdge) => {
    const result = parser.parse(diagram(rootEdge));

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.some(edge => edge.id === rootEdge.replace(' --> ', '_to_'))).toBe(true);
  });

  it('leaves gateway and event edges inside a single subgraph untouched', () => {
    const result = parser.parse([
      'flowchart TD',
      'subgraph a[A]',
      '  S((Start)) --> T[Task] --> G{Which?}',
      '  G --> E((End))',
      'end'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.map(edge => edge.id)).toEqual(['S_to_T', 'T_to_G', 'G_to_E']);
  });
});

describe('MermaidParser quoted labels (mcp-bpmn-j21.4)', () => {
  const parser = new MermaidParser();

  it.each([
    ['parentheses', 'B["Review (draft)"]', 'Review (draft)'],
    ['a closing bracket', 'B["Check [urgent]"]', 'Check [urgent]'],
    ['an arrow', 'B["Ship --> invoice"]', 'Ship --> invoice'],
    ['a pipe', 'B["Ship | invoice"]', 'Ship | invoice'],
    ['an ampersand', 'B["Ship & invoice"]', 'Ship & invoice'],
    ['surrounding whitespace', 'B[ "Review draft" ]', 'Review draft'],
    ['markdown emphasis', 'B["`**Review** draft`"]', '**Review** draft']
  ])('drops the delimiting quotes and keeps %s', (_name, definition, expectedLabel) => {
    const result = parser.parse(`flowchart TD\n  ${definition}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes[0]).toEqual({ id: 'B', type: 'process', label: expectedLabel });
  });

  it.each([
    ['decision', 'B{"Ready? }"}', 'decision', 'Ready? }'],
    ['subprocess', 'B[/"Manual / review"/]', 'subprocess', 'Manual / review'],
    ['terminator', 'B(("Done )"))', 'end', 'Done )']
  ] as Array<[string, string, NodeType, string]>)(
    'keeps a %s delimiter that lives inside the quoted label',
    (_name, definition, expectedType, expectedLabel) => {
      const result = parser.parse(`flowchart TD\n  A((Start)) --> ${definition}`);

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes.find(node => node.id === 'B')).toEqual({
        id: 'B',
        type: expectedType,
        label: expectedLabel
      });
    }
  );

  it('keeps a data delimiter that lives inside the quoted label', () => {
    const result = parser.parse('flowchart TD\n  B[["Record ]"]]');

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toEqual([{ id: 'B', type: 'data', label: 'Record ]' }]);
  });

  it('decodes Mermaid entity codes inside a quoted label only', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A["Cost #quot;net#quot; #35;1"] --> B[Cost #quot;net#quot;]'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.map(node => node.label)).toEqual([
      'Cost "net" #1',
      'Cost #quot;net#quot;'
    ]);
  });

  it('keeps an unclosed unquoted shape a malformed node', () => {
    const result = parser.parse('flowchart TD\n  B[Check [urgent');

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'MALFORMED_NODE', line: 2, column: 4 })
    ]);
  });

  it('strips the quotes from a quoted subgraph title', () => {
    const result = parser.parse([
      'flowchart TD',
      '  subgraph cust ["Customer Side"]',
      '    A((Start)) --> B((End))',
      '  end'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.subgraphs).toEqual([
      { id: 'cust', title: 'Customer Side', nodes: ['A', 'B'] }
    ]);
  });
});

describe('MermaidParser unsupported node shapes (mcp-bpmn-j21.5)', () => {
  const parser = new MermaidParser();

  it.each([
    ['database', 'B[(DB)]', 'database (cylinder)', 'ID[[Label]] for a data object'],
    ['trapezoid', 'B[/Manual\\]', 'trapezoid', 'ID[Label] for a task'],
    ['alternate trapezoid', 'B[\\Para/]', 'alternate trapezoid', 'ID[Label] for a task'],
    ['alternate parallelogram', 'B[\\Para\\]', 'alternate parallelogram', 'ID[/Label/] for a subprocess'],
    ['rounded rectangle', 'B(Do work)', 'rounded rectangle', 'ID[Label] for a task'],
    ['stadium', 'B([Do work])', 'stadium', 'ID[Label] for a task'],
    ['double circle', 'B(((Done)))', 'double circle', 'ID((Label)) for an event'],
    ['hexagon', 'B{{Prep}}', 'hexagon', 'ID{Label} for an exclusive gateway'],
    ['asymmetric', 'B>Notify]', 'asymmetric', 'ID[Label] for a task']
  ])('rejects the %s shape instead of approximating it as a task', (
    _name,
    definition,
    shapeName,
    alternative
  ) => {
    const result = parser.parse(`flowchart TD\n  A((Start)) --> ${definition}`);

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'UNSUPPORTED_SHAPE',
        line: 2,
        column: 19,
        message: expect.stringContaining(shapeName)
      })
    ]);
    expect(result.errors[0].message).toContain('is valid Mermaid but is not part of the supported BPMN subset');
    expect(result.errors[0].message).toContain(alternative);
  });

  it.each([
    ['data', 'B[[Record]]', 'data', 'Record'],
    ['subprocess', 'B[/Manual review/]', 'subprocess', 'Manual review'],
    ['process', 'B[Review]', 'process', 'Review'],
    ['decision', 'B{Ready?}', 'decision', 'Ready?'],
    ['terminator', 'B((Waiting))', 'terminator', 'Waiting']
  ] as Array<[string, string, NodeType, string]>)(
    'still accepts the supported %s shape beside them',
    (_name, definition, expectedType, expectedLabel) => {
      const result = parser.parse(`flowchart TD\n  ${definition}`);

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes[0]).toEqual({ id: 'B', type: expectedType, label: expectedLabel });
    }
  );

  it('names Mermaid 11 typed-shape syntax instead of reporting unexpected content', () => {
    const result = parser.parse('flowchart TD\n  A((Start)) --> B@{ shape: cyl, label: "DB" }');

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_SHAPE',
        line: 2,
        column: 19,
        message: expect.stringContaining('is valid Mermaid but is not part of the supported BPMN subset')
      })
    ]);
  });

  it('treats an unsupported delimiter inside a quoted label as text', () => {
    const result = parser.parse('flowchart TD\n  B["Load (DB) {{now}}"]');

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes[0].label).toBe('Load (DB) {{now}}');
  });
});

describe('MermaidParser edge connectors (mcp-bpmn-j21.6)', () => {
  const parser = new MermaidParser();

  it.each([
    ['arrow', 'A --> B', 'directed', undefined, []],
    ['long arrow', 'A ---> B', 'directed', undefined, []],
    ['open link', 'A --- B', 'directed', undefined, ['Undirected']],
    ['thick arrow', 'A ==> B', 'directed', undefined, ['Thick']],
    ['thick open link', 'A === B', 'directed', undefined, ['Thick', 'Undirected']],
    ['dotted arrow', 'A -.-> B', 'dotted', undefined, ['Dotted']],
    ['dotted open link', 'A -.- B', 'dotted', undefined, ['Undirected', 'Dotted']],
    ['inline label', 'A -- yes --> B', 'labeled', 'yes', []],
    ['inline label without a space', 'A--yes-->B', 'labeled', 'yes', []],
    ['inline label on an open link', 'A -- yes --- B', 'labeled', 'yes', ['Undirected']],
    ['inline dotted label', 'B-. retry .->A', 'dotted', 'retry', ['Dotted']],
    ['inline thick label', 'A == ship ==> B', 'labeled', 'ship', ['Thick']],
    ['pipe label', 'A -->|yes| B', 'labeled', 'yes', []]
  ] as Array<[string, string, string, string | undefined, string[]]>)(
    'accepts the %s form',
    (_name, edge, expectedType, expectedLabel, droppedStyles) => {
      const result = parser.parse(`flowchart TD\n  ${edge}`);

      expect(result.errors).toEqual([]);
      expect(result.ast?.edges).toEqual([
        expect.objectContaining({ type: expectedType, label: expectedLabel })
      ]);
      expect(result.warnings
        .filter(warning => warning.code === 'UNSUPPORTED_EDGE_STYLE')
        .map(warning => warning.message.split(' ')[0])).toEqual(droppedStyles);
    }
  );

  it.each([
    ['a hyphen', 'A -- send e-mail --> B', 'send e-mail'],
    ['a greater-than sign', 'A -- total > 100 --> B', 'total > 100'],
    ['an ampersand', 'A -- ship & invoice --> B', 'ship & invoice'],
    ['an arrow-like run before a later arrow', 'A -- a-b > c --> B', 'a-b > c']
  ])('keeps an inline edge label containing %s', (_name, edge, expectedLabel) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges).toEqual([
      expect.objectContaining({ source: 'A', target: 'B', label: expectedLabel })
    ]);
  });

  it('takes the earliest terminator for each link in an inline-labeled chain', () => {
    const result = parser.parse('flowchart TD\n  A -- yes --> B -- no --> C');

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.map(edge => [edge.source, edge.target, edge.label])).toEqual([
      ['A', 'B', 'yes'],
      ['B', 'C', 'no']
    ]);
  });

  it.each([
    ['fan-out targets', 'A --> B & C', [['A', 'B'], ['A', 'C']]],
    ['fan-in sources', 'A & B --> C', [['A', 'C'], ['B', 'C']]],
    ['both sides', 'A & B --> C & D', [['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D']]],
    ['a chained fan-out', 'A --> B & C --> D', [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]],
    ['shaped list members', 'A[Work] --> B[Ship] & C[Bill]', [['A', 'B'], ['A', 'C']]]
  ])('expands the & list for %s', (_name, edge, expectedEdges) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.map(edge => [edge.source, edge.target])).toEqual(expectedEdges);
  });

  it('copies the connector label onto every edge of a fan-out', () => {
    const result = parser.parse('flowchart TD\n  A -- go --> B & C');

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.map(edge => [edge.id, edge.label])).toEqual([
      ['A_to_B', 'go'],
      ['A_to_C', 'go']
    ]);
  });

  it.each([
    ['inside a node shape', 'A[Ship & invoice] --> B', 'A', 'Ship & invoice'],
    ['inside a quoted node shape', 'A["Ship & invoice"] --> B', 'A', 'Ship & invoice']
  ])('treats an ampersand %s as label text, not a fan-out separator', (
    _name,
    edge,
    nodeId,
    expectedLabel
  ) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toHaveLength(2);
    expect(result.ast?.nodes.find(node => node.id === nodeId)?.label).toBe(expectedLabel);
  });

  it.each([
    ['a pipe label', 'A -->|ship & invoice| B'],
    ['an inline label', 'A -- ship & invoice --> B']
  ])('treats an ampersand in %s as label text', (_name, edge) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.map(node => node.id)).toEqual(['A', 'B']);
    expect(result.ast?.edges).toEqual([
      expect.objectContaining({ source: 'A', target: 'B', label: 'ship & invoice' })
    ]);
  });

  it.each([
    ['invisible link', 'A ~~~ B', '~~~', 'invisible link'],
    ['bidirectional arrow', 'A <--> B', '<-->', 'one-directional'],
    ['bidirectional thick arrow', 'A <==> B', '<==>', 'one-directional'],
    ['circle arrowhead', 'A --o B', '--o', 'circle and cross arrowheads'],
    ['cross arrowhead', 'A --x B', '--x', 'circle and cross arrowheads']
  ])('rejects the %s as unsupported rather than malformed', (_name, edge, text, alternative) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_CONNECTOR',
        line: 2,
        column: 5,
        message: expect.stringContaining(`"${text}"`)
      })
    ]);
    expect(result.errors[0].message).toContain('is valid Mermaid but is not part of the supported BPMN subset');
    expect(result.errors[0].message).toContain(alternative);
  });

  it('still reports a connector that is not Mermaid at all as malformed', () => {
    const result = parser.parse('flowchart TD\n  A -> B');

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_EDGE',
        line: 2,
        column: 5,
        message: expect.stringContaining('Expected a supported edge connector')
      })
    ]);
  });

  it('rejects an edge that carries both an inline and a pipe label', () => {
    const result = parser.parse('flowchart TD\n  A -- yes -->|no| B');

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_EDGE',
        message: 'Use either "-- text -->" or -->|text| to label an edge, not both'
      })
    ]);
  });

  it('reports a missing endpoint after an ampersand at the ampersand', () => {
    const result = parser.parse('flowchart TD\n  A --> B &');

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_EDGE',
        line: 2,
        column: 11,
        message: 'Expected another Mermaid node identifier after "&"'
      })
    ]);
  });
});

describe('MermaidParser subgraph declarations (mcp-bpmn-j21.7)', () => {
  const parser = new MermaidParser();
  const diagram = (declaration: string): string => [
    'graph LR',
    ` ${declaration}`,
    ' a1[Start] --> a2[Task A]',
    ' end'
  ].join('\n');

  it.each([
    ['an explicit ID and title', 'subgraph A[Alpha]', 'A', 'Alpha'],
    ['an explicit ID and quoted title', 'subgraph A["Alpha team"]', 'A', 'Alpha team'],
    ['a spaced ID and quoted title', 'subgraph cust ["Customer Side"]', 'cust', 'Customer Side'],
    ['a bare single-word title', 'subgraph A', 'A', 'A'],
    ['a quoted title', 'subgraph "Alpha team"', 'Alpha_team', 'Alpha team'],
    ['a bare multi-word title', 'subgraph Alpha team', 'Alpha_team', 'Alpha team']
  ])('accepts %s', (_name, declaration, expectedId, expectedTitle) => {
    const result = parser.parse(diagram(declaration));

    expect(result.errors).toEqual([]);
    expect(result.ast?.subgraphs).toEqual([
      { id: expectedId, title: expectedTitle, nodes: ['a1', 'a2'] }
    ]);
  });

  it('uniquifies IDs derived from repeated titles', () => {
    const result = parser.parse([
      'graph LR',
      '  subgraph "Cust"',
      '    A[Work] --> B[Ship]',
      '  end',
      '  subgraph "Cust"',
      '    C[Bill] --> D[Close]',
      '  end'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.ast?.subgraphs.map(subgraph => [subgraph.id, subgraph.title])).toEqual([
      ['Cust', 'Cust'],
      ['Cust_2', 'Cust']
    ]);
  });

  it('still reports a duplicate explicit subgraph ID', () => {
    const result = parser.parse([
      'graph LR',
      '  subgraph team[One]',
      '    A((Start))',
      '  end',
      '  subgraph team[Two]',
      '    B((End))',
      '  end'
    ].join('\n'));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_SUBGRAPH', line: 5, column: 3 })
    ]));
  });

  it('reports a malformed declaration exactly once, without a cascading end error', () => {
    const result = parser.parse([
      'graph LR',
      '  subgraph a[Missing close',
      '    A[Start] --> B[Task]',
      '  end'
    ].join('\n'));

    expect(result.ast).toBeUndefined();
    expect(result.errors.map(error => ({ code: error.code, line: error.line }))).toEqual([
      { code: 'MALFORMED_SUBGRAPH', line: 2 }
    ]);
  });

  it('still reports an "end" that closes nothing', () => {
    const result = parser.parse('graph LR\n  A[Work]\n  end');

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'UNEXPECTED_SUBGRAPH_END', line: 3, column: 3 })
    ]);
  });
});

describe('MermaidParser implicit parallel splits (mcp-bpmn-j21.8)', () => {
  const parser = new MermaidParser();

  it('warns at the node when a non-gateway fans out to several branches', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A[Check] -->|ok| B[Ship]',
      '  A -->|fail| C[Refund]'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.warnings.filter(warning => warning.code === 'IMPLICIT_PARALLEL_SPLIT')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'IMPLICIT_PARALLEL_SPLIT',
        line: 2,
        column: 3,
        source: '  A[Check] -->|ok| B[Ship]',
        message: expect.stringContaining('parallel (AND) split')
      })
    ]);
    expect(result.warnings.find(warning => warning.code === 'IMPLICIT_PARALLEL_SPLIT')?.message)
      .toContain('A{...}');
  });

  it('keeps the conversion result unchanged beside the diagnostic', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A[Check] -->|ok| B[Ship]',
      '  A -->|fail| C[Refund]'
    ].join('\n'));

    expect(result.ast?.edges.map(edge => [edge.source, edge.target, edge.label])).toEqual([
      ['A', 'B', 'ok'],
      ['A', 'C', 'fail']
    ]);
  });

  it('warns once for an "&" fan-out written on a single line', () => {
    const result = parser.parse('flowchart TD\n  A[Check] --> B[Ship] & C[Refund]');

    expect(result.warnings.filter(warning => warning.code === 'IMPLICIT_PARALLEL_SPLIT')).toEqual([
      expect.objectContaining({ code: 'IMPLICIT_PARALLEL_SPLIT', line: 2, column: 3 })
    ]);
  });

  it.each([
    ['a decision node', 'flowchart TD\n  A{Check} -->|ok| B[Ship]\n  A -->|fail| C[Refund]'],
    ['a single outgoing edge', 'flowchart TD\n  A[Check] --> B[Ship]\n  B --> C[Refund]'],
    ['a join', 'flowchart TD\n  A[One] --> C[Ship]\n  B[Two] --> C']
  ])('does not warn for %s', (_name, source) => {
    const result = parser.parse(source);

    expect(result.warnings.map(warning => warning.code)).not.toContain('IMPLICIT_PARALLEL_SPLIT');
  });

  it('does not count a cross-subgraph message flow as a branch of a split', () => {
    const result = parser.parse([
      'flowchart TD',
      'subgraph a[A]',
      '  S((Start)) --> T[Task] --> E((End))',
      'end',
      'subgraph b[B]',
      '  U[Work] --> F((Done))',
      'end',
      'T --> U'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => warning.code)).not.toContain('IMPLICIT_PARALLEL_SPLIT');
  });
});

describe('MermaidParser diagnostics after a failed line (mcp-bpmn-j21.13)', () => {
  const parser = new MermaidParser();

  const format = (diagnostic: { line: number; column: number; code: string }): string =>
    `${diagnostic.line}:${diagnostic.column} [${diagnostic.code}]`;

  it('reports only the unsupported shape, not the nodes its line took down with it', () => {
    const result = parser.parse([
      'flowchart TD',
      '  subgraph cust ["Customer"]',
      '    A([Start]) --> B[Place order]',
      '  end',
      '  subgraph shop ["Shop"]',
      '    C[Receive] --> D((Done))',
      '  end',
      '  B --> C'
    ].join('\n'));

    // B is declared inside cust on line 3 and has an incoming edge from A. Only
    // A's stadium shape is wrong; the ownership and connectivity analyses used
    // to report B twice at line 8, where nothing is wrong at all.
    expect(result.errors.map(format)).toEqual(['3:6 [UNSUPPORTED_SHAPE]']);
    expect(result.warnings.map(format)).toEqual([]);
    expect(result.ast).toBeUndefined();
  });

  it('withholds start/end, connectivity and split advice while a line is malformed', () => {
    const result = parser.parse('flowchart TD\n  A((Start)) --> B[Missing close');

    expect(result.errors.map(format)).toEqual(['2:19 [MALFORMED_NODE]']);
    expect(result.warnings).toEqual([]);
  });

  it('still reports faults computed from what did parse', () => {
    const result = parser.parse([
      'flowchart TD',
      '  subgraph one[One]',
      '    A((Start)) -.-> B[[Record]]',
      '  end',
      '  C([Broken])'
    ].join('\n'));

    // The dotted-edge style and the data-object endpoint are properties of an
    // edge that parsed, so they survive the suppression; only the whole-graph
    // analyses stand down.
    expect(result.errors.map(format))
      .toEqual(['3:16 [UNSUPPORTED_EDGE_ENDPOINT]', '5:4 [UNSUPPORTED_SHAPE]']);
    expect(result.warnings.map(format)).toEqual(['3:16 [UNSUPPORTED_EDGE_STYLE]']);
  });

  it('runs every analysis once the whole document parses', () => {
    const result = parser.parse([
      'flowchart TD',
      '  subgraph cust ["Customer"]',
      '    A((Start)) --> B[Place order]',
      '  end',
      '  subgraph shop ["Shop"]',
      '    C[Receive] --> D((Done))',
      '  end',
      '  B --> C'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ast?.nodes.map(node => node.type)).toEqual(['start', 'process', 'process', 'end']);
  });
});

describe('MermaidParser BPMN subtype classes (mcp-bpmn-j21.12)', () => {
  const parser = new MermaidParser();

  const subtypeOf = (source: string, nodeId: string): NodeSubtype | undefined =>
    parser.parse(source).ast?.nodes.find(node => node.id === nodeId)?.subtype;

  it.each([
    ['user', 'A[Approve]:::user'],
    ['service', 'A[Charge]:::service'],
    ['script', 'A[Compute]:::script'],
    ['businessRule', 'A[Score]:::businessRule'],
    ['manual', 'A[Pack]:::manual'],
    ['receive', 'A[Await reply]:::receive'],
    ['send', 'A[Notify]:::send']
  ] as Array<[NodeSubtype, string]>)('refines a task as %s', (subtype, node) => {
    expect(subtypeOf(`flowchart TD\n  ${node}`, 'A')).toBe(subtype);
  });

  it.each([
    ['parallel', 'G{Split}:::parallel'],
    ['inclusive', 'G{Some}:::inclusive'],
    ['eventBased', 'G{Race}:::eventBased'],
    ['complex', 'G{Odd}:::complex']
  ] as Array<[NodeSubtype, string]>)('refines a gateway as %s', (subtype, node) => {
    expect(subtypeOf(`flowchart TD\n  ${node}`, 'G')).toBe(subtype);
  });

  it.each([
    ['message', 'flowchart TD\n  E((Order placed)):::message --> T[Work]'],
    ['timer', 'flowchart TD\n  E((Every night)):::timer --> T[Work]'],
    ['signal', 'flowchart TD\n  E((Alarm)):::signal --> T[Work]'],
    ['conditional', 'flowchart TD\n  E((Stock low)):::conditional --> T[Work]'],
    ['error', 'flowchart TD\n  T[Work] --> E((Failed)):::error'],
    ['escalation', 'flowchart TD\n  T[Work] --> E((Escalated)):::escalation'],
    ['cancel', 'flowchart TD\n  T[Work] --> E((Cancelled)):::cancel'],
    ['terminate', 'flowchart TD\n  T[Work] --> E((Halt)):::terminate'],
    ['compensation', 'flowchart TD\n  T[Work] --> E((Undo)):::compensation']
  ] as Array<[NodeSubtype, string]>)('refines an event with the %s definition', (subtype, source) => {
    const result = parser.parse(source);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.find(node => node.id === 'E')?.subtype).toBe(subtype);
  });

  it.each(['businessRule', 'business-rule', 'BUSINESS_RULE', 'businessrule'])(
    'accepts %p as one spelling of the same class',
    name => {
      expect(subtypeOf(`flowchart TD\n  A[Score]:::${name}`, 'A')).toBe('businessRule');
    }
  );

  it.each([
    ['a task', 'flowchart TD\n  A[Work]:::task', 'A'],
    ['a gateway', 'flowchart TD\n  G{Which?}:::exclusive', 'G']
  ])('accepts the class that names the default already carried by %s', (_name, source, nodeId) => {
    const result = parser.parse(source);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.find(node => node.id === nodeId)?.subtype).toBeUndefined();
  });

  it.each([
    [
      'a task subtype on a gateway',
      'flowchart TD\n  G{Which?}:::user',
      'The BPMN subtype class ":::user" cannot refine Mermaid node G, which is a gateway; '
        + 'it applies to a task.'
    ],
    [
      'a gateway subtype on a task',
      'flowchart TD\n  A[Work]:::parallel',
      'The BPMN subtype class ":::parallel" cannot refine Mermaid node A, which is a task; '
        + 'it applies to a gateway.'
    ],
    [
      'a timer on an end event',
      'flowchart TD\n  A[Work] --> E((Done)):::timer',
      'The BPMN subtype class ":::timer" cannot refine Mermaid node E, which is an end event; '
        + 'it applies to a start event or an intermediate event.'
    ],
    [
      'an error on a start event',
      'flowchart TD\n  E((Start)):::error --> A[Work]',
      'The BPMN subtype class ":::error" cannot refine Mermaid node E, which is a start event; '
        + 'it applies to an end event.'
    ],
    [
      'the default class of the wrong shape',
      'flowchart TD\n  A[Work]:::exclusive',
      'The BPMN subtype class ":::exclusive" cannot refine Mermaid node A, which is a task; '
        + 'it applies to a gateway.'
    ]
  ])('rejects %s against the author\'s own Mermaid', (_name, source, message) => {
    const result = parser.parse(source);

    expect(result.errors.map(error => ({ code: error.code, message: error.message }))).toEqual([
      { code: 'INVALID_NODE_SUBTYPE', message }
    ]);
    expect(result.ast).toBeUndefined();
  });

  it('reports the subtype failure at the ":::" itself', () => {
    const result = parser.parse('flowchart TD\n  G{Which?}:::user');

    expect(result.errors.map(error => [error.line, error.column])).toEqual([[2, 12]]);
  });

  it('rejects two different subtype classes on the same node', () => {
    const result = parser.parse('flowchart TD\n  A[Work]:::user --> B[Next]\n  A:::service --> C[Other]');

    expect(result.errors.map(error => ({ code: error.code, message: error.message }))).toEqual([{
      code: 'INVALID_NODE_SUBTYPE',
      message: 'Mermaid node A is already refined as ":::user", so ":::service" conflicts with it; '
        + 'give a node one BPMN subtype class.'
    }]);
  });

  it('accepts the same subtype class repeated on the same node', () => {
    const result = parser.parse('flowchart TD\n  A[Work]:::user --> B[Next]\n  A:::user --> C[Other]');

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes.find(node => node.id === 'A')?.subtype).toBe('user');
  });

  it('still ignores a styling class with a warning, and never refines with it', () => {
    const result = parser.parse('flowchart TD\n  A((Start)):::brand --> B[Work] --> C((End))');

    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => ({
      code: warning.code,
      line: warning.line,
      column: warning.column,
      message: warning.message
    }))).toEqual([{
      code: 'UNSUPPORTED_DIRECTIVE',
      line: 2,
      column: 13,
      message: 'Unsupported Mermaid CSS class "brand"; ignored'
    }]);
    expect(result.ast?.nodes.find(node => node.id === 'A')?.subtype).toBeUndefined();
  });

  it('leaves classDef and class directives ignored with a warning', () => {
    const result = parser.parse([
      'flowchart TD',
      '  A((Start)) --> B[Approve]:::user --> C((End))',
      '  classDef user fill:#eef',
      '  class B user'
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => warning.message)).toEqual([
      'Unsupported Mermaid directive "classDef"; ignored',
      'Unsupported Mermaid directive "class"; ignored'
    ]);
    expect(result.ast?.nodes.find(node => node.id === 'B')?.subtype).toBe('user');
  });
});
