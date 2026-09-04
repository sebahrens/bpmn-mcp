import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MermaidConverter } from '../../src/converters/MermaidConverter.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { isBpmnId } from '../../src/utils/BpmnId.js';
import { snapshotDefaultDiagramsDirectory } from '../helpers/tempDiagrams.js';
import {
  createSeededRandom,
  generateMermaidDiagram,
  mutateText
} from '../helpers/seededRandom.js';

/**
 * Property/fuzz cover for the BPMN import path and for the IDs the Mermaid
 * pipeline mints (mcp-bpmn-5e7.13).
 *
 * Everything runs against the real entry points - `MermaidConverter.convert`
 * and `SimpleBpmnEngine.importXml`/`exportXml` - inside a per-run temp
 * directory that is removed afterwards, so no fuzz artifact can escape into the
 * repository or the user's diagrams directory. The seed is pinned so a CI
 * failure replays exactly.
 */
const IMPORT_SEED = 0x5e7131;
const VALID_CASES = 25;
const MUTATION_CASES = 120;

interface Offender {
  case: number;
  reason: string;
  detail: string;
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}...` : value;
}

describe('BPMN pipeline properties', () => {
  const converter = new MermaidConverter();
  let directory: string;
  let engine: SimpleBpmnEngine;
  let defaultDiagramsFingerprint: string;

  beforeAll(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-property-'));
    engine = new SimpleBpmnEngine(directory);
    defaultDiagramsFingerprint = await snapshotDefaultDiagramsDirectory();
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('mints only valid BPMN xsd:IDs for seeded Mermaid diagrams', async () => {
    const offenders: Offender[] = [];

    for (let index = 0; index < VALID_CASES; index++) {
      const random = createSeededRandom(IMPORT_SEED + index);
      const { source } = generateMermaidDiagram(random);
      const result = await converter.convert(source, { autoLayout: false });

      const ids = [
        result.processId,
        ...result.elements.map(element => element.id),
        ...result.flows.map(flow => flow.id),
        ...result.pools.map(pool => pool.id)
      ];
      for (const id of ids) {
        if (!isBpmnId(id)) {
          offenders.push({ case: index, reason: `not an NCName: ${id}`, detail: truncate(source) });
        }
      }
      const uniqueIds = new Set(ids);
      if (uniqueIds.size !== ids.length) {
        offenders.push({ case: index, reason: 'duplicate generated IDs', detail: truncate(source) });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('round-trips generated BPMN through import/export idempotently', async () => {
    const offenders: Offender[] = [];

    for (let index = 0; index < VALID_CASES; index++) {
      const random = createSeededRandom(IMPORT_SEED + 1_000 + index);
      const { source } = generateMermaidDiagram(random);
      const { xml } = await converter.convert(source, { autoLayout: false });

      const first = await engine.importXml(xml);
      const firstExport = await engine.exportXml(first.id);
      const second = await engine.importXml(firstExport);
      const secondExport = await engine.exportXml(second.id);

      if (firstExport !== secondExport) {
        offenders.push({
          case: index,
          reason: 'export is not a fixed point of import',
          detail: truncate(source)
        });
      }
      if (second.elements.size !== first.elements.size
        || second.connections.size !== first.connections.size) {
        offenders.push({
          case: index,
          reason: `element/connection counts drifted: `
            + `${first.elements.size}/${first.connections.size} -> `
            + `${second.elements.size}/${second.connections.size}`,
          detail: truncate(source)
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('rejects mutated BPMN with a typed error instead of crashing', async () => {
    const random = createSeededRandom(IMPORT_SEED + 2_000);
    const { xml } = await converter.convert(
      generateMermaidDiagram(createSeededRandom(IMPORT_SEED + 2_001)).source,
      { autoLayout: false }
    );
    const offenders: Offender[] = [];

    for (let index = 0; index < MUTATION_CASES; index++) {
      const mutated = mutateText(random, xml);
      try {
        const context = await engine.importXml(mutated);
        // An accepted document must still be a document: it has to export and
        // survive a second import.
        const exported = await engine.exportXml(context.id);
        await engine.importXml(exported);
      } catch (error) {
        if (!(error instanceof Error)) {
          offenders.push({
            case: index,
            reason: `threw a non-Error value: ${String(error)}`,
            detail: truncate(mutated)
          });
          continue;
        }
        if (typeof error.message !== 'string' || error.message.trim() === '') {
          offenders.push({ case: index, reason: 'empty error message', detail: truncate(mutated) });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps every fuzz artifact inside the temp workspace', async () => {
    // Import persists the accepted document, so the property is containment,
    // not absence: every artifact these cases created is a .bpmn file directly
    // inside the per-run temp directory, and the user's default diagrams
    // directory is byte-for-byte what it was before the suite ran.
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const escaped = entries
      .filter(entry => !entry.isFile() || !entry.name.endsWith('.bpmn'))
      .map(entry => entry.name);

    expect(escaped).toEqual([]);
    expect(await snapshotDefaultDiagramsDirectory()).toBe(defaultDiagramsFingerprint);
  });
});
