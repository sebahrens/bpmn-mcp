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
 * mcp-bpmn-9sv.16: the layout engine accepts no fixed positions, so anything
 * an agent placed by hand was lost on the next auto_layout. `pinnedElementIds`
 * puts those bounds back after the ranking and repairs the ranked result
 * around them - or fails the call, rather than committing overlapping shapes.
 */
describe('auto-layout pinning', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-pinning-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps a hand-placed annotation while ranking everything else', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Annotated', 'process');
    for (const [id, type] of [
      ['StartEvent_1', 'bpmn:StartEvent'],
      ['Task_1', 'bpmn:Task'],
      ['Task_2', 'bpmn:Task'],
      ['EndEvent_1', 'bpmn:EndEvent']
    ] as const) {
      await engine.createElement(process.id, { id, type });
    }
    await engine.createElement(process.id, {
      id: 'TextAnnotation_1',
      type: 'bpmn:TextAnnotation',
      position: { x: 400, y: 400 },
      properties: { text: 'Reviewed quarterly' }
    });
    for (const [source, target] of [
      ['StartEvent_1', 'Task_1'],
      ['Task_1', 'Task_2'],
      ['Task_2', 'EndEvent_1']
    ] as const) {
      await engine.connect(process.id, source, target);
    }
    await engine.addAssociation(process.id, 'TextAnnotation_1', 'Task_2');
    const placed = (await renderedShapes(await engine.exportXml(process.id)))
      .get('TextAnnotation_1')!;

    await engine.applyAutoLayout(process.id, undefined, 'left-to-right', {
      pinnedElementIds: ['TextAnnotation_1']
    });

    const xml = await engine.exportXml(process.id);
    const shapes = await renderedShapes(xml);
    expect(shapes.get('TextAnnotation_1')).toEqual(placed);
    // Everything not pinned was still ranked.
    expect(shapes.get('Task_2')!.x).toBeGreaterThan(shapes.get('Task_1')!.x);
    expect((await validateBpmnGeometry(xml)).diagnostics).toEqual([]);
  });

  it('repairs the ranked result around a hand-placed task', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Hand placed', 'process');
    for (const [id, type] of [
      ['StartEvent_1', 'bpmn:StartEvent'],
      ['Task_1', 'bpmn:Task'],
      ['Task_2', 'bpmn:Task'],
      ['Task_3', 'bpmn:Task'],
      ['EndEvent_1', 'bpmn:EndEvent']
    ] as const) {
      await engine.createElement(process.id, { id, type });
    }
    for (const [source, target] of [
      ['StartEvent_1', 'Task_1'],
      ['Task_1', 'Task_2'],
      ['Task_2', 'Task_3'],
      ['Task_3', 'EndEvent_1']
    ] as const) {
      await engine.connect(process.id, source, target);
    }
    const placed = { x: 240, y: 420, width: 100, height: 80 };
    await engine.updateElementGeometry(process.id, 'Task_3', {
      bounds: placed,
      incidentConnectionPolicy: 'snap-endpoints'
    });

    await engine.applyAutoLayout(process.id, undefined, 'left-to-right', {
      pinnedElementIds: ['Task_3']
    });

    const xml = await engine.exportXml(process.id);
    const shapes = await renderedShapes(xml);
    expect(shapes.get('Task_3')).toEqual(placed);
    const overlapping = ['StartEvent_1', 'Task_1', 'Task_2', 'EndEvent_1']
      .filter(id => overlaps(shapes.get(id)!, placed));
    expect(overlapping).toEqual([]);

    const report = await validateBpmnGeometry(xml);
    // A pinned element pulls its incoming and outgoing flow onto the same dock,
    // which the oracle reports as a clearance warning; nothing is in error.
    expect(report.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('refuses a pin it cannot express, leaving the diagram alone', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Refused pins', 'process');
    await engine.createElement(process.id, { id: 'StartEvent_1', type: 'bpmn:StartEvent' });
    await engine.createElement(process.id, { id: 'Task_1', type: 'bpmn:Task' });
    await engine.createElement(process.id, {
      id: 'SubProcess_1',
      type: 'bpmn:SubProcess',
      properties: { isExpanded: true }
    });
    await engine.connect(process.id, 'StartEvent_1', 'Task_1');
    const before = await engine.exportXml(process.id);

    await expect(engine.applyAutoLayout(process.id, undefined, 'left-to-right', {
      pinnedElementIds: ['Task_404']
    })).rejects.toThrow(/Task_404 is not in this diagram/u);
    await expect(engine.applyAutoLayout(process.id, undefined, 'left-to-right', {
      pinnedElementIds: ['SubProcess_1']
    })).rejects.toThrow(/is a container/u);
    expect(await engine.exportXml(process.id)).toBe(before);

    const collaboration = await engine.createProcess('Pinned pool', 'collaboration');
    const pool = await engine.createElement(collaboration.id, {
      id: 'Participant_1',
      type: 'bpmn:Participant'
    });
    if (pool.kind !== 'participant' || !pool.processRef) throw new Error('Expected a pool');
    await engine.createElement(collaboration.id, {
      id: 'StartEvent_2',
      type: 'bpmn:StartEvent',
      ownerId: pool.processRef
    });
    await expect(engine.applyAutoLayout(collaboration.id, undefined, 'left-to-right', {
      pinnedElementIds: ['StartEvent_2']
    })).rejects.toThrow(/not supported in a collaboration/u);
  });
});

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

function overlaps(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}
