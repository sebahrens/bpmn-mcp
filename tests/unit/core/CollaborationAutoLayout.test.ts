import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import BpmnModdle from 'bpmn-moddle';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { applyCollaborationLayoutPolicy } from '../../../src/core/layout/CollaborationLayoutPolicy.js';
import { ConnectionRouter } from '../../../src/core/layout/ConnectionRouter.js';
import { type GeometryDiagnostic, validateBpmnGeometry } from '../../helpers/bpmnGeometry.js';

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
    expect(report.diagnostics).toEqual([]);

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
    // Pools share one width; the requested 600 stays a lower bound for the
    // narrower pool, which the stack widens to the widest requested pool.
    expect(shapes.get(first.id)).toMatchObject({ width: 700, height: 180 });
    expect(shapes.get(second.id)).toMatchObject({ width: 700, height: 160 });
    expect(overlaps(shapes.get(first.id)!, shapes.get(second.id)!)).toBe(false);
    const edge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === message.id
    );
    expect(onBoundary(plainPoint(edge.waypoint[0]), shapes.get(first.id)!)).toBe(true);
    expect(onBoundary(plainPoint(edge.waypoint.at(-1)), shapes.get(second.id)!)).toBe(true);
  });

  it('lays out an imported collaboration whose data object is not rendered', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const source = await fs.readFile(
      join(process.cwd(), 'tests', 'fixtures', 'agent-geometry', 'imperfect-collaboration.bpmn'),
      'utf8'
    );
    const imported = await engine.importXml(source, 'imperfect-collaboration');

    await expect(engine.applyAutoLayout(imported.id)).resolves.toBeDefined();

    const report = await validateBpmnGeometry(await engine.exportXml(imported.id));
    expect(report.diagnostics.map(item => item.code)).not.toContain('MISSING_SHAPE');
  });

  it('aligns pools on one left edge and one width, stretching their lanes', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('Aligned pools', 'collaboration');
    const wide = await engine.createElement(collaboration.id, {
      id: 'Participant_Wide',
      type: 'bpmn:Participant',
      name: 'Wide pool',
      position: { x: 280, y: 40 },
      size: { width: 900, height: 200 }
    });
    const narrow = await engine.createElement(collaboration.id, {
      id: 'Participant_Narrow',
      type: 'bpmn:Participant',
      name: 'Narrow pool',
      position: { x: 80, y: 400 },
      size: { width: 400, height: 200 }
    });
    if (wide.kind !== 'participant' || !wide.processRef
      || narrow.kind !== 'participant' || !narrow.processRef) {
      throw new Error('Expected collaboration participants');
    }
    for (const definition of [
      { id: 'Wide_Start', type: 'bpmn:StartEvent' as const, ownerId: wide.processRef },
      { id: 'Wide_End', type: 'bpmn:EndEvent' as const, ownerId: wide.processRef },
      { id: 'Narrow_Start', type: 'bpmn:StartEvent' as const, ownerId: narrow.processRef },
      { id: 'Narrow_End', type: 'bpmn:EndEvent' as const, ownerId: narrow.processRef }
    ]) {
      await engine.createElement(collaboration.id, { ...definition, position: { x: 5, y: 5 } });
    }
    await engine.connect(collaboration.id, 'Wide_Start', 'Wide_End');
    await engine.connect(collaboration.id, 'Narrow_Start', 'Narrow_End');
    const lane = await engine.addLane(
      collaboration.id,
      narrow.id,
      'Only lane',
      ['Narrow_Start', 'Narrow_End'],
      'top'
    );

    await engine.applyAutoLayout(collaboration.id);

    const shapes = new Map<string, Bounds>(Array.from(
      collaboration.document.diagram.shapes.values(),
      shape => [shape.elementId, boundsOf(collaboration, shape.elementId)]
    ));
    const pools = [shapes.get(wide.id)!, shapes.get(narrow.id)!];
    expect(pools[0].x).toBe(pools[1].x);
    expect(pools[0].width).toBe(pools[1].width);
    expect(pools[0].width).toBeGreaterThanOrEqual(900);
    const laneBounds = collaboration.document.lanes.get(lane.id)!;
    expect(laneBounds.size.width).toBe(pools[1].width - 30);
    expect(contains(pools[1], { ...laneBounds.position, ...laneBounds.size })).toBe(true);
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
    const routedShapes: unknown[] = [];
    const routedEdges: unknown[] = [];
    const route = ConnectionRouter.prototype.route;
    const routeSpy = jest.spyOn(ConnectionRouter.prototype, 'route')
      .mockImplementation(function (this: ConnectionRouter, ...args) {
        routedShapes.push(args[2].shapes);
        routedEdges.push(args[2].edges);
        return route.apply(this, args);
      } as typeof route);

    try {
      applyCollaborationLayoutPolicy(document, document);
    } finally {
      routeSpy.mockRestore();
    }

    expect(shapeValues).toHaveBeenCalledTimes(1);
    expect(edgeValues).toHaveBeenCalledTimes(1);
    expect(routedShapes).toHaveLength(4);
    expect(new Set(routedShapes).size).toBe(1);
    expect(new Set(routedEdges).size).toBe(1);
  });

  /**
   * mcp-bpmn-3g8.16. An agent adds lanes once it has the node ids, so nodes
   * created afterwards belong to no lane at all. The ranked layout put them
   * wherever they fell and the bands were drawn over the top, so the picture
   * said "Sales owns this" while the XML said nobody did.
   */
  it('keeps elements no lane claims out of every lane band', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('Orders', 'collaboration');
    const pool = await engine.createElement(collaboration.id, {
      id: 'Participant_1',
      type: 'bpmn:Participant',
      name: 'Company'
    });
    if (pool.kind !== 'participant' || !pool.processRef) {
      throw new Error('Expected a white-box pool');
    }
    const owner = pool.processRef;
    const add = async (id: string, type: any, properties?: Record<string, unknown>) => {
      await engine.createElement(collaboration.id, { id, type, ownerId: owner, properties });
    };
    for (const [id, type] of [
      ['StartEvent_1', 'bpmn:StartEvent'],
      ['UserTask_1', 'bpmn:UserTask'],
      ['SendTask_1', 'bpmn:SendTask'],
      ['EndEvent_2', 'bpmn:EndEvent'],
      ['Task_1', 'bpmn:Task'],
      ['ExclusiveGateway_1', 'bpmn:ExclusiveGateway'],
      ['Task_2', 'bpmn:Task'],
      ['EndEvent_1', 'bpmn:EndEvent']
    ] as const) {
      await add(id, type);
    }
    for (const [source, target] of [
      ['StartEvent_1', 'UserTask_1'],
      ['UserTask_1', 'SendTask_1'],
      ['SendTask_1', 'EndEvent_2'],
      ['Task_1', 'ExclusiveGateway_1'],
      ['ExclusiveGateway_1', 'Task_2'],
      ['Task_2', 'EndEvent_1']
    ] as const) {
      await engine.connect(collaboration.id, source, target);
    }
    const sales = await engine.addLane(
      collaboration.id,
      pool.id,
      'Sales',
      ['StartEvent_1', 'UserTask_1', 'SendTask_1', 'EndEvent_2'],
      'top'
    );
    const warehouse = await engine.addLane(
      collaboration.id,
      pool.id,
      'Warehouse',
      ['Task_1', 'ExclusiveGateway_1', 'Task_2', 'EndEvent_1'],
      'bottom'
    );
    // Everything from here on is created after the lanes and therefore belongs
    // to neither of them.
    await add('Task_4', 'bpmn:Task');
    await add('EndEvent_3', 'bpmn:EndEvent');
    await add('BoundaryEvent_2', 'bpmn:BoundaryEvent', { attachTo: 'UserTask_1' });
    await engine.connect(collaboration.id, 'Task_4', 'EndEvent_3');
    await engine.connect(collaboration.id, 'BoundaryEvent_2', 'Task_4');

    await engine.applyAutoLayout(collaboration.id);
    const xml = await engine.exportXml(collaboration.id);
    const shapes = await renderedShapes(xml);

    const bands = [sales.id, warehouse.id].map(id => shapes.get(id)!);
    const drawnInsideABand = ['Task_4', 'EndEvent_3']
      .filter(id => bands.some(band => overlaps(band, shapes.get(id)!)));
    expect(drawnInsideABand).toEqual([]);
    // They still belong to the pool that owns their process, so they stay
    // inside it - in the strip under the band stack.
    const unassignedOutsidePool = ['Task_4', 'EndEvent_3']
      .filter(id => !contains(shapes.get(pool.id)!, shapes.get(id)!));
    expect(unassignedOutsidePool).toEqual([]);
    for (const band of bands) {
      expect(contains(shapes.get(pool.id)!, band)).toBe(true);
    }

    const report = await validateBpmnGeometry(xml);
    expect(unrelatedToLaneMembership(report.diagnostics)).toEqual([]);
  });

  /**
   * The other half of mcp-bpmn-3g8.16: a boundary event is drawn on its host's
   * outline, so a host sitting on a divider leaves the event hanging in the
   * neighbouring lane. The band has to be sized around its members plus their
   * boundary events, not around its members alone.
   */
  it('grows a lane band around the boundary events of its own members', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('Handling', 'collaboration');
    const pool = await engine.createElement(collaboration.id, {
      id: 'Participant_1',
      type: 'bpmn:Participant',
      name: 'Company'
    });
    if (pool.kind !== 'participant' || !pool.processRef) {
      throw new Error('Expected a white-box pool');
    }
    const owner = pool.processRef;
    for (const [id, type] of [
      ['StartEvent_1', 'bpmn:StartEvent'],
      ['Task_1', 'bpmn:Task'],
      ['Task_2', 'bpmn:Task']
    ] as const) {
      await engine.createElement(collaboration.id, { id, type, ownerId: owner });
    }
    await engine.createElement(collaboration.id, {
      id: 'BoundaryEvent_1',
      type: 'bpmn:BoundaryEvent',
      ownerId: owner,
      properties: { attachTo: 'Task_1' }
    });
    await engine.connect(collaboration.id, 'StartEvent_1', 'Task_1');
    const upper = await engine.addLane(
      collaboration.id,
      pool.id,
      'Upper',
      ['StartEvent_1', 'Task_1'],
      'top'
    );
    const lower = await engine.addLane(collaboration.id, pool.id, 'Lower', ['Task_2'], 'bottom');

    // Stand in for a ranked layout that pushed the host onto the divider: the
    // boundary event then straddles it, half of it drawn in the lower lane.
    const requested = engine.getProcess(collaboration.id).document;
    const laidOut = await hoistOntoDivider(engine, collaboration.id, upper.id);
    await engine.applyLayoutXml(collaboration.id, laidOut, requested);

    const xml = await engine.exportXml(collaboration.id);
    const shapes = await renderedShapes(xml);
    expect(contains(shapes.get(upper.id)!, shapes.get('BoundaryEvent_1')!)).toBe(true);
    expect(overlaps(shapes.get(lower.id)!, shapes.get('BoundaryEvent_1')!)).toBe(false);
    expect(contains(shapes.get(upper.id)!, shapes.get('Task_1')!)).toBe(true);
    expect(overlaps(shapes.get(upper.id)!, shapes.get(lower.id)!)).toBe(false);

    const report = await validateBpmnGeometry(xml);
    expect(unrelatedToLaneMembership(report.diagnostics)).toEqual([]);
  });
});

