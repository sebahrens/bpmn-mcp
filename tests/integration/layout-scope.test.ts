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
 * mcp-bpmn-9sv.21: `auto_layout` could only rank the whole plane, so an agent
 * that changed one subprocess had to accept every other element being moved.
 * `scopeId` ranks the contents of one subprocess or pool, grows the container
 * around the result, and pushes only the siblings that container now runs
 * into - never the whole plane, and never leaving an overlap behind.
 */
describe('scoped auto-layout', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-scope-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('ranks the scope and leaves the rest of the plane exactly where it is', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await buildSubProcessDiagram(engine);
    await engine.applyAutoLayout(process);
    // A hand-placed element outside the scope: a full layout ranks it away, a
    // scoped one has no business touching it.
    const parked = { x: 1_400, y: 620, width: 36, height: 36 };
    await engine.updateElementGeometry(process, 'EndEvent_1', {
      bounds: parked,
      incidentConnectionPolicy: 'snap-endpoints'
    });
    const before = await renderedShapes(await engine.exportXml(process));

    await engine.applyAutoLayout(process, undefined, 'left-to-right', { scopeId: 'Sub_1' });

    const xml = await engine.exportXml(process);
    const after = await renderedShapes(xml);
    expect(after.get('EndEvent_1')).toEqual(parked);
    const moved = ['StartEvent_1', 'Task_After', 'EndEvent_1']
      .filter(id => !sameBounds(before.get(id)!, after.get(id)!));
    expect(moved).toEqual([]);
    // The scope itself was ranked: its two tasks read left to right again.
    expect(after.get('Task_A')!.x).toBeLessThan(after.get('Task_B')!.x);
    expect(after.get('Task_A')!.y).toEqual(after.get('Task_B')!.y);
    expect((await validateBpmnGeometry(xml)).diagnostics).toEqual([]);

    // The counterfactual: the unscoped layout does rank the parked element.
    await engine.applyAutoLayout(process);
    const reflowed = await renderedShapes(await engine.exportXml(process));
    expect(sameBounds(reflowed.get('EndEvent_1')!, parked)).toBe(false);
  });

  it('pushes the siblings a grown subprocess runs into, just far enough', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await buildSubProcessDiagram(engine);
    await engine.applyAutoLayout(process);
    const before = await renderedShapes(await engine.exportXml(process));
    for (const id of ['Task_C', 'Task_D']) {
      await engine.createElement(process, { id, type: 'bpmn:Task', scopeId: 'Sub_1' });
    }
    await engine.connect(process, 'Task_B', 'Task_C');
    await engine.connect(process, 'Task_C', 'Task_D');

    const result = await engine.applyAutoLayout(process, undefined, 'left-to-right', {
      scopeId: 'Sub_1'
    });

    // The caller asked for one scope and is told what else had to give way.
    expect(result.warnings.map(item => item.code)).toEqual(['SCOPED_LAYOUT_DISPLACED']);
    expect(result.warnings[0].relatedElementIds).toEqual(['EndEvent_1', 'Task_After']);
    const xml = await engine.exportXml(process);
    const after = await renderedShapes(xml);
    const scope = after.get('Sub_1')!;
    expect(scope.width).toBeGreaterThan(before.get('Sub_1')!.width);
    // Nothing upstream of the scope had to move at all.
    expect(after.get('StartEvent_1')).toEqual(before.get('StartEvent_1'));
    // The two elements the wider box reached are clear of it, and no further
    // than they had to go: each one sits exactly one clearance past the edge
    // it was pushed over, on the axis that needed the smaller move.
    expect(after.get('Task_After')!.x).toEqual(before.get('Task_After')!.x);
    expect(after.get('Task_After')!.y).toEqual(scope.y + scope.height + 20);
    expect(after.get('EndEvent_1')!.x).toEqual(scope.x + scope.width + 20);
    const overlapping = ['StartEvent_1', 'Task_After', 'EndEvent_1']
      .filter(id => overlaps(after.get(id)!, scope));
    expect(overlapping).toEqual([]);
    expect((await validateBpmnGeometry(xml)).diagnostics).toEqual([]);
  });

  it('pushes an annotation the scope grew into and re-routes its association', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await buildSubProcessDiagram(engine);
    await engine.applyAutoLayout(process);
    const scopeBefore = (await renderedShapes(await engine.exportXml(process))).get('Sub_1')!;
    // Parked directly in the path of the widening subprocess.
    await engine.createElement(process, {
      id: 'TextAnnotation_1',
      type: 'bpmn:TextAnnotation',
      position: { x: scopeBefore.x + scopeBefore.width + 240, y: scopeBefore.y + 10 },
      properties: { text: 'Checked nightly' }
    });
    await engine.addAssociation(process, 'TextAnnotation_1', 'Task_After');
    for (const id of ['Task_C', 'Task_D']) {
      await engine.createElement(process, { id, type: 'bpmn:Task', scopeId: 'Sub_1' });
    }
    await engine.connect(process, 'Task_B', 'Task_C');
    await engine.connect(process, 'Task_C', 'Task_D');
    const before = await renderedShapes(await engine.exportXml(process));

    await engine.applyAutoLayout(process, undefined, 'left-to-right', { scopeId: 'Sub_1' });

    const xml = await engine.exportXml(process);
    const after = await renderedShapes(xml);
    const scope = after.get('Sub_1')!;
    expect(scope.width).toBeGreaterThan(scopeBefore.width);
    const annotation = after.get('TextAnnotation_1')!;
    expect(sameBounds(annotation, before.get('TextAnnotation_1')!)).toBe(false);
    expect(overlaps(annotation, scope)).toBe(false);
    // Pushed along one axis only, and nothing the scope never reached moved.
    expect(annotation.y).toEqual(before.get('TextAnnotation_1')!.y);
    expect(annotation.x).toEqual(scope.x + scope.width + 20);
    expect(after.get('StartEvent_1')).toEqual(before.get('StartEvent_1'));
    expect((await validateBpmnGeometry(xml)).diagnostics).toEqual([]);
  });

  it('grows the containing subprocess when a nested scope outgrows it', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = (await engine.createProcess('Nested', 'process')).id;
    await engine.createElement(process, { id: 'StartEvent_1', type: 'bpmn:StartEvent' });
    await engine.createElement(process, {
      id: 'Outer',
      type: 'bpmn:SubProcess',
      properties: { isExpanded: true }
    });
    await engine.createElement(process, {
      id: 'Inner',
      type: 'bpmn:SubProcess',
      scopeId: 'Outer',
      properties: { isExpanded: true }
    });
    for (const id of ['Task_I1', 'Task_I2']) {
      await engine.createElement(process, { id, type: 'bpmn:Task', scopeId: 'Inner' });
    }
    await engine.connect(process, 'Task_I1', 'Task_I2');
    await engine.createElement(process, { id: 'Task_O2', type: 'bpmn:Task', scopeId: 'Outer' });
    await engine.connect(process, 'Inner', 'Task_O2');
    await engine.createElement(process, { id: 'EndEvent_1', type: 'bpmn:EndEvent' });
    await engine.connect(process, 'StartEvent_1', 'Outer');
    await engine.connect(process, 'Outer', 'EndEvent_1');
    await engine.applyAutoLayout(process);
    const before = await renderedShapes(await engine.exportXml(process));
    for (const id of ['Task_I3', 'Task_I4']) {
      await engine.createElement(process, { id, type: 'bpmn:Task', scopeId: 'Inner' });
    }
    await engine.connect(process, 'Task_I2', 'Task_I3');
    await engine.connect(process, 'Task_I3', 'Task_I4');

    await engine.applyAutoLayout(process, undefined, 'left-to-right', { scopeId: 'Inner' });

    const xml = await engine.exportXml(process);
    const after = await renderedShapes(xml);
    expect(after.get('Outer')!.width).toBeGreaterThan(before.get('Outer')!.width);
    // Every ancestor still holds what it owns, and the plane's own elements
    // were pushed rather than reflowed.
    const escaped = ['Inner', 'Task_O2'].filter(id => !contains(after.get('Outer')!, after.get(id)!));
    expect(escaped).toEqual([]);
    expect(after.get('StartEvent_1')).toEqual(before.get('StartEvent_1'));
    expect(after.get('EndEvent_1')!.y).toEqual(before.get('EndEvent_1')!.y);
    // Task_O2 was pushed out of the widened Inner, not re-ranked behind it:
    // a reflow would have moved it right, the push moved it straight down.
    expect(after.get('Task_O2')!.x).toEqual(before.get('Task_O2')!.x);
    expect(after.get('Task_O2')!.y).toEqual(
      after.get('Inner')!.y + after.get('Inner')!.height + 20
    );
    expect((await validateBpmnGeometry(xml)).diagnostics).toEqual([]);
  });

  it('lays out one pool and pushes the pool below it down', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const diagram = (await engine.createProcess('Two pools', 'collaboration')).id;
    const processes: Record<string, string> = {};
    for (const id of ['Pool_A', 'Pool_B']) {
      const pool = await engine.createElement(diagram, { id, type: 'bpmn:Participant' });
      if (pool.kind !== 'participant' || !pool.processRef) throw new Error('Expected a pool');
      processes[id] = pool.processRef;
    }
    for (const [pool, prefix] of [['Pool_A', 'A'], ['Pool_B', 'B']] as const) {
      await engine.createElement(diagram, {
        id: `Start_${prefix}`,
        type: 'bpmn:StartEvent',
        ownerId: processes[pool]
      });
      await engine.createElement(diagram, {
        id: `Task_${prefix}1`,
        type: 'bpmn:Task',
        ownerId: processes[pool]
      });
      await engine.connect(diagram, `Start_${prefix}`, `Task_${prefix}1`);
    }
    await engine.applyAutoLayout(diagram);
    const before = await renderedShapes(await engine.exportXml(diagram));
    // Four parallel branches make the pool far taller than the one below it.
    await engine.createElement(diagram, {
      id: 'Gate_A',
      type: 'bpmn:ExclusiveGateway',
      ownerId: processes.Pool_A
    });
    await engine.connect(diagram, 'Task_A1', 'Gate_A');
    for (const branch of ['Branch_1', 'Branch_2', 'Branch_3', 'Branch_4']) {
      await engine.createElement(diagram, {
        id: branch,
        type: 'bpmn:Task',
        ownerId: processes.Pool_A
      });
      await engine.connect(diagram, 'Gate_A', branch);
    }

    await engine.applyAutoLayout(diagram, undefined, 'left-to-right', { scopeId: 'Pool_A' });

    const xml = await engine.exportXml(diagram);
    const after = await renderedShapes(xml);
    const poolA = after.get('Pool_A')!;
    expect(poolA.height).toBeGreaterThan(before.get('Pool_A')!.height);
    expect(poolA.x).toEqual(before.get('Pool_A')!.x);
    expect(poolA.y).toEqual(before.get('Pool_A')!.y);
    // The other pool travelled as one body: pushed clear, never re-ranked.
    const shift = after.get('Pool_B')!.y - before.get('Pool_B')!.y;
    expect(after.get('Pool_B')!.y).toEqual(poolA.y + poolA.height + 20);
    const dragged = ['Start_B', 'Task_B1'].filter(id =>
      after.get(id)!.x !== before.get(id)!.x || after.get(id)!.y !== before.get(id)!.y + shift);
    expect(dragged).toEqual([]);
    const errors = (await validateBpmnGeometry(xml)).diagnostics
      .filter(item => item.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('reproduces its own result when the same scope is laid out twice', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await buildSubProcessDiagram(engine);
    await engine.applyAutoLayout(process, undefined, 'top-to-bottom');
    await engine.createElement(process, { id: 'Task_C', type: 'bpmn:Task', scopeId: 'Sub_1' });
    await engine.connect(process, 'Task_B', 'Task_C');
    const before = await renderedShapes(await engine.exportXml(process));

    const first = await engine.applyAutoLayout(process, undefined, 'top-to-bottom', {
      scopeId: 'Sub_1'
    });
    const xml = await engine.exportXml(process);
    const second = await engine.applyAutoLayout(process, undefined, 'top-to-bottom', {
      scopeId: 'Sub_1'
    });

    expect(first.changed).toBe(true);
    const after = await renderedShapes(xml);
    expect(after.get('StartEvent_1')).toEqual(before.get('StartEvent_1'));
    // The push signature rather than a reflow's own rank gap: exactly one
    // clearance below the grown scope.
    expect(after.get('Task_After')!.y)
      .toEqual(after.get('Sub_1')!.y + after.get('Sub_1')!.height + 20);
    // Nothing moved the second time, so nothing was committed: the router is
    // only asked for a route where the geometry around it actually changed.
    expect(second.changed).toBe(false);
    expect(await engine.exportXml(process)).toBe(xml);
    expect((await validateBpmnGeometry(xml)).diagnostics).toEqual([]);
  });

  it('refuses a scope it cannot express, leaving the diagram alone', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await buildSubProcessDiagram(engine);
    await engine.createElement(process, {
      id: 'Collapsed_1',
      type: 'bpmn:SubProcess',
      properties: { isExpanded: false }
    });
    await engine.applyAutoLayout(process);
    const before = await engine.exportXml(process);

    const refusals: Array<[string, RegExp]> = [
      ['Sub_404', /Scope Sub_404 is not in this diagram/u],
      ['Task_After', /is a bpmn:Task; scopeId accepts/u],
      ['Collapsed_1', /is a collapsed subprocess/u]
    ];
    for (const [scopeId, message] of refusals) {
      await expect(engine.applyAutoLayout(process, undefined, 'left-to-right', { scopeId }))
        .rejects.toThrow(message);
    }
    await expect(engine.applyAutoLayout(process, undefined, 'left-to-right', {
      scopeId: 'Sub_1',
      pinnedElementIds: ['Task_After']
    })).rejects.toThrow(/cannot be combined/u);
    await expect(engine.applyAutoLayout(process, undefined, 'left-to-right', { scopeId: '  ' }))
      .rejects.toThrow(/scopeId must be the id of an expanded subprocess or of a pool/u);
    expect(await engine.exportXml(process)).toBe(before);
  });

  it('refuses a scope whose contents no lane band could hold', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const diagram = (await engine.createProcess('Laned', 'collaboration')).id;
    const pool = await engine.createElement(diagram, {
      id: 'Pool_1',
      type: 'bpmn:Participant'
    });
    if (pool.kind !== 'participant' || !pool.processRef) throw new Error('Expected a pool');
    await engine.createElement(diagram, {
      id: 'Sub_1',
      type: 'bpmn:SubProcess',
      ownerId: pool.processRef,
      properties: { isExpanded: true }
    });
    await engine.createElement(diagram, {
      id: 'Task_A',
      type: 'bpmn:Task',
      ownerId: pool.processRef,
      scopeId: 'Sub_1'
    });
    await engine.addLane(diagram, 'Pool_1', 'Reviewers', ['Sub_1']);

    await expect(engine.applyAutoLayout(diagram, undefined, 'left-to-right', {
      scopeId: 'Sub_1'
    })).rejects.toThrow(/sits in a process with lanes/u);
  });

  it('refuses a scope in a collaboration that only draws black-box pools', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const diagram = (await engine.createProcess('Black boxes', 'collaboration')).id;
    await engine.createElement(diagram, {
      id: 'Pool_1',
      type: 'bpmn:Participant',
      properties: { blackBox: true }
    });

    await expect(engine.applyAutoLayout(diagram, undefined, 'left-to-right', {
      scopeId: 'Pool_1'
    })).rejects.toThrow(/black box/u);
  });
});

