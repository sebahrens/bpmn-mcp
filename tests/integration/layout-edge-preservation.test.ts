import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { validateBpmnGeometry } from '../helpers/bpmnGeometry.js';

jest.setTimeout(60_000);

/**
 * mcp-bpmn-3g8.15: bpmn-auto-layout emits no BPMNEdge for an association
 * anchored on a boundary event, and the engine used to adopt the adapter's
 * plane wholesale. The compensation pattern - the one pattern that needs such
 * an association - therefore lost its link to the handler on the first
 * auto_layout, while an association from a text annotation survived.
 */
describe('auto-layout edge preservation', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-edges-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps the BPMNEdge of an association whose source is a boundary event', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Compensation', 'process');
    await engine.createElement(process.id, { id: 'StartEvent_1', type: 'bpmn:StartEvent' });
    await engine.createElement(process.id, { id: 'Task_4', type: 'bpmn:Task', name: 'Do' });
    await engine.createElement(process.id, { id: 'EndEvent_1', type: 'bpmn:EndEvent' });
    await engine.connect(process.id, 'StartEvent_1', 'Task_4');
    await engine.connect(process.id, 'Task_4', 'EndEvent_1');
    await engine.createElement(process.id, {
      id: 'BoundaryEvent_3',
      type: 'bpmn:BoundaryEvent',
      properties: { attachTo: 'Task_4' }
    });
    await engine.createElement(process.id, { id: 'Task_5', type: 'bpmn:Task', name: 'Undo' });
    await engine.createElement(process.id, {
      id: 'TextAnnotation_1',
      type: 'bpmn:TextAnnotation',
      properties: { text: 'Compensate on cancellation' }
    });
    const boundaryAssociation = await engine.addAssociation(
      process.id,
      'BoundaryEvent_3',
      'Task_5'
    );
    const annotationAssociation = await engine.addAssociation(
      process.id,
      'TextAnnotation_1',
      'Task_4'
    );

    expect(await renderedEdgeTargets(await engine.exportXml(process.id)))
      .toEqual(expect.arrayContaining([boundaryAssociation.id, annotationAssociation.id]));

    const result = await engine.applyAutoLayout(process.id);
    expect(result.changed).toBe(true);

    const xml = await engine.exportXml(process.id);
    // The adapter still reports the association it could not render; the
    // engine is what must no longer lose it.
    const rendered = await renderedEdgeTargets(xml);
    expect(rendered).toEqual(expect.arrayContaining([
      boundaryAssociation.id,
      annotationAssociation.id
    ]));

    const report = await validateBpmnGeometry(xml);
    expect(report.diagnostics).toEqual([]);

    // The restored edge is docked onto the shapes at their laid-out positions,
    // not left on the pre-layout coordinates.
    const shapes = await renderedShapes(xml);
    const waypoints = await renderedWaypoints(xml, boundaryAssociation.id);
    expect(waypoints.length).toBeGreaterThanOrEqual(2);
    expect(onBoundary(waypoints[0], shapes.get('BoundaryEvent_3')!)).toBe(true);
    expect(onBoundary(waypoints[waypoints.length - 1], shapes.get('Task_5')!)).toBe(true);
  });

  it('leaves a second auto-layout of the same diagram unchanged', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Idempotent compensation', 'process');
    await engine.createElement(process.id, { id: 'StartEvent_1', type: 'bpmn:StartEvent' });
    await engine.createElement(process.id, { id: 'Task_1', type: 'bpmn:Task' });
    await engine.connect(process.id, 'StartEvent_1', 'Task_1');
    await engine.createElement(process.id, {
      id: 'BoundaryEvent_1',
      type: 'bpmn:BoundaryEvent',
      properties: { attachTo: 'Task_1' }
    });
    await engine.createElement(process.id, { id: 'Task_2', type: 'bpmn:Task' });
    const association = await engine.addAssociation(process.id, 'BoundaryEvent_1', 'Task_2');

    await engine.applyAutoLayout(process.id);
    const first = await engine.exportXml(process.id);
    await engine.applyAutoLayout(process.id);
    const second = await engine.exportXml(process.id);

    expect(await renderedEdgeTargets(second)).toContain(association.id);
    expect(await renderedWaypoints(second, association.id))
      .toEqual(await renderedWaypoints(first, association.id));
    expect((await validateBpmnGeometry(second)).diagnostics).toEqual([]);
  });
});

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function planeElements(xml: string): Promise<any[]> {
  const definitions = (await new BpmnModdle().fromXML(xml)).rootElement as any;
  return definitions.diagrams[0].plane.planeElement;
}

async function renderedEdgeTargets(xml: string): Promise<string[]> {
  return (await planeElements(xml))
    .filter(item => item.$type === 'bpmndi:BPMNEdge')
    .map(item => item.bpmnElement?.id as string);
}

async function renderedShapes(xml: string): Promise<Map<string, Bounds>> {
  return new Map((await planeElements(xml))
    .filter(item => item.$type === 'bpmndi:BPMNShape')
    .map(item => [item.bpmnElement.id as string, {
      x: item.bounds.x,
      y: item.bounds.y,
      width: item.bounds.width,
      height: item.bounds.height
    }]));
}

async function renderedWaypoints(
  xml: string,
  connectionId: string
): Promise<Array<{ x: number; y: number }>> {
  const edge = (await planeElements(xml)).find(
    item => item.$type === 'bpmndi:BPMNEdge' && item.bpmnElement?.id === connectionId
  );
  return (edge?.waypoint ?? []).map((point: any) => ({ x: point.x, y: point.y }));
}

function onBoundary(point: { x: number; y: number }, bounds: Bounds): boolean {
  const withinX = point.x >= bounds.x - 1 && point.x <= bounds.x + bounds.width + 1;
  const withinY = point.y >= bounds.y - 1 && point.y <= bounds.y + bounds.height + 1;
  const onVerticalEdge = Math.abs(point.x - bounds.x) <= 1
    || Math.abs(point.x - (bounds.x + bounds.width)) <= 1;
  const onHorizontalEdge = Math.abs(point.y - bounds.y) <= 1
    || Math.abs(point.y - (bounds.y + bounds.height)) <= 1;
  return (withinX && withinY) && (onVerticalEdge || onHorizontalEdge);
}
