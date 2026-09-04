import type {
  BpmnDocument,
  BpmnDocumentElement,
  Position,
  Size
} from '../../types/index.js';

/**
 * Reading direction a caller can ask `auto_layout` for.
 *
 * The layout engine itself only ranks left to right. A top-to-bottom diagram is
 * the same ranking reflected across the diagonal, which is why the two are
 * expressed as one orientation switch rather than two algorithms.
 */
export type LayoutOrientation = 'left-to-right' | 'top-to-bottom';

export const LAYOUT_ORIENTATIONS: readonly LayoutOrientation[] = [
  'left-to-right',
  'top-to-bottom'
];

type Bounds = Position & Size;

/** Containers are reflected whole so everything inside stays inside. */
const CONTAINER_TYPES = new Set(['bpmn:SubProcess', 'bpmn:Transaction']);

function isContainer(element: BpmnDocumentElement): boolean {
  if (element.kind === 'participant') return true;
  return CONTAINER_TYPES.has(element.type) && element.properties.isExpanded !== false;
}

/** Reflect a rectangle across the diagonal, rotating it with the plane. */
function reflectBounds(bounds: Bounds): Bounds {
  return {
    x: bounds.y,
    y: bounds.x,
    width: bounds.height,
    height: bounds.width
  };
}

/**
 * Move a rectangle to the reflected position of its centre while keeping its
 * own proportions. A task stays 100x80 in a top-to-bottom diagram; only where
 * it sits changes.
 */
function reflectCentre(bounds: Bounds): Bounds {
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  return {
    x: centreY - bounds.width / 2,
    y: centreX - bounds.height / 2,
    width: bounds.width,
    height: bounds.height
  };
}

function reflectPoint(point: Position): Position {
  return { x: point.y, y: point.x };
}

/**
 * Pull an edge endpoint back onto its shape's border.
 *
 * Reflection is exact for squares and for containers, which rotate with the
 * plane, but a task keeps its proportions, so its dock point can end up just
 * outside the border. The endpoint is projected along the axis of its own first
 * segment, which leaves that segment orthogonal. Returns false when the
 * endpoint sits beside the shape rather than in front of it, where no
 * projection preserves the route.
 */
function redockEndpoint(waypoints: Position[], bounds: Bounds, atStart: boolean): boolean {
  const index = atStart ? 0 : waypoints.length - 1;
  const neighbour = atStart ? waypoints[1] : waypoints[waypoints.length - 2];
  const point = waypoints[index];
  const horizontalRun = Math.abs(neighbour.x - point.x);
  const verticalRun = Math.abs(neighbour.y - point.y);
  if (horizontalRun === 0 && verticalRun === 0) return true;

  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;

  if (horizontalRun >= verticalRun) {
    if (point.y < top || point.y > bottom) return false;
    waypoints[index] = { x: neighbour.x > point.x ? right : left, y: point.y };
    return true;
  }
  if (point.x < left || point.x > right) return false;
  waypoints[index] = { x: point.x, y: neighbour.y > point.y ? bottom : top };
  return true;
}

/** A straight dock used when a reflected route can no longer be repaired. */
function straightRoute(source: Bounds, target: Bounds): Position[] {
  const sourceCentre = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCentre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const vertical = Math.abs(targetCentre.y - sourceCentre.y)
    >= Math.abs(targetCentre.x - sourceCentre.x);
  return vertical
    ? [
      { x: sourceCentre.x, y: targetCentre.y > sourceCentre.y ? source.y + source.height : source.y },
      { x: targetCentre.x, y: targetCentre.y > sourceCentre.y ? target.y : target.y + target.height }
    ]
    : [
      { x: targetCentre.x > sourceCentre.x ? source.x + source.width : source.x, y: sourceCentre.y },
      { x: targetCentre.x > sourceCentre.x ? target.x : target.x + target.width, y: targetCentre.y }
    ];
}

function elementBounds(element: { position: Position; size: Size }): Bounds {
  return {
    x: element.position.x,
    y: element.position.y,
    width: element.size.width,
    height: element.size.height
  };
}

function assignBounds(element: { position: Position; size: Size }, bounds: Bounds): void {
  element.position = { x: bounds.x, y: bounds.y };
  element.size = { width: bounds.width, height: bounds.height };
}

/**
 * Turn a left-to-right layout into a top-to-bottom one in place.
 *
 * Every coordinate is reflected across the diagonal: containers, pools and
 * lanes rotate with the plane so their contents stay inside them and pools
 * become vertical bands, while ordinary shapes and labels keep their own
 * proportions and only move. Edge endpoints are then re-docked onto the shape
 * borders they now face.
 */
export function transposeDocumentGeometry(document: BpmnDocument): void {
  for (const element of document.elements.values()) {
    const bounds = elementBounds(element);
    assignBounds(element, isContainer(element) ? reflectBounds(bounds) : reflectCentre(bounds));
  }
  for (const lane of document.lanes.values()) {
    assignBounds(lane, reflectBounds(elementBounds(lane)));
  }

  for (const connection of document.connections.values()) {
    const source = document.elements.get(connection.source);
    const target = document.elements.get(connection.target);
    const reflected = connection.waypoints.map(reflectPoint);
    if (!source || !target || reflected.length < 2) {
      connection.waypoints = reflected;
      continue;
    }

    const sourceBounds = elementBounds(source);
    const targetBounds = elementBounds(target);
    const repaired = redockEndpoint(reflected, sourceBounds, true)
      && redockEndpoint(reflected, targetBounds, false);
    connection.waypoints = repaired ? reflected : straightRoute(sourceBounds, targetBounds);
  }

  for (const shape of document.diagram.shapes.values()) {
    const element = document.elements.get(shape.elementId);
    const lane = document.lanes.get(shape.elementId);
    if (element) {
      shape.bounds = elementBounds(element);
    } else if (lane) {
      shape.bounds = elementBounds(lane);
    } else {
      shape.bounds = reflectCentre(shape.bounds);
    }
    if (shape.labelBounds) {
      shape.labelBounds = reflectCentre(shape.labelBounds);
    }
    // A pool laid out as a horizontal band becomes a vertical one, and BPMN DI
    // records that on the shape rather than inferring it from the geometry.
    if (element?.kind === 'participant' || lane) {
      shape.isHorizontal = shape.isHorizontal === false;
    }
  }

  for (const edge of document.diagram.edges.values()) {
    const connection = document.connections.get(edge.connectionId);
    edge.waypoints = connection
      ? connection.waypoints.map(point => ({ ...point }))
      : edge.waypoints.map(reflectPoint);
    if (edge.labelBounds) {
      edge.labelBounds = reflectCentre(edge.labelBounds);
    }
  }
}
