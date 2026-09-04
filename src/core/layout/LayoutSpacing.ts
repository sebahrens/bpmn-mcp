import type {
  BpmnDocument,
  BpmnDocumentElement,
  Position,
  Size
} from '../../types/index.js';

type Bounds = Position & Size;

/** What `spacing` may be asked for, as a multiple of the layout's own gaps. */
export const LAYOUT_SPACING_LIMITS = Object.freeze({ minimum: 0.5, maximum: 4 });

/** Neutral spacing: the ranked layout's gaps are used exactly as produced. */
export const DEFAULT_LAYOUT_SPACING = 1;

/** Containers hold the gaps rather than sitting between them, so they stretch. */
const CONTAINER_TYPES = new Set(['bpmn:SubProcess', 'bpmn:Transaction']);

export function assertLayoutSpacing(spacing: number): void {
  if (!Number.isFinite(spacing)
    || spacing < LAYOUT_SPACING_LIMITS.minimum
    || spacing > LAYOUT_SPACING_LIMITS.maximum) {
    throw new Error(
      `Layout spacing must be a number between ${LAYOUT_SPACING_LIMITS.minimum} `
      + `and ${LAYOUT_SPACING_LIMITS.maximum}`
    );
  }
}

/**
 * Widen (or tighten) the gaps a ranked layout left between its ranks.
 *
 * bpmn-auto-layout's `layoutProcess(xml)` takes no options at all, so the gaps
 * it produces are fixed. They are stretched afterwards instead, by rebuilding
 * the plane through a monotone coordinate map: the map runs at slope 1 across
 * every band some shape occupies and at `spacing` across every band nothing
 * occupies, independently per axis.
 *
 * Working that way rather than by moving each rank is what keeps the result
 * connected. A shape's own span is occupied, so it is translated and never
 * stretched; a boundary event overlaps its host's span, so the two shift by the
 * same amount and stay attached; and every waypoint is mapped by the same
 * function as the border it is docked to, so endpoints stay exactly on their
 * shapes and orthogonal segments stay orthogonal. Containers - pools, lanes and
 * expanded subprocesses - are mapped edge to edge instead, so they grow around
 * the extra room their contents now take.
 */
export function applyLayoutSpacing(document: BpmnDocument, spacing: number): void {
  assertLayoutSpacing(spacing);
  if (spacing === DEFAULT_LAYOUT_SPACING) return;

  const content = Array.from(document.elements.values())
    .filter(element => !isLayoutContainer(element))
    .map(elementBounds);
  if (content.length === 0) return;

  const mapX = axisMap(content.map(bounds => [bounds.x, bounds.x + bounds.width]), spacing);
  const mapY = axisMap(content.map(bounds => [bounds.y, bounds.y + bounds.height]), spacing);
  const stretch = (bounds: Bounds): Bounds => ({
    x: mapX(bounds.x),
    y: mapY(bounds.y),
    width: mapX(bounds.x + bounds.width) - mapX(bounds.x),
    height: mapY(bounds.y + bounds.height) - mapY(bounds.y)
  });
  // A label is not part of the occupancy, so mapping its edges could stretch
  // it. Its centre is carried instead and the text keeps the box it needs.
  const move = (bounds: Bounds): Bounds => ({
    x: mapX(bounds.x + bounds.width / 2) - bounds.width / 2,
    y: mapY(bounds.y + bounds.height / 2) - bounds.height / 2,
    width: bounds.width,
    height: bounds.height
  });

  for (const element of document.elements.values()) {
    assignBounds(element, stretch(elementBounds(element)));
  }
  for (const lane of document.lanes.values()) {
    assignBounds(lane, stretch(elementBounds(lane)));
  }
  for (const connection of document.connections.values()) {
    connection.waypoints = connection.waypoints.map(
      point => ({ x: mapX(point.x), y: mapY(point.y) })
    );
  }
  for (const shape of document.diagram.shapes.values()) {
    const element = document.elements.get(shape.elementId)
      ?? document.lanes.get(shape.elementId);
    shape.bounds = element ? elementBounds(element) : stretch(shape.bounds);
    if (shape.labelBounds) shape.labelBounds = move(shape.labelBounds);
  }
  for (const edge of document.diagram.edges.values()) {
    const connection = document.connections.get(edge.connectionId);
    edge.waypoints = connection
      ? connection.waypoints.map(point => ({ ...point }))
      : edge.waypoints.map(point => ({ x: mapX(point.x), y: mapY(point.y) }));
    if (edge.labelBounds) edge.labelBounds = move(edge.labelBounds);
  }
}

/**
 * A monotone piecewise-linear map along one axis: slope 1 inside the merged
 * occupied spans, slope `factor` in the empty stretches between them, and
 * slope 1 outside the content altogether so the diagram does not drift away
 * from its origin.
 */
function axisMap(spans: Array<[number, number]>, factor: number): (value: number) => number {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  // One breakpoint per gap: the offset every coordinate past it inherits.
  const gaps = merged.slice(1).map(([start], index) => ({
    start: merged[index][1],
    end: start
  }));
  return (value: number): number => {
    let offset = 0;
    for (const gap of gaps) {
      if (value <= gap.start) break;
      offset += (Math.min(value, gap.end) - gap.start) * (factor - 1);
    }
    return value + offset;
  };
}

function isLayoutContainer(element: BpmnDocumentElement): boolean {
  if (element.kind === 'participant') return true;
  return CONTAINER_TYPES.has(element.type) && element.properties.isExpanded !== false;
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
