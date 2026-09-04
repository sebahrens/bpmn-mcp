import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { validateBpmnGeometry } from '../helpers/bpmnGeometry.js';

jest.setTimeout(60_000);

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * mcp-bpmn-9sv.16: bpmn-auto-layout's layoutProcess(xml) takes no options, so
 * the gaps it leaves between ranks are fixed. `spacing` stretches them
 * afterwards through a monotone coordinate map, which is what keeps the
 * stretched plane connected: shapes keep their size, boundary events keep their
 * hosts, and edge endpoints keep their docks.
 */
describe('auto-layout spacing', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-spacing-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('widens the gaps between ranks without resizing shapes or detaching anything', async () => {
    const [tight, loose] = await Promise.all([
      layOutBranchingProcess(directory, 1),
      layOutBranchingProcess(directory, 2)
    ]);

    for (const shapes of [tight, loose]) {
      expect(shapes.get('Task_1')).toMatchObject({ width: 100, height: 80 });
      expect(shapes.get('StartEvent_1')).toMatchObject({ width: 36, height: 36 });
    }
    // Ranks move apart; the shapes themselves do not change size.
    expect(gapBetween(loose, 'StartEvent_1', 'Task_1'))
      .toBeGreaterThan(gapBetween(tight, 'StartEvent_1', 'Task_1'));
    expect(gapBetween(loose, 'Task_1', 'Gateway_1'))
      .toBeGreaterThan(gapBetween(tight, 'Task_1', 'Gateway_1'));
    expect(width(loose)).toBeGreaterThan(width(tight));

    // A boundary event overlaps its host, so both sit in the same occupied
    // band and shift together: the offset between them is untouched.
    for (const shapes of [tight, loose]) {
      const host = shapes.get('Task_1')!;
      const boundary = shapes.get('BoundaryEvent_1')!;
      expect(boundary.x - host.x).toBe(32);
      expect(boundary.y - host.y).toBe(62);
    }
  });

  it('reports no geometry defect at either end of the spacing range', async () => {
    for (const spacing of [0.5, 1, 2.5, 4]) {
      const xml = await exportBranchingProcess(directory, spacing);
      const report = await validateBpmnGeometry(xml);
      expect({ spacing, diagnostics: report.diagnostics })
        .toEqual({ spacing, diagnostics: [] });
    }
  });

  it('grows pools and lane bands around the extra room, leaving the bands tiled', async () => {
    const [tight, loose] = await Promise.all([
      layOutTwoLanePool(directory, 1),
      layOutTwoLanePool(directory, 1.6)
    ]);

    expect(loose.shapes.get('Participant_1')!.width)
      .toBeGreaterThan(tight.shapes.get('Participant_1')!.width);
    expect(loose.shapes.get('Participant_1')!.height)
      .toBeGreaterThan(tight.shapes.get('Participant_1')!.height);

    for (const { shapes, laneIds } of [tight, loose]) {
      const pool = shapes.get('Participant_1')!;
      const bands = laneIds.map(id => shapes.get(id)!);
      // The bands still tile the pool top to bottom, with no seam and no gap.
      expect(bands[0].y).toBe(pool.y);
      expect(bands[0].y + bands[0].height).toBe(bands[1].y);
      expect(bands[1].y + bands[1].height).toBe(pool.y + pool.height);
      const escaped = ['StartEvent_1', 'UserTask_1'].filter(
        id => !contains(bands[0], shapes.get(id)!)
      ).concat(['Task_1', 'EndEvent_1'].filter(id => !contains(bands[1], shapes.get(id)!)));
      expect(escaped).toEqual([]);
    }

    expect((await validateBpmnGeometry(loose.xml)).diagnostics).toEqual([]);
  });

  it('rejects a spacing outside the supported range without touching the diagram', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Rejected spacing', 'process');
    await engine.createElement(process.id, { id: 'StartEvent_1', type: 'bpmn:StartEvent' });
    await engine.createElement(process.id, { id: 'Task_1', type: 'bpmn:Task' });
    await engine.connect(process.id, 'StartEvent_1', 'Task_1');
    const before = await engine.exportXml(process.id);

    for (const spacing of [0, 0.25, 5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        engine.applyAutoLayout(process.id, undefined, 'left-to-right', { spacing })
      ).rejects.toThrow(/spacing must be a number between/u);
    }
    expect(await engine.exportXml(process.id)).toBe(before);
  });
});

