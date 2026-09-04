import { MermaidParser } from '../../../src/converters/MermaidParser.js';

/**
 * Regression cover for mcp-bpmn-j21.9. The occurrence suffix used to be joined
 * with `_`, which is a character node IDs may contain, so the second `A --> B`
 * edge claimed `A_to_B_2` — the same ID a first `A --> B_2` edge would get.
 * The parser then rejected a legal diagram with DUPLICATE_EDGE. The suffix now
 * uses `-`, which `\w+` node IDs cannot contain, so no allocated edge ID can
 * ever equal another edge's base ID.
 */
describe('MermaidParser edge ID allocation', () => {
  const parser = new MermaidParser();

  it('accepts a parallel edge alongside a node whose ID ends in _N', () => {
    const source = [
      'flowchart TD',
      '  A((Start)) --> B((End))',
      '  A --> B',
      '  A --> B_2[Second]'
    ].join('\n');

    const result = parser.parse(source);

    expect(result.errors).toEqual([]);
    expect(result.ast?.edges.map(edge => edge.id)).toEqual(['A_to_B', 'A_to_B-2', 'A_to_B_2']);
  });

  it('never reuses an ID when suffixed and base IDs are interleaved', () => {
    const source = [
      'flowchart TD',
      '  A((Start)) --> B_2[Second]',
      '  A --> B[Plain]',
      '  A --> B',
      '  A --> B_3[Third]',
      '  A --> B_2',
      '  B --> B_2'
    ].join('\n');

    const result = parser.parse(source);
    const ids = result.ast?.edges.map(edge => edge.id) ?? [];

    expect(result.errors).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'A_to_B_2',
      'A_to_B',
      'A_to_B-2',
      'A_to_B_3',
      'A_to_B_2-2',
      'B_to_B_2'
    ]);
  });

  it('keeps every allocated edge ID a valid BPMN NCName', () => {
    const source = [
      'flowchart TD',
      '  A((Start)) --> B((End))',
      '  A --> B',
      '  A --> B'
    ].join('\n');

    const ncName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
    const offenders = (parser.parse(source).ast?.edges ?? [])
      .map(edge => edge.id)
      .filter(id => !ncName.test(id));

    expect(offenders).toEqual([]);
  });
});
