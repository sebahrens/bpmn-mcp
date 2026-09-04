import type {
  BpmnDocument,
  BpmnDocumentElement,
  BpmnEdgeModel,
  BpmnLane,
  BpmnShapeModel,
  Position,
  Size
} from '../../types/index.js';
import { ConnectionRouter } from './ConnectionRouter.js';

type Bounds = Position & Size;

export const SCOPED_LAYOUT_POLICY = Object.freeze({
  /**
   * Separation opened between the resized scope and the siblings it runs into,
   * matching the clearance the pinning repair pass and the geometry oracle use.
   */
  clearance: 20,
  /** Breathing room a container keeps around the content it was grown to hold. */
  containerPadding: 20,
  /**
   * Relaxation passes the sibling push may take at one nesting level. A push
   * that has not settled by then is reported rather than committed.
   */
  maxPushPasses: 32,
  /**
   * Nesting levels the push may climb. A subprocess inside a subprocess inside
   * a pool is three; the cap only guards against a cyclic containment chain.
   */
  maxLevels: 16
});

const CONTAINER_TYPES = new Set(['bpmn:SubProcess', 'bpmn:Transaction']);

export class ScopedLayoutError extends Error {
  readonly code = 'SCOPE_NOT_APPLIED';

  constructor(message: string, readonly elementIds: string[] = []) {
    super(message);
    this.name = 'ScopedLayoutError';
  }
}

/** A container and everything that has to travel with it as one rigid body. */
interface Unit {
  elementIds: Set<string>;
  laneIds: Set<string>;
  box: Bounds;
}

/**
 * Lay out one subprocess or one pool without reflowing the rest of the plane.
 *
 * bpmn-auto-layout has no region API - `layoutProcess(xml)` takes a whole
 * document and returns a whole plane - so a scoped layout is a merge, not a
 * different call. The ranked plane is produced as usual and then everything
 * outside the named scope is put back exactly where it was, so only the
 * scope's own contents keep the ranking. The scope's block is moved back onto
 * the container's own position, the container keeps the size the ranking gave
 * it, and the siblings that box now runs into are pushed just far enough to
 * clear it. Nothing else on the plane moves.
 *
 * The pass checks its own work and throws rather than committing overlapping
 * or escaped shapes: a scope that cannot be merged is reported to the caller.
 *
 * @returns the ids of the elements the sibling push had to displace.
 */
export function applyScopedLayout(
  previous: BpmnDocument,
  laidOut: BpmnDocument,
  scopeId: string
): string[] {
  const container = resolveScope(previous, laidOut, scopeId);
  const before = previous.elements.get(container.id)!;
  const block = scopeBlock(laidOut, container);
  const blockLanes = scopeLanes(laidOut, container);

  restoreOutsideScope(previous, laidOut, block, blockLanes);
  translateScope(laidOut, block, blockLanes, {
    x: before.position.x - container.position.x,
    y: before.position.y - container.position.y
  });
  // A size the caller chose is a floor, exactly as it is for a pool in the
  // collaboration policy; a defaulted one is free to grow or shrink to fit.
  if (before.sizeManaged !== true) {
    container.size = {
      width: Math.max(container.size.width, before.size.width),
      height: Math.max(container.size.height, before.size.height)
    };
  }
  syncShapes(laidOut, [...block], [...blockLanes]);

  const displaced = pushOutward(laidOut, container);
  // Only what actually ended up somewhere new is treated as moved. Re-routing
  // a connection whose geometry is unchanged would let the router pick a
  // different equal-cost candidate each run, and a repeated `auto_layout` has
  // to reproduce its own output rather than oscillate between two of them.
  rerouteAroundScope(laidOut, block, movedShapes(previous, laidOut));
  assertScopePlaced(previous, laidOut, container.id);
  return Array.from(displaced).sort();
}

/**
 * The element `scopeId` names, checked against what a scope can mean.
 *
 * Only a container that draws its contents on the plane can be laid out on its
 * own: an expanded subprocess or transaction, or a pool that has a process.
 * A subprocess inside a laned process is refused - the sibling push would have
 * to move flow nodes across lane bands, which is the pool's layout to decide.
 */