async function exportBranchingProcess(directory: string, spacing: number): Promise<string> {
  const engine = new SimpleBpmnEngine(directory);
  const process = await engine.createProcess(`Branching ${spacing}`, 'process');
  for (const [id, type] of [
    ['StartEvent_1', 'bpmn:StartEvent'],
    ['Task_1', 'bpmn:Task'],
    ['Gateway_1', 'bpmn:ExclusiveGateway'],
    ['Task_2', 'bpmn:Task'],
    ['Task_3', 'bpmn:Task'],
    ['EndEvent_1', 'bpmn:EndEvent'],
    ['Task_4', 'bpmn:Task']
  ] as const) {
    await engine.createElement(process.id, { id, type });
  }
  await engine.createElement(process.id, {
    id: 'BoundaryEvent_1',
    type: 'bpmn:BoundaryEvent',
    properties: { attachTo: 'Task_1' }
  });
  for (const [source, target] of [
    ['StartEvent_1', 'Task_1'],
    ['Task_1', 'Gateway_1'],
    ['Gateway_1', 'Task_2'],
    ['Gateway_1', 'Task_3'],
    ['Task_2', 'EndEvent_1'],
    ['Task_3', 'EndEvent_1'],
    ['BoundaryEvent_1', 'Task_4']
  ] as const) {
    await engine.connect(process.id, source, target);
  }
  await engine.applyAutoLayout(process.id, undefined, 'left-to-right', { spacing });
  return engine.exportXml(process.id);
}

async function layOutBranchingProcess(
  directory: string,
  spacing: number
): Promise<Map<string, Bounds>> {
  return renderedShapes(await exportBranchingProcess(directory, spacing));
}

async function layOutTwoLanePool(
  directory: string,
  spacing: number
): Promise<{ shapes: Map<string, Bounds>; laneIds: string[]; xml: string }> {
  const engine = new SimpleBpmnEngine(directory);
  const collaboration = await engine.createProcess(`Lanes ${spacing}`, 'collaboration');
  const pool = await engine.createElement(collaboration.id, {
    id: 'Participant_1',
    type: 'bpmn:Participant',
    name: 'Company'
  });
  if (pool.kind !== 'participant' || !pool.processRef) throw new Error('Expected a white-box pool');
  for (const [id, type] of [
    ['StartEvent_1', 'bpmn:StartEvent'],
    ['UserTask_1', 'bpmn:UserTask'],
    ['Task_1', 'bpmn:Task'],
    ['EndEvent_1', 'bpmn:EndEvent']
  ] as const) {
    await engine.createElement(collaboration.id, { id, type, ownerId: pool.processRef });
  }
  for (const [source, target] of [
    ['StartEvent_1', 'UserTask_1'],
    ['UserTask_1', 'Task_1'],
    ['Task_1', 'EndEvent_1']
  ] as const) {
    await engine.connect(collaboration.id, source, target);
  }
  const upper = await engine.addLane(
    collaboration.id,
    pool.id,
    'Front office',
    ['StartEvent_1', 'UserTask_1'],
    'top'
  );
  const lower = await engine.addLane(
    collaboration.id,
    pool.id,
    'Back office',
    ['Task_1', 'EndEvent_1'],
    'bottom'
  );
  await engine.applyAutoLayout(collaboration.id, undefined, 'left-to-right', { spacing });
  const xml = await engine.exportXml(collaboration.id);
  return { shapes: await renderedShapes(xml), laneIds: [upper.id, lower.id], xml };
}

async function renderedShapes(xml: string): Promise<Map<string, Bounds>> {
  const definitions = (await new BpmnModdle().fromXML(xml)).rootElement as any;
  return new Map(definitions.diagrams[0].plane.planeElement
    .filter((item: any) => item.$type === 'bpmndi:BPMNShape')
    .map((item: any) => [item.bpmnElement.id as string, {
      x: item.bounds.x,
      y: item.bounds.y,
      width: item.bounds.width,
      height: item.bounds.height
    }]));
}

function gapBetween(shapes: Map<string, Bounds>, left: string, right: string): number {
  const first = shapes.get(left)!;
  const second = shapes.get(right)!;
  return second.x - (first.x + first.width);
}

function width(shapes: Map<string, Bounds>): number {
  const values = Array.from(shapes.values());
  return Math.max(...values.map(bounds => bounds.x + bounds.width))
    - Math.min(...values.map(bounds => bounds.x));
}

function contains(container: Bounds, child: Bounds): boolean {
  return child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height;
}