/** Start -> [Sub_1: Task_A -> Task_B] -> Task_After -> End. */
async function buildSubProcessDiagram(engine: SimpleBpmnEngine): Promise<string> {
  const process = (await engine.createProcess('Scoped', 'process')).id;
  await engine.createElement(process, { id: 'StartEvent_1', type: 'bpmn:StartEvent' });
  await engine.createElement(process, {
    id: 'Sub_1',
    type: 'bpmn:SubProcess',
    properties: { isExpanded: true }
  });
  for (const id of ['Task_A', 'Task_B']) {
    await engine.createElement(process, { id, type: 'bpmn:Task', scopeId: 'Sub_1' });
  }
  await engine.connect(process, 'Task_A', 'Task_B');
  await engine.createElement(process, { id: 'Task_After', type: 'bpmn:Task' });
  await engine.createElement(process, { id: 'EndEvent_1', type: 'bpmn:EndEvent' });
  await engine.connect(process, 'StartEvent_1', 'Sub_1');
  await engine.connect(process, 'Sub_1', 'Task_After');
  await engine.connect(process, 'Task_After', 'EndEvent_1');
  return process;
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

function sameBounds(left: Bounds, right: Bounds): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function overlaps(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function contains(parent: Bounds, child: Bounds): boolean {
  return child.x >= parent.x
    && child.y >= parent.y
    && child.x + child.width <= parent.x + parent.width
    && child.y + child.height <= parent.y + parent.height;
}