function resolveScope(
  previous: BpmnDocument,
  laidOut: BpmnDocument,
  scopeId: string
): BpmnDocumentElement {
  const element = laidOut.elements.get(scopeId);
  if (!element || !previous.elements.has(scopeId)) {
    throw new ScopedLayoutError(
      `Scope ${scopeId} is not in this diagram; scopeId accepts the id of an expanded `
      + 'subprocess or of a pool',
      [scopeId]
    );
  }
  if (element.kind === 'participant') {
    if (!element.processRef) {
      throw new ScopedLayoutError(
        `Scope ${scopeId} is a black-box pool and has no contents to lay out`,
        [scopeId]
      );
    }
    return element;
  }
  if (!CONTAINER_TYPES.has(element.type)) {
    throw new ScopedLayoutError(
      `Scope ${scopeId} is a ${element.type}; scopeId accepts the id of an expanded `
      + 'subprocess or of a pool',
      [scopeId]
    );
  }
  if (element.properties.isExpanded === false) {
    throw new ScopedLayoutError(
      `Scope ${scopeId} is a collapsed subprocess and draws no contents on the plane`,
      [scopeId]
    );
  }
  if (Array.from(laidOut.lanes.values()).some(lane => lane.processId === element.ownerId)) {
    throw new ScopedLayoutError(
      `Scope ${scopeId} sits in a process with lanes; a scoped layout there would have to `
      + 'move flow nodes between lane bands, so lay out the pool instead',
      [scopeId]
    );
  }
  return element;
}

/** The container plus everything drawn inside it, boundary events included. */
function scopeBlock(document: BpmnDocument, container: BpmnDocumentElement): Set<string> {
  const ids = containedElementIds(document, container);
  ids.add(container.id);
  for (const element of document.elements.values()) {
    if (element.type === 'bpmn:BoundaryEvent'
      && element.properties.attachTo === container.id) {
      // A boundary event on the scope's own outline is drawn on the box the
      // ranking sized, so it travels with the block rather than with the plane.
      ids.add(element.id);
    }
  }
  return ids;
}

function containedElementIds(
  document: BpmnDocument,
  container: BpmnDocumentElement
): Set<string> {
  const ids = new Set<string>();
  if (container.kind === 'participant') {
    for (const element of document.elements.values()) {
      if (element.ownerId === container.processRef) ids.add(element.id);
    }
    return ids;
  }
  let frontier = new Set<string>([container.id]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const element of document.elements.values()) {
      if (!frontier.has(element.scopeId) || ids.has(element.id)) continue;
      ids.add(element.id);
      next.add(element.id);
    }
    frontier = next;
  }
  for (const element of document.elements.values()) {
    const host = element.properties.attachTo;
    if (element.type === 'bpmn:BoundaryEvent' && typeof host === 'string' && ids.has(host)) {
      ids.add(element.id);
    }
  }
  return ids;
}

function scopeLanes(document: BpmnDocument, container: BpmnDocumentElement): Set<string> {
  if (container.kind !== 'participant') return new Set();
  return new Set(Array.from(document.lanes.values())
    .filter(lane => lane.processId === container.processRef)
    .map(lane => lane.id));
}

/**
 * Put the rest of the plane back where it was. Everything the ranking moved
 * outside the scope is reverted to the geometry the live document already had,
 * which is what makes this a scoped layout rather than a full reflow.
 */
