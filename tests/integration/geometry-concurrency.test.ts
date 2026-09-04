import type { BpmnRequestHandler } from '../../src/server/handlers.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdGenerator } from '../../src/utils/IdGenerator.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import {
  createTempDiagramsSandbox,
  type TempHandlerSandbox
} from '../helpers/tempDiagrams.js';

/**
 * Optimistic-concurrency rejections and endpoint snapping inside
 * apply_geometry_patch (mcp-bpmn-5e7.7).
 *
 * The single-object geometry tools were covered, but the batch tool was not:
 * its connection compare-and-set throws, its labelBounds compare-and-set, and
 * its snap-to-boundary endpoint rewrite had no test. A stale patch that is
 * silently applied clobbers another editor's work, so every rejection here also
 * asserts that memory, revision, and the file on disk are byte-identical
 * afterwards.
 */
describe('apply_geometry_patch concurrency and endpoint policy', () => {
  let handler: BpmnRequestHandler;
  let sandbox: TempHandlerSandbox | undefined;

  interface Scene {
    sourceId: string;
    targetId: string;
    /** A task no connection touches, so it can be moved on its own. */
    freeId: string;
    freeBounds: { x: number; y: number; width: number; height: number };
    connectionId: string;
    /** Geometry revision of the connection as of the last read. */
    geometryRevision: string;
    waypoints: Array<{ x: number; y: number }>;
    sourceBounds: { x: number; y: number; width: number; height: number };
    targetBounds: { x: number; y: number; width: number; height: number };
  }

  async function call(name: string, args: Record<string, unknown>) {
    return handler.handleRequest(name, args);
  }

  async function structured(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    if (result.isError) {
      throw new Error(`Unexpected ${name} error: ${JSON.stringify(result.content)}`);
    }
    return result.structuredContent as any;
  }

  /**
   * Two tasks 400px apart joined by one sequence flow with a rendered edge, plus
   * a third task no connection touches so element-only patches stay docked.
   */
  async function buildScene(): Promise<Scene> {
    await structured('new_bpmn', { name: 'Geometry concurrency' });
    const source = await structured('add_activity', {
      activityType: 'task', name: 'Source', position: { x: 100, y: 200 }
    });
    const target = await structured('add_activity', {
      activityType: 'task', name: 'Target', position: { x: 500, y: 200 }
    });
    const free = await structured('add_activity', {
      activityType: 'task', name: 'Free', position: { x: 100, y: 500 }
    });
    const connected = await structured('connect', {
      sourceId: source.elementId,
      targetId: target.elementId
    });
    const connection = await structured('get_connection', {
      connectionId: connected.connectionId
    });
    const sourceElement = await structured('get_element', { elementId: source.elementId });
    const targetElement = await structured('get_element', { elementId: target.elementId });
    const freeElement = await structured('get_element', { elementId: free.elementId });

    return {
      sourceId: source.elementId,
      targetId: target.elementId,
      freeId: free.elementId,
      freeBounds: freeElement.bounds,
      connectionId: connected.connectionId,
      geometryRevision: connection.geometryRevision,
      waypoints: connection.waypoints,
      sourceBounds: sourceElement.bounds,
      targetBounds: targetElement.bounds
    };
  }

  /** Everything a rejected patch must leave untouched. */
  async function snapshot() {
    const context = diagramContext.getCurrent();
    return {
      xml: context.xml,
      revision: context.revision,
      disk: await readFile(join(sandbox!.directory, context.filename!), 'utf8')
    };
  }

  beforeEach(async () => {
    IdGenerator.reset();
    diagramContext.clear();
    sandbox = await createTempDiagramsSandbox('geometry-concurrency');
    handler = sandbox.handler;
  });

  afterEach(async () => {
    diagramContext.clear();
    await sandbox?.cleanup();
    sandbox = undefined;
  });

  it('rejects a connection update whose expectedGeometryRevision is stale', async () => {
    const scene = await buildScene();
    const staleRevision = scene.geometryRevision;

    // Another editor reroutes the same connection first.
    const winner = await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 200, y: 240 }, { x: 350, y: 320 }, { x: 500, y: 240 }],
        expectedGeometryRevision: staleRevision
      }],
      collisionPolicy: 'allow'
    });
    expect(winner.connections[0].after.geometryRevision).not.toBe(staleRevision);
    const before = await snapshot();

    const stale = await call('apply_geometry_patch', {
      expectedRevision: before.revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 200, y: 240 }, { x: 500, y: 240 }],
        expectedGeometryRevision: staleRevision
      }],
      collisionPolicy: 'allow'
    });

    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({
      code: 'geometry_conflict',
      conflict: true,
      reason: 'geometry_revision_mismatch',
      connectionId: scene.connectionId,
      actualWaypoints: winner.connections[0].after.waypoints,
      actualGeometryRevision: winner.connections[0].after.geometryRevision,
      expectedGeometryRevision: staleRevision,
      recovery: expect.stringContaining('Refresh')
    });
    expect(stale.structuredContent).not.toHaveProperty('expectedWaypoints');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a connection update whose expectedWaypoints no longer match', async () => {
    const scene = await buildScene();
    const rerouted = [{ x: 200, y: 240 }, { x: 350, y: 300 }, { x: 500, y: 240 }];
    const winner = await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: rerouted,
        expectedGeometryRevision: scene.geometryRevision
      }],
      collisionPolicy: 'allow'
    });
    const before = await snapshot();
    const currentGeometryRevision = winner.connections[0].after.geometryRevision;

    // The revision guard is satisfied; only the waypoint compare-and-set fails,
    // so this pins the waypoints_mismatch branch specifically.
    const stale = await call('apply_geometry_patch', {
      expectedRevision: before.revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 200, y: 240 }, { x: 500, y: 240 }],
        expectedWaypoints: scene.waypoints,
        expectedGeometryRevision: currentGeometryRevision
      }],
      collisionPolicy: 'allow'
    });

    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({
      code: 'geometry_conflict',
      conflict: true,
      reason: 'waypoints_mismatch',
      connectionId: scene.connectionId,
      expectedWaypoints: scene.waypoints,
      actualWaypoints: rerouted,
      actualGeometryRevision: currentGeometryRevision,
      expectedGeometryRevision: currentGeometryRevision
    });
    expect(await snapshot()).toEqual(before);
  });

  it('accepts the same connection update once its expected geometry is refreshed', async () => {
    const scene = await buildScene();
    await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 200, y: 240 }, { x: 350, y: 300 }, { x: 500, y: 240 }],
        expectedGeometryRevision: scene.geometryRevision
      }],
      collisionPolicy: 'allow'
    });
    const refreshed = await structured('get_connection', {
      connectionId: scene.connectionId
    });

    const applied = await structured('apply_geometry_patch', {
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 200, y: 240 }, { x: 500, y: 240 }],
        expectedWaypoints: refreshed.waypoints,
        expectedGeometryRevision: refreshed.geometryRevision
      }],
      collisionPolicy: 'allow'
    });

    expect(applied.applied).toBe(true);
    expect(applied.connections[0].after.waypoints)
      .toEqual([{ x: 200, y: 240 }, { x: 500, y: 240 }]);
  });

  it('rolls the whole batch back when one object in a mixed patch conflicts', async () => {
    const scene = await buildScene();
    const staleRevision = scene.geometryRevision;
    await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 200, y: 240 }, { x: 350, y: 320 }, { x: 500, y: 240 }],
        expectedGeometryRevision: staleRevision
      }],
      collisionPolicy: 'allow'
    });
    const before = await snapshot();
    const movedFree = { x: 100, y: 700, width: 100, height: 80 };
    const rerouted = [{ x: 200, y: 240 }, { x: 350, y: 180 }, { x: 500, y: 240 }];

    const mixed = await call('apply_geometry_patch', {
      expectedRevision: before.revision,
      // The element half of this patch is perfectly valid on its own.
      elementUpdates: [{ elementId: scene.freeId, bounds: movedFree }],
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: rerouted,
        expectedGeometryRevision: staleRevision
      }],
      collisionPolicy: 'allow'
    });

    expect(mixed.isError).toBe(true);
    expect(mixed.structuredContent).toMatchObject({
      code: 'geometry_conflict',
      reason: 'geometry_revision_mismatch',
      connectionId: scene.connectionId
    });
    // The valid element update must not survive its batch.
    const freeAfter = await structured('get_element', { elementId: scene.freeId });
    expect(freeAfter.bounds).toEqual(scene.freeBounds);
    expect(await snapshot()).toEqual(before);

    // The identical batch succeeds once the connection guard is current.
    const refreshed = await structured('get_connection', {
      connectionId: scene.connectionId
    });
    const applied = await structured('apply_geometry_patch', {
      expectedRevision: before.revision,
      elementUpdates: [{ elementId: scene.freeId, bounds: movedFree }],
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: rerouted,
        expectedGeometryRevision: refreshed.geometryRevision
      }],
      collisionPolicy: 'allow'
    });
    expect(applied.elements[0].after.bounds).toEqual(movedFree);
    expect(applied.connections[0].after.waypoints).toEqual(rerouted);
  });

  it('rejects an element update whose expectedBounds no longer match', async () => {
    const scene = await buildScene();
    const moved = { x: 100, y: 700, width: 100, height: 80 };
    await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      elementUpdates: [{ elementId: scene.freeId, bounds: moved }],
      collisionPolicy: 'allow'
    });
    const before = await snapshot();

    const stale = await call('apply_geometry_patch', {
      elementUpdates: [{
        elementId: scene.freeId,
        bounds: { x: 100, y: 900, width: 100, height: 80 },
        expectedBounds: scene.freeBounds
      }],
      collisionPolicy: 'allow'
    });

    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({
      code: 'geometry_conflict',
      conflict: true,
      elementId: scene.freeId,
      expectedBounds: scene.freeBounds,
      actualBounds: moved
    });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a labelBounds compare-and-set that no longer holds', async () => {
    const scene = await buildScene();
    const label = { x: 120, y: 300, width: 80, height: 20 };
    const before = await snapshot();

    // The shape has no BPMNLabel, so expecting one is a conflict rather than an
    // error about a missing element. GeometryPatchConflictError carries the
    // object, the field, and both values so the caller need not re-read.
    const conflict = await call('apply_geometry_patch', {
      expectedRevision: before.revision,
      elementUpdates: [{
        elementId: scene.sourceId,
        labelBounds: label,
        expectedLabelBounds: label
      }],
      collisionPolicy: 'allow'
    });

    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({
      code: 'geometry_conflict',
      conflict: true,
      objectType: 'element',
      objectId: scene.sourceId,
      field: 'labelBounds',
      expectedValue: label,
      actualValue: null
    });
    expect(await snapshot()).toEqual(before);

    // Expecting the absent label (null) is the compare-and-set that holds.
    const applied = await structured('apply_geometry_patch', {
      expectedRevision: before.revision,
      elementUpdates: [{
        elementId: scene.sourceId,
        labelBounds: label,
        expectedLabelBounds: null
      }],
      collisionPolicy: 'allow'
    });
    expect(applied.elements[0]).toMatchObject({
      elementId: scene.sourceId,
      before: { bounds: scene.sourceBounds },
      after: { labelBounds: label }
    });
    expect(applied.elements[0].before).not.toHaveProperty('labelBounds');

    // And the guard now rejects the stale "no label" expectation.
    const nowStale = await call('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      elementUpdates: [{
        elementId: scene.sourceId,
        labelBounds: { x: 130, y: 310, width: 80, height: 20 },
        expectedLabelBounds: null
      }],
      collisionPolicy: 'allow'
    });
    expect(nowStale.structuredContent).toMatchObject({
      code: 'geometry_conflict',
      objectType: 'element',
      objectId: scene.sourceId,
      field: 'labelBounds',
      expectedValue: null,
      actualValue: label
    });
  });

  it('snaps the first and last waypoint to the endpoint shapes under snap-to-boundary', async () => {
    const scene = await buildScene();
    // Both endpoints are submitted at the shape centre, which is inside the
    // shape rather than on its border.
    const submitted = [{ x: 150, y: 240 }, { x: 300, y: 240 }, { x: 550, y: 240 }];

    const snapped = await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: submitted,
        expectedGeometryRevision: scene.geometryRevision,
        endpointPolicy: 'snap-to-boundary'
      }],
      collisionPolicy: 'allow'
    });

    expect(snapped.connections[0]).toMatchObject({
      connectionId: scene.connectionId,
      endpointPolicy: 'snap-to-boundary'
    });
    expect(snapped.connections[0].after.waypoints).toEqual([
      // right border of the source, left border of the target
      { x: scene.sourceBounds.x + scene.sourceBounds.width, y: 240 },
      { x: 300, y: 240 },
      { x: scene.targetBounds.x, y: 240 }
    ]);
    // The interior waypoint is untouched, and the persisted DI matches memory.
    const persisted = await structured('get_connection', {
      connectionId: scene.connectionId
    });
    expect(persisted.waypoints).toEqual(snapped.connections[0].after.waypoints);
  });

  it('keeps submitted endpoints verbatim under the default exact policy', async () => {
    const scene = await buildScene();
    // Already docked on the source's right border and the target's left border.
    const docked = [{ x: 200, y: 240 }, { x: 300, y: 180 }, { x: 500, y: 240 }];

    const exact = await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: docked,
        expectedGeometryRevision: scene.geometryRevision
      }],
      collisionPolicy: 'allow'
    });

    expect(exact.connections[0].endpointPolicy).toBe('exact');
    expect(exact.connections[0].after.waypoints).toEqual(docked);
  });

  it('rejects centre endpoints under exact that snap-to-boundary accepts', async () => {
    const scene = await buildScene();
    const centres = [{ x: 150, y: 240 }, { x: 300, y: 240 }, { x: 550, y: 240 }];
    const before = await snapshot();

    // ENDPOINT_GAP is an invariant, so no collisionPolicy can wave it through.
    const rejected = await call('apply_geometry_patch', {
      expectedRevision: before.revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: centres,
        expectedGeometryRevision: scene.geometryRevision
      }],
      collisionPolicy: 'allow'
    });

    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain('Unsafe geometry patch');
    expect(rejected.content[0].text).toContain('Edge');
    expect(await snapshot()).toEqual(before);
  });

  it('snaps against the final bounds of a shape moved in the same patch', async () => {
    const scene = await buildScene();
    const movedTarget = { x: 700, y: 200, width: 100, height: 80 };

    const patched = await structured('apply_geometry_patch', {
      expectedRevision: diagramContext.getCurrent().revision,
      elementUpdates: [{ elementId: scene.targetId, bounds: movedTarget }],
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 150, y: 240 }, { x: 400, y: 240 }, { x: 750, y: 240 }],
        expectedGeometryRevision: scene.geometryRevision,
        endpointPolicy: 'snap-to-boundary'
      }],
      collisionPolicy: 'allow'
    });

    // Elements are applied before connections, so the snap uses x=700, not the
    // pre-patch x=500.
    expect(patched.connections[0].after.waypoints).toEqual([
      { x: 200, y: 240 },
      { x: 400, y: 240 },
      { x: movedTarget.x, y: 240 }
    ]);
  });

  it('leaves the diagram untouched when a snap-to-boundary patch is a dry run', async () => {
    const scene = await buildScene();
    const before = await snapshot();

    const preview = await structured('apply_geometry_patch', {
      expectedRevision: before.revision,
      connectionUpdates: [{
        connectionId: scene.connectionId,
        waypoints: [{ x: 150, y: 240 }, { x: 300, y: 240 }, { x: 550, y: 240 }],
        expectedGeometryRevision: scene.geometryRevision,
        endpointPolicy: 'snap-to-boundary'
      }],
      dryRun: true,
      collisionPolicy: 'allow'
    });

    expect(preview).toMatchObject({ dryRun: true, applied: false });
    expect(preview.connections[0].after.waypoints[0]).toEqual({ x: 200, y: 240 });
    expect(await snapshot()).toEqual(before);
  });
});
