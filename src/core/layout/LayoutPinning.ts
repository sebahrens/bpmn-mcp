import type {
  BpmnDocument,
  BpmnDocumentElement,
  Position,
  Size
} from '../../types/index.js';
import { ConnectionRouter } from './ConnectionRouter.js';

type Bounds = Position & Size;

interface OwnedBounds extends Bounds {
  ownerId: string;
}

/** Separation the repair pass opens up, matching the geometry oracle's default. */
const PIN_CLEARANCE = 20;

/** Bounded so a diagram that cannot be repaired fails fast instead of spinning. */
const MAX_REPAIR_PASSES = 32;

const CONTAINER_TYPES = new Set(['bpmn:SubProcess', 'bpmn:Transaction']);

export class LayoutPinningError extends Error {
  readonly code = 'PIN_NOT_APPLIED';

  constructor(message: string, readonly elementIds: string[] = []) {
    super(message);
    this.name = 'LayoutPinningError';
  }
}

/**
 * Keep hand-placed elements where the caller put them.
 *
 * The layout engine accepts no fixed positions, so the ranked result is
 * produced first and the pinned elements are then put back at the bounds they
 * had before it ran. That collides with whatever the ranking moved into their
 * place, so the elements the ranking is free to move are pushed clear, and the
 * connections touching anything that moved are routed again.
 *
 * The pass then checks its own work and throws rather than committing a
 * diagram it could not separate: a pin that cannot be honoured is reported to
 * the caller, never quietly dropped and never turned into overlapping shapes.
 *
 * @returns the ids of the elements the repair pass had to displace.
 */
export function applyPinnedElements(
  previous: BpmnDocument,
  laidOut: BpmnDocument,
  pinnedElementIds: string[]
): string[] {
  const pinned = resolvePinnedElements(previous, laidOut, pinnedElementIds);
  if (pinned.size === 0) return [];

  for (const id of pinned) {
    const before = previous.elements.get(id)!;
    const after = laidOut.elements.get(id)!;
    after.position = { ...before.position };
    after.size = { ...before.size };
    const shape = shapeFor(laidOut, id);
    const previousShape = shapeFor(previous, id);
    if (shape) {
      shape.bounds = { ...after.position, ...after.size };
      shape.labelBounds = previousShape?.labelBounds
        ? { ...previousShape.labelBounds }
        : undefined;
    }
  }

  const displaced = repairAroundPins(laidOut, pinned);
  syncShapeBounds(laidOut, displaced);
  assertSeparated(laidOut);
  rerouteTouchedConnections(laidOut, new Set([...pinned, ...displaced]));
  return Array.from(displaced).sort();
}

/**
 * The elements whose bounds are kept, checked against what pinning can mean.
 *
 * A container is refused: its ranked contents would be left outside a box the
 * caller chose. A boundary event is drawn on its host's outline and has no
 * position of its own, so it follows the host - pinned when the host is,
 * dropped from the set when it is not.
 */
function resolvePinnedElements(
  previous: BpmnDocument,
  laidOut: BpmnDocument,
  pinnedElementIds: string[]
): Set<string> {
  if (laidOut.collaborations.has(laidOut.diagram.planeElementId)) {
    throw new LayoutPinningError(
      'Pinned elements are not supported in a collaboration: pools, lanes and their '
      + 'contents are repositioned as a block by the collaboration layout policy',
      [...pinnedElementIds]
    );
  }
  const pinned = new Set<string>();
  for (const id of pinnedElementIds) {
    const element = laidOut.elements.get(id);
    if (!element || !previous.elements.has(id)) {
      throw new LayoutPinningError(`Pinned element ${id} is not in this diagram`, [id]);
    }
    if (isContainer(element)) {
      throw new LayoutPinningError(
        `Pinned element ${id} is a container; auto_layout can only pin flow nodes and artifacts`,
        [id]
      );
    }
    if (element.type === 'bpmn:BoundaryEvent') continue;
    pinned.add(id);
  }
  for (const element of laidOut.elements.values()) {
    if (element.type !== 'bpmn:BoundaryEvent') continue;
    const host = element.properties.attachTo;
    if (typeof host === 'string' && pinned.has(host) && previous.elements.has(element.id)) {
      pinned.add(element.id);
    }
  }
  return pinned;
}

/**
 * Push the elements the layout may still move out of the pinned ones, along
 * whichever axis needs the smaller displacement, until nothing is within the
 * clearance any more.
 */
