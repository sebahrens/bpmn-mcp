import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import BpmnModdle from 'bpmn-moddle';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { applyCollaborationLayoutPolicy } from '../../../src/core/layout/CollaborationLayoutPolicy.js';
import { validateBpmnGeometry } from '../../helpers/bpmnGeometry.js';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe('collaboration auto-layout policy', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-collaboration-layout-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('contains independent process and lane layouts while preserving requested pool bounds', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('Fulfilment', 'collaboration');
    const buyer = await engine.createElement(collaboration.id, {
      id: 'Participant_Buyer',
      type: 'bpmn:Participant',
      name: 'Buyer',
      position: { x: 900, y: 700 },
      size: { width: 1_000, height: 360 }
    });
    const seller = await engine.createElement(collaboration.id, {
      id: 'Participant_Seller',
      type: 'bpmn:Participant',
      name: 'Seller',
      position: { x: 20, y: 20 },
      size: { width: 800, height: 420 }
    });
    const carrier = await engine.createElement(collaboration.id, {
      id: 'Participant_Carrier',
      type: 'bpmn:Participant',
      name: 'External carrier',
      position: { x: 300, y: 300 },
      size: { width: 900, height: 180 },
      properties: { blackBox: true }
    });
    if (buyer.kind !== 'participant' || !buyer.processRef
      || seller.kind !== 'participant' || !seller.processRef
      || carrier.kind !== 'participant') {
      throw new Error('Expected collaboration participants');
    }

    for (const definition of [
      { id: 'Buyer_Start', type: 'bpmn:StartEvent' as const, ownerId: buyer.processRef },
      { id: 'Buyer_Send', type: 'bpmn:SendTask' as const, ownerId: buyer.processRef },
      { id: 'Buyer_End', type: 'bpmn:EndEvent' as const, ownerId: buyer.processRef },
      { id: 'Buyer_Disconnected', type: 'bpmn:ManualTask' as const, ownerId: buyer.processRef },
      { id: 'Seller_Start', type: 'bpmn:StartEvent' as const, ownerId: seller.processRef },
      { id: 'Seller_Receive', type: 'bpmn:ReceiveTask' as const, ownerId: seller.processRef },
      { id: 'Seller_End', type: 'bpmn:EndEvent' as const, ownerId: seller.processRef }
    ]) {
      await engine.createElement(collaboration.id, {
        ...definition,
        position: { x: 5, y: 5 }
      });
    }
    await engine.connect(collaboration.id, 'Buyer_Start', 'Buyer_Send');
    await engine.connect(collaboration.id, 'Buyer_Send', 'Buyer_End');
    await engine.connect(collaboration.id, 'Seller_Start', 'Seller_Receive');
    await engine.connect(collaboration.id, 'Seller_Receive', 'Seller_End');
    const message = await engine.connect(collaboration.id, 'Buyer_Send', 'Seller_Receive');
    await engine.addLane(
      collaboration.id,
      seller.id,
      'Intake',
      ['Seller_Start', 'Seller_Receive'],
      'top'
    );
    await engine.addLane(
      collaboration.id,
      seller.id,
      'Completion',
      ['Seller_End'],
      'bottom'
    );

    const requestedLanes = new Map(Array.from(collaboration.document.lanes.values(), lane => [
      lane.id,
      { ...lane.size }
    ]));
    const requested = new Map([
      [buyer.id, { width: 1_000, height: 360 }],
      [seller.id, { width: 800, height: 420 }],
      [carrier.id, { width: 900, height: 180 }]
    ]);
    await engine.applyAutoLayout(collaboration.id);
    const xml = await engine.exportXml(collaboration.id);
    const report = await validateBpmnGeometry(xml);
    expect(report.diagnostics.filter(diagnostic =>
      diagnostic.code !== 'SHAPE_OVERLAP'
      || !diagnostic.ids.some(id => id.startsWith('Participant_'))
    )).toEqual([]);

    const definitions = (await new BpmnModdle().fromXML(xml)).rootElement;
    const shapes = new Map<string, Bounds>(definitions.diagrams[0].plane.planeElement
      .filter((item: any) => item.$type === 'bpmndi:BPMNShape')
      .map((item: any) => [item.bpmnElement.id, plainBounds(item.bounds)]));
    const participants = [buyer.id, seller.id, carrier.id].map(id => shapes.get(id)!);
    participants.forEach((bounds, index) => {
      const constraint = requested.get([buyer.id, seller.id, carrier.id][index])!;
      expect(bounds.width).toBeGreaterThanOrEqual(constraint.width);
      expect(bounds.height).toBeGreaterThanOrEqual(constraint.height);
    });
    for (let left = 0; left < participants.length; left++) {
      for (let right = left + 1; right < participants.length; right++) {
        expect(overlaps(participants[left], participants[right])).toBe(false);
      }
    }

    for (const nodeId of ['Buyer_Start', 'Buyer_Send', 'Buyer_End', 'Buyer_Disconnected']) {
      expect(contains(shapes.get(buyer.id)!, shapes.get(nodeId)!)).toBe(true);
    }
    for (const nodeId of ['Seller_Start', 'Seller_Receive', 'Seller_End']) {
      expect(contains(shapes.get(seller.id)!, shapes.get(nodeId)!)).toBe(true);
    }
    expect(carrier.processRef).toBeUndefined();

    const process = definitions.rootElements.find((root: any) => root.id === seller.processRef);
    const laidOutLanes = process.laneSets[0].lanes;
    for (const lane of laidOutLanes) {
      const laneBounds = shapes.get(lane.id)!;
      const laneConstraint = requestedLanes.get(lane.id)!;
      expect(laneBounds.width).toBeGreaterThanOrEqual(laneConstraint.width);
      expect(laneBounds.height).toBeGreaterThanOrEqual(laneConstraint.height);
      expect(laneBounds.height).toBeGreaterThanOrEqual(60);
      expect(contains(shapes.get(seller.id)!, laneBounds)).toBe(true);
      for (const member of lane.flowNodeRef) {
        expect(contains(laneBounds, shapes.get(member.id)!)).toBe(true);
      }
    }
    expect(overlaps(shapes.get(laidOutLanes[0].id)!, shapes.get(laidOutLanes[1].id)!))
      .toBe(false);

    const edge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === message.id
    );
    expect(edge.waypoint.length).toBeGreaterThanOrEqual(2);
    expect(onBoundary(plainPoint(edge.waypoint[0]), shapes.get('Buyer_Send')!)).toBe(true);
    expect(onBoundary(plainPoint(edge.waypoint.at(-1)), shapes.get('Seller_Receive')!)).toBe(true);
  });

  it('restacks an all-black-box collaboration without fabricating process content', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('External exchange', 'collaboration');
    const first = await engine.createElement(collaboration.id, {
      id: 'Participant_FirstExternal',
      type: 'bpmn:Participant',
      name: 'First external party',
      position: { x: 100, y: 100 },
      size: { width: 700, height: 180 },
      properties: { blackBox: true }
    });
    const second = await engine.createElement(collaboration.id, {
      id: 'Participant_SecondExternal',
      type: 'bpmn:Participant',
      name: 'Second external party',
      position: { x: 120, y: 120 },
      size: { width: 600, height: 160 },
      properties: { blackBox: true }
    });
    const message = await engine.connect(collaboration.id, first.id, second.id);

    await expect(engine.applyAutoLayout(collaboration.id)).resolves.toMatchObject({ warnings: [] });
    const definitions = (await new BpmnModdle().fromXML(
      await engine.exportXml(collaboration.id)
    )).rootElement;
    expect(definitions.rootElements.filter((root: any) => root.$type === 'bpmn:Process'))
      .toHaveLength(0);
    const shapes = new Map<string, Bounds>(definitions.diagrams[0].plane.planeElement
      .filter((item: any) => item.$type === 'bpmndi:BPMNShape')
      .map((item: any) => [item.bpmnElement.id, plainBounds(item.bounds)]));
    expect(shapes.get(first.id)).toMatchObject({ width: 700, height: 180 });
    expect(shapes.get(second.id)).toMatchObject({ width: 600, height: 160 });
    expect(overlaps(shapes.get(first.id)!, shapes.get(second.id)!)).toBe(false);
    const edge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === message.id
    );
    expect(onBoundary(plainPoint(edge.waypoint[0]), shapes.get(first.id)!)).toBe(true);
    expect(onBoundary(plainPoint(edge.waypoint.at(-1)), shapes.get(second.id)!)).toBe(true);
  });

  it('places peer message-flow labels without overlapping each other', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('External exchange', 'collaboration');
    const first = await engine.createElement(collaboration.id, {
      id: 'Participant_FirstExternal',
      type: 'bpmn:Participant',
      name: 'First external party',
      properties: { blackBox: true }
    });
    const second = await engine.createElement(collaboration.id, {
      id: 'Participant_SecondExternal',
      type: 'bpmn:Participant',
      name: 'Second external party',
      properties: { blackBox: true }
    });
    const messages = await Promise.all([
      engine.connect(collaboration.id, first.id, second.id, 'Order accepted'),
      engine.connect(collaboration.id, first.id, second.id, 'Order rejected'),
      engine.connect(collaboration.id, first.id, second.id, 'Order delayed'),
      engine.connect(collaboration.id, first.id, second.id, 'Order cancelled')
    ]);

    for (const message of messages) {
      const edge = Array.from(collaboration.document.diagram.edges.values())
        .find(candidate => candidate.connectionId === message.id);
      if (!edge) throw new Error(`Expected DI edge for ${message.id}`);
      edge.labelBounds = { x: 0, y: 0, width: 100, height: 20 };
    }

    await engine.applyAutoLayout(collaboration.id);

    const labelBounds = messages.map(message => {
      const edge = Array.from(collaboration.document.diagram.edges.values())
        .find(candidate => candidate.connectionId === message.id);
      if (!edge?.labelBounds) throw new Error(`Expected DI label for ${message.id}`);
      return edge.labelBounds;
    });
    for (let left = 0; left < labelBounds.length; left++) {
      for (let right = left + 1; right < labelBounds.length; right++) {
        expect(overlaps(labelBounds[left], labelBounds[right])).toBe(false);
      }
    }
  });

  it('indexes DI shapes and edges once per collaboration layout pass', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('External exchange', 'collaboration');
    const first = await engine.createElement(collaboration.id, {
      id: 'Participant_FirstExternal',
      type: 'bpmn:Participant',
      name: 'First external party',
      properties: { blackBox: true }
    });
    const second = await engine.createElement(collaboration.id, {
      id: 'Participant_SecondExternal',
      type: 'bpmn:Participant',
      name: 'Second external party',
      properties: { blackBox: true }
    });
    for (let index = 0; index < 4; index++) {
      await engine.connect(collaboration.id, first.id, second.id, `Message ${index}`);
    }

    const document = collaboration.document;
    const shapeValues = jest.spyOn(document.diagram.shapes, 'values');
    const edgeValues = jest.spyOn(document.diagram.edges, 'values');

    applyCollaborationLayoutPolicy(document, document);

    expect(shapeValues).toHaveBeenCalledTimes(1);
    expect(edgeValues).toHaveBeenCalledTimes(1);
  });
});

function plainBounds(bounds: any): Bounds {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function plainPoint(point: any): { x: number; y: number } {
  return { x: point.x, y: point.y };
}

function contains(container: Bounds, child: Bounds): boolean {
  return child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height;
}

function overlaps(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function onBoundary(point: { x: number; y: number }, bounds: Bounds): boolean {
  const onHorizontal = (point.y === bounds.y || point.y === bounds.y + bounds.height)
    && point.x >= bounds.x && point.x <= bounds.x + bounds.width;
  const onVertical = (point.x === bounds.x || point.x === bounds.x + bounds.width)
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  return onHorizontal || onVertical;
}