function restoreOutsideScope(
  previous: BpmnDocument,
  laidOut: BpmnDocument,
  block: Set<string>,
  blockLanes: Set<string>
): void {
  const shapes = shapeIndex(laidOut);
  const previousShapes = shapeIndex(previous);
  for (const element of laidOut.elements.values()) {
    if (block.has(element.id)) continue;
    const before = previous.elements.get(element.id);
    if (!before) continue;
    element.position = { ...before.position };
    element.size = { ...before.size };
    restoreShape(shapes.get(element.id), previousShapes.get(element.id), element);
  }
  for (const lane of laidOut.lanes.values()) {
    if (blockLanes.has(lane.id)) continue;
    const before = previous.lanes.get(lane.id);
    if (!before) continue;
    lane.position = { ...before.position };
    lane.size = { ...before.size };
    restoreShape(shapes.get(lane.id), previousShapes.get(lane.id), lane);
  }

  const edges = edgeIndex(laidOut);
  const previousEdges = edgeIndex(previous);
  for (const connection of laidOut.connections.values()) {
    if (block.has(connection.source) && block.has(connection.target)) continue;
    const before = previous.connections.get(connection.id);
    if (!before) continue;
    connection.waypoints = before.waypoints.map(point => ({ ...point }));
    const edge = edges.get(connection.id);
    if (!edge) continue;
    edge.waypoints = connection.waypoints.map(point => ({ ...point }));
    const previousLabel = previousEdges.get(connection.id)?.labelBounds;
    edge.labelBounds = previousLabel ? { ...previousLabel } : undefined;
  }
}

function restoreShape(
  shape: BpmnShapeModel | undefined,
  previousShape: BpmnShapeModel | undefined,
  element: { position: Position; size: Size }
): void {
  if (!shape) return;
  shape.bounds = boundsOf(element);
  shape.labelBounds = previousShape?.labelBounds ? { ...previousShape.labelBounds } : undefined;
}

/** Move the ranked block back onto the position the container already had. */
function translateScope(
  document: BpmnDocument,
  block: Set<string>,
  blockLanes: Set<string>,
  shift: Position
): void {
  if (shift.x === 0 && shift.y === 0) return;
  const shapes = shapeIndex(document);
  const edges = edgeIndex(document);
  for (const id of block) {
    const element = document.elements.get(id);
    if (element) shiftBox(element, shapes.get(id), shift);
  }
  for (const id of blockLanes) {
    const lane = document.lanes.get(id);
    if (lane) shiftBox(lane, shapes.get(id), shift);
  }
  for (const connection of document.connections.values()) {
    if (!block.has(connection.source) || !block.has(connection.target)) continue;
    connection.waypoints = connection.waypoints.map(
      point => ({ x: point.x + shift.x, y: point.y + shift.y })
    );
    const edge = edges.get(connection.id);
    if (!edge) continue;
    edge.waypoints = connection.waypoints.map(point => ({ ...point }));
    if (edge.labelBounds) {
      edge.labelBounds = {
        ...edge.labelBounds,
        x: edge.labelBounds.x + shift.x,
        y: edge.labelBounds.y + shift.y
      };
    }
  }
}

function shiftBox(
  target: { position: Position; size: Size },
  shape: BpmnShapeModel | undefined,
  shift: Position
): void {
  target.position = { x: target.position.x + shift.x, y: target.position.y + shift.y };
  if (!shape) return;
  shape.bounds = boundsOf(target);
  if (shape.labelBounds) {
    shape.labelBounds = {
      ...shape.labelBounds,
      x: shape.labelBounds.x + shift.x,
      y: shape.labelBounds.y + shift.y
    };
  }
}

/**
 * Clear the resized scope out of its siblings, level by level up the plane.
 *
 * At each level the containers and flow nodes that share the scope's parent
 * are pushed - as rigid bodies, contents and all - right or down, whichever
 * needs the smaller move, until nothing is within the clearance. The parent
 * is then grown around whatever that left it holding and becomes the next
 * level's anchor, which is what keeps a grown subprocess from bursting out of
 * the pool it lives in.
 */
function pushOutward(
  document: BpmnDocument,
  container: BpmnDocumentElement
): Set<string> {
  const displaced = new Set<string>();
  let anchor: BpmnDocumentElement | undefined = container;

  for (let level = 0; anchor && level < SCOPED_LAYOUT_POLICY.maxLevels; level++) {
    const units = siblingUnits(document, anchor);
    separateUnits(document, buildUnit(document, anchor), units);
    for (const unit of units) {
      if (!unit.moved) continue;
      for (const id of unit.elementIds) displaced.add(id);
    }
    const parent = parentContainer(document, anchor);
    if (!parent) break;
    growAround(document, parent);
    anchor = parent;
  }
  return displaced;
}