function repairAroundPins(document: BpmnDocument, pinned: Set<string>): Set<string> {
  const movable = Array.from(document.elements.values())
    .filter(element => !isContainer(element) && !pinned.has(element.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fixed = Array.from(pinned, id => document.elements.get(id)!);
  const displaced = new Set<string>();

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    let moved = false;
    for (const element of movable) {
      for (const other of [...fixed, ...movable]) {
        if (other.id === element.id || attachedToEachOther(element, other)) continue;
        const shift = separationShift(bounds(element), bounds(other), PIN_CLEARANCE);
        if (!shift) continue;
        translate(document, element, shift);
        displaced.add(element.id);
        moved = true;
      }
    }
    if (!moved) return displaced;
  }
  return displaced;
}

/**
 * The shortest move that takes `subject` out of `obstacle`'s clearance, or
 * undefined when it is already clear of it.
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
  const left = subject.x + subject.width - grown.x;
  const down = grown.y + grown.height - subject.y;
  const up = subject.y + subject.height - grown.y;
  const horizontal = right <= left ? right : -left;
  const vertical = down <= up ? down : -up;
  return Math.abs(horizontal) <= Math.abs(vertical)
    ? { x: horizontal, y: 0 }
    : { x: 0, y: vertical };
}

/**
 * Nothing may be left overlapping - not a shape, and not a label, which the
 * geometry oracle reads as a collision just the same.
 */
function assertSeparated(document: BpmnDocument): void {
  const rectangles: OwnedBounds[] = [];
  for (const element of document.elements.values()) {
    if (isContainer(element)) continue;
    rectangles.push({ ownerId: element.id, ...bounds(element) });
    const label = shapeFor(document, element.id)?.labelBounds;
    if (label) rectangles.push({ ownerId: element.id, ...label });
  }
  for (let left = 0; left < rectangles.length; left++) {
    for (let right = left + 1; right < rectangles.length; right++) {
      const first = rectangles[left];
      const second = rectangles[right];
      if (first.ownerId === second.ownerId || !overlaps(first, second)) continue;
      const one = document.elements.get(first.ownerId)!;
      const other = document.elements.get(second.ownerId)!;
      if (attachedToEachOther(one, other)) continue;
      throw new LayoutPinningError(
        `Auto-layout could not honour the pinned elements: ${first.ownerId} and `
        + `${second.ownerId} cannot both be placed`,
        [first.ownerId, second.ownerId].sort()
      );
    }
  }
}

/**
 * Route every connection that touches something the pass moved. A route the
 * router cannot draw without crossing a shape is a failed pin, not a diagram
 * to commit.
 */
function rerouteTouchedConnections(document: BpmnDocument, moved: Set<string>): void {
  const router = new ConnectionRouter();
  const edgesByConnection = new Map(
    Array.from(document.diagram.edges.values(), edge => [edge.connectionId, edge])
  );
  for (const connection of document.connections.values()) {
    if (!moved.has(connection.source) && !moved.has(connection.target)) continue;
    const edge = edgesByConnection.get(connection.id);
    if (!edge) continue;
    const candidates = router.route(document, connection.id, {
      avoidElementIds: [],
      avoidConnectionIds: [],
      clearance: PIN_CLEARANCE
    });
    const selected = candidates.find(candidate => candidate.diagnostics.length === 0)
      ?? candidates.find(candidate =>
        candidate.diagnostics.every(item => item.severity !== 'error'))
      ?? candidates[0];
    if (!selected) continue;
    if (selected.diagnostics.some(item => item.severity === 'error')) {
      throw new LayoutPinningError(
        `Auto-layout could not honour the pinned elements: no clear route is left for `
        + `${connection.id}`,
        [connection.id, connection.source, connection.target]
      );
    }
    connection.waypoints = selected.waypoints.map(point => ({ ...point }));
    edge.waypoints = connection.waypoints.map(point => ({ ...point }));
    if (selected.labelBounds) edge.labelBounds = { ...selected.labelBounds };
  }
}

function syncShapeBounds(document: BpmnDocument, elementIds: Set<string>): void {
  for (const id of elementIds) {
    const element = document.elements.get(id);
    const shape = shapeFor(document, id);
    if (element && shape) shape.bounds = bounds(element);
  }
}

function translate(
  document: BpmnDocument,
  element: BpmnDocumentElement,
  shift: Position
): void {
  element.position = { x: element.position.x + shift.x, y: element.position.y + shift.y };
  const shape = shapeFor(document, element.id);
  if (shape?.labelBounds) {
    shape.labelBounds = {
      ...shape.labelBounds,
      x: shape.labelBounds.x + shift.x,
      y: shape.labelBounds.y + shift.y
    };
  }
  for (const attached of document.elements.values()) {
    if (attached.type === 'bpmn:BoundaryEvent' && attached.properties.attachTo === element.id) {
      translate(document, attached, shift);
    }
  }
}

function attachedToEachOther(left: BpmnDocumentElement, right: BpmnDocumentElement): boolean {
  return left.properties.attachTo === right.id || right.properties.attachTo === left.id;
}

function isContainer(element: BpmnDocumentElement): boolean {
  if (element.kind === 'participant') return true;
  return CONTAINER_TYPES.has(element.type) && element.properties.isExpanded !== false;
}

function shapeFor(document: BpmnDocument, elementId: string) {
  return Array.from(document.diagram.shapes.values()).find(
    shape => shape.elementId === elementId
  );
}

function bounds(element: { position: Position; size: Size }): Bounds {
  return { ...element.position, ...element.size };
}

function overlaps(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}
