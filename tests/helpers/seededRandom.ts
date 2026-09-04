/**
 * Deterministic generators for the property/fuzz suites.
 *
 * These suites must be reproducible: a CI failure has to be replayable on a
 * developer machine from the seed alone, so nothing here reads `Math.random`,
 * the clock, or the environment. Every suite pins its seed as a constant and
 * derives per-case streams from it, which also means a single failing case can
 * be replayed on its own by re-running that case index.
 */
export interface SeededRandom {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, bound). */
  int(bound: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(values: readonly T[]): T;
  /** True with the given probability. */
  chance(probability: number): boolean;
}

/** mulberry32 - small, fast, and stable across Node versions. */
export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => Math.floor(next() * bound);
  return {
    next,
    int,
    pick: values => values[int(values.length)],
    chance: probability => next() < probability
  };
}

const NODE_SHAPES: Array<(id: string, label: string) => string> = [
  (id, label) => `${id}((${label}))`,
  (id, label) => `${id}[${label}]`,
  (id, label) => `${id}{${label}}`,
  (id, label) => `${id}[[${label}]]`,
  (id, label) => `${id}[(${label})]`,
  id => id
];

const CONNECTORS = ['-->', '-.->', '==>', '---', '-->|yes|', '-.->|retry|'];

const LABEL_WORDS = [
  'Review', 'Approve', 'Reject', 'Notify customer', 'Ship', 'Archive',
  'Check stock', 'Escalate', 'Start', 'End', 'Retry'
];

export interface GeneratedDiagram {
  source: string;
  nodeIds: string[];
}

/**
 * A syntactically valid `flowchart` document: node IDs match the parser's
 * `\w+` production and deliberately include IDs ending in `_N` (the shape that
 * used to collide with the edge-ID allocator), edges connect declared nodes,
 * and no subgraphs are emitted because nested subgraphs are an explicitly
 * unsupported construct.
 */
export function generateMermaidDiagram(random: SeededRandom): GeneratedDiagram {
  const direction = random.pick(['TD', 'TB', 'LR', 'RL', 'BT']);
  const nodeCount = 2 + random.int(7);
  const nodeIds = Array.from({ length: nodeCount }, (_, index) => (
    random.chance(0.3) ? `N${index}_${1 + random.int(3)}` : `N${index}`
  ));
  const uniqueIds = Array.from(new Set(nodeIds));
  const lines = [`flowchart ${direction}`];

  for (const [index, id] of uniqueIds.entries()) {
    const shape = NODE_SHAPES[random.int(NODE_SHAPES.length)];
    const label = index === 0 ? 'Start' : random.pick(LABEL_WORDS);
    lines.push(`  ${shape(id, label)}`);
  }

  const edgeCount = 1 + random.int(uniqueIds.length * 2);
  for (let index = 0; index < edgeCount; index++) {
    const source = random.pick(uniqueIds);
    const target = random.pick(uniqueIds);
    if (source === target) continue;
    lines.push(`  ${source} ${random.pick(CONNECTORS)} ${target}`);
  }

  return { source: lines.join('\n'), nodeIds: uniqueIds };
}

const JUNK_ALPHABET: string[] = [
  ...'abcXYZ019_',
  '-->', '-.->', '==>', '&', '|', ':::', ';', '%%',
  ...'()[]{}<>"\'`,.:/\\',
  ' ', '\t', '\n', '\r\n',
  'flowchart', 'graph', 'subgraph', 'end', 'direction',
  'TD', 'LR', 'click', 'style', 'classDef',
  'é', '中', '\u{1f600}', '&#35;', '&amp;'
];

/** Random token soup, biased towards characters the Mermaid grammar cares about. */
export function generateMermaidJunk(random: SeededRandom): string {
  const length = random.int(80);
  let out = random.chance(0.4) ? 'flowchart TD\n' : '';
  for (let index = 0; index < length; index++) {
    out += random.pick(JUNK_ALPHABET);
  }
  return out;
}

/** Character-level mutations of an input that is otherwise well formed. */
export function mutateText(random: SeededRandom, input: string): string {
  if (!input) return input;
  let out = input;
  const mutations = 1 + random.int(4);
  for (let index = 0; index < mutations; index++) {
    const at = random.int(out.length || 1);
    switch (random.int(5)) {
      case 0:
        out = out.slice(0, at) + out.slice(at + 1 + random.int(6));
        break;
      case 1:
        out = out.slice(0, at) + random.pick(JUNK_ALPHABET) + out.slice(at);
        break;
      case 2:
        out = out.slice(0, at) + out.slice(at, at + 8) + out.slice(at);
        break;
      case 3:
        out = out.slice(0, at);
        break;
      default:
        out = out.slice(at);
        break;
    }
  }
  return out;
}