/** Every shape whose bounds this pass actually changed. */
function movedShapes(previous: BpmnDocument, document: BpmnDocument): Set<string> {
  const moved = new Set<string>();
  for (const target of [...document.elements.values(), ...document.lanes.values()]) {
    const before = previous.elements.get(target.id) ?? previous.lanes.get(target.id);
    if (!before || !sameBounds(boundsOf(before), boundsOf(target))) moved.add(target.id);
  }
  return moved;
}

interface MovableUnit extends Unit {
  moved: boolean;
}

function separateUnits(
  document: BpmnDocument,
  anchor: Unit,
  units: MovableUnit[]
): void {
  if (units.length === 0) return;
  const clearance = SCOPED_LAYOUT_POLICY.clearance;
  for (let pass = 0; pass < SCOPED_LAYOUT_POLICY.maxPushPasses; pass++) {
    let moved = false;
    for (const unit of units) {
      for (const other of [anchor, ...units]) {
        if (other === unit) continue;
        const shift = separationShift(unit.box, other.box, clearance);
        if (!shift) continue;
        translateUnit(document, unit, shift);
        unit.moved = true;
        moved = true;
      }
    }
    // The bound is deliberate: a level that has not settled by now is reported
    // by assertScopePlaced instead of being relaxed forever.
    if (!moved) return;
  }
}

/**
 * The rigid bodies sharing the anchor's parent, each one a container's world.
 *
 * One rule covers both levels: a pool's scope is the collaboration, so the
 * anchor's own scope picks out the other pools and any artifact drawn beside
 * them, and a subprocess's scope picks out the process's other flow nodes.
 */
function siblingUnits(document: BpmnDocument, anchor: BpmnDocumentElement): MovableUnit[] {
  return Array.from(document.elements.values())
    .filter(element => element.scopeId === anchor.scopeId
      && element.id !== anchor.id
      // A boundary event has no position of its own; it moves with its host.
      && element.type !== 'bpmn:BoundaryEvent')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(root => ({ ...buildUnit(document, root), moved: false }));
}

function buildUnit(document: BpmnDocument, root: BpmnDocumentElement): Unit {
  const elementIds = containedElementIds(document, root);
  elementIds.add(root.id);
  for (const element of document.elements.values()) {
    if (element.type === 'bpmn:BoundaryEvent' && element.properties.attachTo === root.id) {
      elementIds.add(element.id);
    }
  }
  const laneIds = scopeLanes(document, root);
  return { elementIds, laneIds, box: unitBox(document, elementIds, laneIds)! };
}

function unitBox(
  document: BpmnDocument,
  elementIds: Set<string>,
  laneIds: Set<string>
): Bounds | undefined {
  const shapes = shapeIndex(document);
  const boxes: Bounds[] = [];
  for (const id of [...elementIds, ...laneIds]) {
    const target = document.elements.get(id) ?? document.lanes.get(id);
    if (target) boxes.push(boundsOf(target));
    const label = shapes.get(id)?.labelBounds;
    if (label) boxes.push({ ...label });
  }
  return unionOf(boxes);
}

function translateUnit(document: BpmnDocument, unit: MovableUnit, shift: Position): void {
  const shapes = shapeIndex(document);
  const edges = edgeIndex(document);
  for (const id of unit.elementIds) {
    const element = document.elements.get(id);
    if (element) shiftBox(element, shapes.get(id), shift);
  }
  for (const id of unit.laneIds) {
    const lane = document.lanes.get(id);
    if (lane) shiftBox(lane, shapes.get(id), shift);
  }
  for (const connection of document.connections.values()) {
    if (!unit.elementIds.has(connection.source) || !unit.elementIds.has(connection.target)) {
      continue;
    }
    connection.waypoints = connection.waypoints.map(
      point => ({ x: point.x + shift.x, y: point.y + shift.y })
    );
    const edge = edges.get(connection.id);
    if (!edge) continue;
    edge.waypoints = connection.waypoints.map(point => ({ ...point }));
    if (edge.labelBounds) {
      edge.labelBounds = {
        ...edge.labelBounds,
        x: edge.labelBounds.x + shift.x,
        y: edge.labelBounds.y + shift.y
      };
    }
  }
  unit.box = { ...unit.box, x: unit.box.x + shift.x, y: unit.box.y + shift.y };
}

