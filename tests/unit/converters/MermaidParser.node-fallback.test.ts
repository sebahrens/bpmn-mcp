import { MermaidParser } from '../../../src/converters/MermaidParser.js';
import type { EdgeType, NodeType } from '../../../src/converters/ASTTypes.js';

describe('MermaidParser node fallback regression', () => {
  const parser = new MermaidParser();

  it.each([
    ['directed', '-->', 'directed', undefined],
    ['labeled', '-->|continue|', 'labeled', 'continue'],
    ['dotted', '-.->', 'dotted', undefined],
    ['labeled dotted', '-.->|retry|', 'dotted', 'retry']
  ] as Array<[string, string, EdgeType, string | undefined]>)(
    'creates plain-ID endpoints for a %s edge',
    (_name, connector, expectedType, expectedLabel) => {
      const result = parser.parse(`flowchart TD\n  A ${connector} B`);

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes).toEqual([
        { id: 'A', type: 'process', label: 'A' },
        { id: 'B', type: 'process', label: 'B' }
      ]);
      expect(result.ast?.edges).toEqual([{
        id: 'A_to_B',
        source: 'A',
        target: 'B',
        type: expectedType,
        label: expectedLabel
      }]);
    }
  );

  it.each([
    [
      'labeled normal',
      'A((Start)) -->|Yes| B[Review]',
      [
        { id: 'A', type: 'start', label: 'Start' },
        { id: 'B', type: 'process', label: 'Review' }
      ],
      { id: 'A_to_B', source: 'A', target: 'B', type: 'labeled', label: 'Yes' }
    ],
    [
      'labeled dotted',
      'A{Decision} -.->|No| B((End))',
      [
        { id: 'A', type: 'decision', label: 'Decision' },
        { id: 'B', type: 'end', label: 'End' }
      ],
      { id: 'A_to_B', source: 'A', target: 'B', type: 'dotted', label: 'No' }
    ]
  ] as Array<[
    string,
    string,
    Array<{ id: string; type: NodeType; label: string }>,
    { id: string; source: string; target: string; type: EdgeType; label: string }
  ]>)('preserves shaped endpoints for a %s edge', (_name, edge, expectedNodes, expectedEdge) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toEqual(expectedNodes);
    expect(result.ast?.edges).toEqual([expectedEdge]);
  });

  it.each([
    ['process', 'A[Work]', 'process', 'Work'],
    ['decision', 'A{Route}', 'decision', 'Route'],
    ['subprocess', 'A[/Child flow/]', 'subprocess', 'Child flow'],
    ['terminator', 'A((Boundary))', 'start', 'Boundary']
  ] as Array<[string, string, NodeType, string]>)(
    'preserves a shaped %s source through parse()',
    (_name, source, expectedType, expectedLabel) => {
      const result = parser.parse(`flowchart TD\n  ${source} --> Z((Finish))`);

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes.find(node => node.id === 'A')).toEqual({
        id: 'A',
        type: expectedType,
        label: expectedLabel
      });
      expect(result.ast?.edges[0]).toMatchObject({ source: 'A', target: 'Z' });
    }
  );

  it.each([
    ['process', 'B[Work]', 'process', 'Work'],
    ['decision', 'B{Route}', 'decision', 'Route'],
    ['subprocess', 'B[/Child flow/]', 'subprocess', 'Child flow'],
    ['terminator', 'B((Boundary))', 'end', 'Boundary']
  ] as Array<[string, string, NodeType, string]>)(
    'preserves a shaped %s target through parse()',
    (_name, target, expectedType, expectedLabel) => {
      const result = parser.parse(`flowchart TD\n  S((Begin)) --> ${target}`);

      expect(result.errors).toEqual([]);
      expect(result.ast?.nodes.find(node => node.id === 'B')).toEqual({
        id: 'B',
        type: expectedType,
        label: expectedLabel
      });
      expect(result.ast?.edges[0]).toMatchObject({ source: 'S', target: 'B' });
    }
  );

  it('preserves a standalone data shape through parse()', () => {
    const result = parser.parse('flowchart TD\n  D[[Record]]');

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toEqual([{ id: 'D', type: 'data', label: 'Record' }]);
  });

  it.each([
    ['source', 'D[[Record]] --> B((End))', 'D_to_B'],
    ['target', 'A((Start)) --> D[[Record]]', 'A_to_D']
  ])('intentionally rejects a data-shaped %s edge endpoint', (_name, edge, edgeId) => {
    const result = parser.parse(`flowchart TD\n  ${edge}`);

    expect(result.ast).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'UNSUPPORTED_EDGE_ENDPOINT',
        message: `Edge ${edgeId} cannot connect a BPMN flow to a data object`
      })
    ]);
  });

  it.each([
    ['process', 'A[Broken --> B[End]', 'B[Broken'],
    ['decision', 'A{Broken --> B{End}', 'B{Broken'],
    ['subprocess', 'A[/Broken --> B[/End/]', 'B[/Broken'],
    ['data', 'A[[Broken --> B[[End]]', 'B[[Broken'],
    ['terminator', 'A((Broken --> B((End))', 'B((Broken']
  ])('reports malformed %s shapes in either endpoint position', (_name, sourceEdge, target) => {
    const malformedSource = parser.parse(`flowchart TD\n  ${sourceEdge}`);
    const malformedTarget = parser.parse(`flowchart TD\n  A((Start)) --> ${target}`);

    expect(malformedSource.ast).toBeUndefined();
    expect(malformedSource.errors).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_NODE',
        line: 2,
        column: 4,
        message: 'Malformed shape for node "A"'
      })
    ]);
    expect(malformedTarget.ast).toBeUndefined();
    expect(malformedTarget.errors).toEqual([
      expect.objectContaining({
        code: 'MALFORMED_NODE',
        line: 2,
        column: 19,
        message: 'Malformed shape for node "B"'
      })
    ]);
  });

  it('preserves endpoint shapes and connector semantics across a multi-edge chain', () => {
    const result = parser.parse(
      'flowchart TD\n  A((Begin)) --> B[Work] -.->|retry| C{Review} --> D((Finish))'
    );

    expect(result.errors).toEqual([]);
    expect(result.ast?.nodes).toEqual([
      { id: 'A', type: 'start', label: 'Begin' },
      { id: 'B', type: 'process', label: 'Work' },
      { id: 'C', type: 'decision', label: 'Review' },
      { id: 'D', type: 'end', label: 'Finish' }
    ]);
    expect(result.ast?.edges).toEqual([
      { id: 'A_to_B', source: 'A', target: 'B', type: 'directed', label: undefined },
      { id: 'B_to_C', source: 'B', target: 'C', type: 'dotted', label: 'retry' },
      { id: 'C_to_D', source: 'C', target: 'D', type: 'directed', label: undefined }
    ]);
  });
});
