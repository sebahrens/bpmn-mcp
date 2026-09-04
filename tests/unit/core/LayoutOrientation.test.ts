import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { MermaidConverter } from '../../../src/converters/MermaidConverter.js';
import { validateBpmnGeometry } from '../../helpers/bpmnGeometry.js';

describe('auto_layout orientation and no-op detection', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-orientation-'));
    engine = new SimpleBpmnEngine(directory);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function buildChain(): Promise<{
    processId: string;
    ids: string[];
  }> {
    const context = await engine.createProcess('Orientation');
    const start = await engine.createElement(context.id, { type: 'bpmn:StartEvent' });
    const first = await engine.createElement(context.id, { type: 'bpmn:Task', name: 'First' });
    const gateway = await engine.createElement(context.id, { type: 'bpmn:ExclusiveGateway' });
    const second = await engine.createElement(context.id, { type: 'bpmn:Task', name: 'Second' });
    const end = await engine.createElement(context.id, { type: 'bpmn:EndEvent' });
    await engine.connect(context.id, start.id, first.id);
    await engine.connect(context.id, first.id, gateway.id);
    await engine.connect(context.id, gateway.id, second.id);
    await engine.connect(context.id, second.id, end.id);
    return {
      processId: context.id,
      ids: [start.id, first.id, gateway.id, second.id, end.id]
    };
  }

  it('ranks left to right by default and top to bottom on request', async () => {
    const horizontal = await buildChain();
    await engine.applyAutoLayout(horizontal.processId);
    const across = horizontal.ids.map(
      id => engine.getProcess(horizontal.processId).elements.get(id)!.position
    );
    for (let index = 1; index < across.length; index += 1) {
      expect(across[index].x).toBeGreaterThan(across[index - 1].x);
    }

    const vertical = await buildChain();
    const result = await engine.applyAutoLayout(
      vertical.processId,
      undefined,
      'top-to-bottom'
    );
    expect(result.changed).toBe(true);
    const down = vertical.ids.map(
      id => engine.getProcess(vertical.processId).elements.get(id)!.position
    );
    for (let index = 1; index < down.length; index += 1) {
      expect(down[index].y).toBeGreaterThan(down[index - 1].y);
    }
    // A vertical process advances on one axis only; the ranks must not also
    // drift sideways the way an un-reflected layout would.
    expect(new Set(down.map(point => Math.round(point.x))).size).toBeLessThan(down.length);
  });

  it('keeps a transposed diagram geometrically valid', async () => {
    const { processId } = await buildChain();
    await engine.applyAutoLayout(processId, undefined, 'top-to-bottom');

    const report = await validateBpmnGeometry(await engine.exportXml(processId));
    expect(report.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
  });

  it('docks every reflected edge on the border of its endpoints', async () => {
    const { processId } = await buildChain();
    await engine.applyAutoLayout(processId, undefined, 'top-to-bottom');

    const context = engine.getProcess(processId);
    const offBorder: string[] = [];
    for (const connection of context.connections.values()) {
      const endpoints = [
        { element: context.elements.get(connection.source)!, point: connection.waypoints[0] },
        { element: context.elements.get(connection.target)!, point: connection.waypoints.at(-1)! }
      ];
      for (const { element, point } of endpoints) {
        const left = element.position.x;
        const right = left + element.size.width;
        const top = element.position.y;
        const bottom = top + element.size.height;
        const onVerticalBorder = (point.x === left || point.x === right)
          && point.y >= top && point.y <= bottom;
        const onHorizontalBorder = (point.y === top || point.y === bottom)
          && point.x >= left && point.x <= right;
        if (!onVerticalBorder && !onHorizontalBorder) {
          offBorder.push(`${connection.id} at ${point.x},${point.y} vs ${element.id}`);
        }
      }
    }
    expect(offBorder).toEqual([]);
  });

  it('turns a laid-out pool into a vertical band', async () => {
    const collaboration = await engine.createProcess('Vertical pools', 'collaboration');
    const pool = await engine.createElement(collaboration.id, {
      type: 'bpmn:Participant',
      name: 'Buyer'
    });
    await engine.createElement(collaboration.id, {
      type: 'bpmn:StartEvent',
      ownerId: pool.processRef,
      scopeId: pool.processRef
    });

    await engine.applyAutoLayout(collaboration.id, undefined, 'top-to-bottom');

    const context = engine.getProcess(collaboration.id);
    const shape = Array.from(context.document.diagram.shapes.values())
      .find(item => item.elementId === pool.id);
    expect(shape?.isHorizontal).toBe(false);
    expect(shape!.bounds.height).toBeGreaterThan(shape!.bounds.width);
  });

  it('does not commit or bump the revision when the layout changes nothing', async () => {
    const { processId } = await buildChain();
    const first = await engine.applyAutoLayout(processId);
    expect(first.changed).toBe(true);

    const context = engine.getProcess(processId);
    const revision = context.revision;
    const xml = await engine.exportXml(processId);

    const second = await engine.applyAutoLayout(processId);
    expect(second.changed).toBe(false);
    expect(engine.getProcess(processId).revision).toBe(revision);
    expect(await engine.exportXml(processId)).toBe(xml);
  });

  it('re-lays a diagram out when the direction changes', async () => {
    const { processId } = await buildChain();
    await engine.applyAutoLayout(processId);
    const revision = engine.getProcess(processId).revision;

    const flipped = await engine.applyAutoLayout(processId, undefined, 'top-to-bottom');
    expect(flipped.changed).toBe(true);
    expect(engine.getProcess(processId).revision).not.toBe(revision);
  });

  it('lays a Mermaid TD diagram out downward and reports a reversed direction', async () => {
    const converter = new MermaidConverter();
    const vertical = await converter.convert(
      'flowchart TD\n  A[Start] --> B[Work]\n  B --> C[Done]'
    );
    const positions = vertical.elements.map(element => ({ x: element.x, y: element.y }));
    expect(Math.max(...positions.map(point => point.y))
      - Math.min(...positions.map(point => point.y)))
      .toBeGreaterThan(
        Math.max(...positions.map(point => point.x))
        - Math.min(...positions.map(point => point.x))
      );

    const reversed = await converter.convert(
      'flowchart BT\n  A[Start] --> B[Work]\n  B --> C[Done]'
    );
    expect(reversed.warnings.some(warning => warning.includes('read back to front')))
      .toBe(true);
  }, 30_000);
});