/** The container the element is drawn inside, or undefined on the plane. */
function parentContainer(
  document: BpmnDocument,
  element: BpmnDocumentElement
): BpmnDocumentElement | undefined {
  if (element.kind === 'participant') return undefined;
  const scope = document.elements.get(element.scopeId);
  if (scope && scope.id !== element.id) return scope;
  return Array.from(document.elements.values()).find(
    candidate => candidate.kind === 'participant' && candidate.processRef === element.ownerId
  );
}

/** Grow a container around what it now holds. Containers are never shrunk here. */
function growAround(document: BpmnDocument, parent: BpmnDocumentElement): void {
  const contents = containedElementIds(document, parent);
  const box = unitBox(document, contents, scopeLanes(document, parent));
  if (!box) return;
  const padding = SCOPED_LAYOUT_POLICY.containerPadding;
  const left = Math.min(parent.position.x, box.x - padding);
  const top = Math.min(parent.position.y, box.y - padding);
  const right = Math.max(parent.position.x + parent.size.width, box.x + box.width + padding);
  const bottom = Math.max(parent.position.y + parent.size.height, box.y + box.height + padding);
  parent.position = { x: left, y: top };
  parent.size = { width: right - left, height: bottom - top };
  syncShapes(document, [parent.id], []);
}

/**
 * Route the connections the merge invalidated: the ones that touch something
 * that moved, and the ones whose old route now runs through a box that grew.
 * Routes drawn entirely inside the scope came from the ranking and are kept.
 */
function rerouteAroundScope(
  document: BpmnDocument,
  block: Set<string>,
  moved: Set<string>
): void {
  if (moved.size === 0) return;
  const boxes = Array.from(moved, id => {
    const target = document.elements.get(id) ?? document.lanes.get(id);
    return target ? boundsOf(target) : undefined;
  }).filter((box): box is Bounds => box !== undefined);
  const router = new ConnectionRouter();
  const shapes = Array.from(document.diagram.shapes.values());
  const edges = Array.from(document.diagram.edges.values());
  const edgesByConnection = edgeIndex(document);

  for (const connection of document.connections.values()) {
    if (block.has(connection.source) && block.has(connection.target)) continue;
    const touched = moved.has(connection.source) || moved.has(connection.target);
    if (!touched && !routeCrosses(connection.waypoints, boxes)) continue;
    if (!edgesByConnection.has(connection.id)) continue;
    let candidates;
    try {
      candidates = router.route(document, connection.id, {
        avoidElementIds: [],
        avoidConnectionIds: [],
        clearance: SCOPED_LAYOUT_POLICY.clearance,
        maxCandidates: 1_024,
        shapes,
        edges
      });
    } catch {
      // An unrenderable connection keeps whatever route it has; shape
      // separation, not routing, is what this pass refuses to get wrong.
      continue;
    }
    const selected = candidates.find(candidate => candidate.diagnostics.length === 0)
      ?? candidates.find(
        candidate => candidate.diagnostics.every(item => item.severity !== 'error')
      )
      ?? candidates[0];
    if (!selected) continue;
    connection.waypoints = selected.waypoints.map(point => ({ ...point }));
    const edge = edgesByConnection.get(connection.id)!;
    edge.waypoints = connection.waypoints.map(point => ({ ...point }));
    if (selected.labelBounds) edge.labelBounds = { ...selected.labelBounds };
  }
}

function routeCrosses(waypoints: Position[], boxes: Bounds[]): boolean {
  for (let index = 0; index < waypoints.length - 1; index++) {
    const start = waypoints[index];
    const end = waypoints[index + 1];
    const segment = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
    if (boxes.some(box => overlaps(segment, box))) return true;
  }
  return false;
}