/**
 * Push the last member of a lane down so its bottom edge lands on the band's
 * bottom edge, and hand back the resulting XML as if a layout engine had
 * produced it.
 */
async function hoistOntoDivider(
  engine: SimpleBpmnEngine,
  processId: string,
  laneId: string
): Promise<string> {
  const xml = await engine.exportXml(processId);
  const definitions = (await new BpmnModdle().fromXML(xml)).rootElement as any;
  const planeElements = definitions.diagrams[0].plane.planeElement;
  const shapeFor = (id: string): any => planeElements.find(
    (item: any) => item.$type === 'bpmndi:BPMNShape' && item.bpmnElement?.id === id
  );
  const band = shapeFor(laneId).bounds;
  const host = shapeFor('Task_1').bounds;
  const shift = band.y + band.height - (host.y + host.height);
  host.y += shift;
  const boundary = shapeFor('BoundaryEvent_1').bounds;
  boundary.y += shift;
  return (await new BpmnModdle().toXML(definitions)).xml as string;
}

/**
 * Every diagnostic except the one the geometry model cannot express yet: a
 * boundary event is never listed in its host lane's `flowNodeRef`, so the
 * oracle reads a correctly drawn one as a stray shape overlapping the band.
 * Tracked separately - the fix is lane membership, which auto-layout is
 * forbidden to change.
 */
function unrelatedToLaneMembership(diagnostics: GeometryDiagnostic[]): GeometryDiagnostic[] {
  return diagnostics.filter(item => !item.ids.some(id => id.startsWith('BoundaryEvent_')));
}

async function renderedShapes(xml: string): Promise<Map<string, Bounds>> {
  const definitions = (await new BpmnModdle().fromXML(xml)).rootElement as any;
  return new Map(definitions.diagrams[0].plane.planeElement
    .filter((item: any) => item.$type === 'bpmndi:BPMNShape')
    .map((item: any) => [item.bpmnElement.id as string, plainBounds(item.bounds)]));
}

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

function boundsOf(collaboration: { document: { elements: Map<string, any>; lanes: Map<string, any> } }, id: string): Bounds {
  const element = collaboration.document.elements.get(id) ?? collaboration.document.lanes.get(id);
  if (!element) throw new Error(`Unknown element ${id}`);
  return { ...element.position, ...element.size };
}