/**
 * Nothing this pass moved may be left overlapping, or outside the container
 * that owns it. The checks mirror the geometry oracle's SHAPE_OVERLAP,
 * LABEL_OVERLAP and CONTAINMENT_FAILURE rules, so a merge the oracle would
 * reject is refused here instead - before anything is committed.
 *
 * Only pairs this pass touched are checked. A diagram that already overlapped
 * itself is the caller's, not the scoped layout's, and refusing to lay out a
 * subprocess because of it would help nobody.
 */
function assertScopePlaced(
  previous: BpmnDocument,
  document: BpmnDocument,
  scopeId: string
): void {
  const ancestors = ancestorIndex(document);
  const shapes = shapeIndex(document);
  const boxed = [
    ...Array.from(document.elements.values()),
    ...Array.from(document.lanes.values())
  ].filter(target => shapes.has(target.id));
  const changed = new Set(boxed
    .filter(target => {
      const before = previous.elements.get(target.id) ?? previous.lanes.get(target.id);
      return !before || !sameBounds(boundsOf(before), boundsOf(target));
    })
    .map(target => target.id));
  const refuse = (message: string, ids: string[]): never => {
    throw new ScopedLayoutError(
      `Auto-layout could not lay out ${scopeId} on its own: ${message}`,
      [...ids].sort()
    );
  };

  for (let left = 0; left < boxed.length; left++) {
    for (let right = left + 1; right < boxed.length; right++) {
      const one = boxed[left];
      const other = boxed[right];
      if (!changed.has(one.id) && !changed.has(other.id)) continue;
      if (relatedShapes(document, ancestors, one.id, other.id)) continue;
      if (overlaps(boundsOf(one), boundsOf(other))) {
        refuse(`${one.id} and ${other.id} cannot both be placed`, [one.id, other.id]);
      }
    }
  }

  for (const target of boxed) {
    // A boundary event is drawn straddling its host's outline, so the oracle
    // exempts it from containment and so does this pass.
    if (document.elements.get(target.id)?.type === 'bpmn:BoundaryEvent') continue;
    for (const ancestorId of ancestors.get(target.id) ?? []) {
      if (!changed.has(target.id) && !changed.has(ancestorId)) continue;
      const ancestor = document.elements.get(ancestorId) ?? document.lanes.get(ancestorId);
      if (!ancestor || !shapes.has(ancestorId)) continue;
      if (!contains(boundsOf(ancestor), boundsOf(target))) {
        refuse(`${target.id} no longer fits inside ${ancestorId}`, [target.id, ancestorId]);
      }
    }
  }

  for (const [id, shape] of shapes) {
    const label = shape.labelBounds;
    if (!label) continue;
    for (const target of boxed) {
      if (target.id === id
        || (!changed.has(id) && !changed.has(target.id))
        || relatedShapes(document, ancestors, id, target.id)) continue;
      if (overlaps(label, boundsOf(target))) {
        refuse(`the label for ${id} overlaps ${target.id}`, [id, target.id]);
      }
    }
  }
}

/** Containers, pools and lane bands a shape is drawn inside, by shape id. */
function ancestorIndex(document: BpmnDocument): Map<string, Set<string>> {
  const laneByMember = new Map<string, BpmnLane>();
  for (const lane of document.lanes.values()) {
    for (const memberId of lane.flowNodeRefs) laneByMember.set(memberId, lane);
  }
  const participantByProcess = new Map<string, string>();
  for (const element of document.elements.values()) {
    if (element.kind === 'participant' && element.processRef) {
      participantByProcess.set(element.processRef, element.id);
    }
  }

  const index = new Map<string, Set<string>>();
  const collect = (id: string, ownerId: string, scopeId: string): Set<string> => {
    const found = new Set<string>();
    let current = scopeId;
    for (let depth = 0; depth < SCOPED_LAYOUT_POLICY.maxLevels && current !== id; depth++) {
      const container = document.elements.get(current);
      if (!container) break;
      found.add(container.id);
      if (container.kind === 'participant') break;
      current = container.scopeId;
    }
    const pool = participantByProcess.get(ownerId);
    if (pool && pool !== id) found.add(pool);
    const lane = laneByMember.get(id);
    if (lane) found.add(lane.id);
    return found;
  };
  for (const element of document.elements.values()) {
    const found = collect(element.id, element.ownerId, element.scopeId);
    const host = element.properties.attachTo;
    const hostElement = typeof host === 'string' ? document.elements.get(host) : undefined;
    if (element.type === 'bpmn:BoundaryEvent' && hostElement) {
      // A boundary event straddles its host's outline, so it is drawn in
      // whatever the host is drawn in, lane band included.
      for (const id of collect(hostElement.id, hostElement.ownerId, hostElement.scopeId)) {
        found.add(id);
      }
    }
    index.set(element.id, found);
  }
  for (const lane of document.lanes.values()) {
    const found = new Set<string>();
    const pool = participantByProcess.get(lane.processId);
    if (pool) found.add(pool);
    index.set(lane.id, found);
  }
  return index;
}

/** Two shapes that are allowed to overlap: nested, attached, or host and band. */
function relatedShapes(
  document: BpmnDocument,
  ancestors: Map<string, Set<string>>,
  left: string,
  right: string
): boolean {
  if (left === right) return true;
  if (ancestors.get(left)?.has(right) || ancestors.get(right)?.has(left)) return true;
  const one = document.elements.get(left);
  const other = document.elements.get(right);
  return one?.properties.attachTo === right || other?.properties.attachTo === left;
}

function syncShapes(document: BpmnDocument, elementIds: string[], laneIds: string[]): void {
  const shapes = shapeIndex(document);
  for (const id of [...elementIds, ...laneIds]) {
    const target = document.elements.get(id) ?? document.lanes.get(id);
    const shape = shapes.get(id);
    if (target && shape) shape.bounds = boundsOf(target);
  }
}

/**
 * The shortest move right or down that takes `subject` out of `obstacle`'s
 * clearance, or undefined when it is already clear of it.
 *
 * Only those two directions are offered, and that is what makes the push
 * terminate. A scope keeps its top-left corner and grows right and down from
 * it, so every sibling it newly covers is clear of it again as soon as it
 * passes the new right or bottom edge - and a container grown around a pushed
 * sibling can only grow the same two ways. Every displacement therefore
 * increases a coordinate, and nothing can be pushed back into what it just
 * left.
 */
function separationShift(
  subject: Bounds,
  obstacle: Bounds,
  clearance: number
): Position | undefined {
  const grown = {
    x: obstacle.x - clearance,
    y: obstacle.y - clearance,
    width: obstacle.width + 2 * clearance,
    height: obstacle.height + 2 * clearance
  };
  if (!overlaps(subject, grown)) return undefined;
  const right = grown.x + grown.width - subject.x;
  const down = grown.y + grown.height - subject.y;
  return right <= down ? { x: right, y: 0 } : { x: 0, y: down };
}

function shapeIndex(document: BpmnDocument): Map<string, BpmnShapeModel> {
  return new Map(
    Array.from(document.diagram.shapes.values(), shape => [shape.elementId, shape])
  );
}

function edgeIndex(document: BpmnDocument): Map<string, BpmnEdgeModel> {
  return new Map(
    Array.from(document.diagram.edges.values(), edge => [edge.connectionId, edge])
  );
}

function boundsOf(target: { position: Position; size: Size }): Bounds {
  return { ...target.position, ...target.size };
}

function unionOf(boxes: Bounds[]): Bounds | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map(box => box.x));
  const top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function overlaps(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function sameBounds(left: Bounds, right: Bounds): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function contains(parent: Bounds, child: Bounds): boolean {
  return child.x >= parent.x
    && child.y >= parent.y
    && child.x + child.width <= parent.x + parent.width
    && child.y + child.height <= parent.y + parent.height;
}
