import type {
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnEdgeModel,
  BpmnShapeModel,
  Position,
  Size
} from '../../types/index.js';
import type { GeometryDiagnostic } from '../BpmnGeometry.js';

type Bounds = Position & Size;
type Side = 'top' | 'right' | 'bottom' | 'left';

export interface ConnectionRouteScoreBreakdown {
  shapeCollisions: number;
  labelCollisions: number;
  clearanceFailures: number;
  connectionCrossings: number;
  bends: number;
  length: number;
  total: number;
}

export interface ConnectionRouteCandidate {
  waypoints: Position[];
  labelBounds?: Bounds;
  score: ConnectionRouteScoreBreakdown;
  diagnostics: GeometryDiagnostic[];
}

export interface ConnectionRouteOptions {
  avoidElementIds: string[];
  avoidConnectionIds: string[];
  clearance: number;
  maxCandidates?: number;
  maxCoordinate?: number;
  /** Internal indexed DI snapshots used by collaboration auto-layout. */
  shapes?: BpmnShapeModel[];
  /** Internal indexed DI snapshots used by collaboration auto-layout. */
  edges?: BpmnEdgeModel[];
}

interface IdentifiedBounds extends Bounds {
  id: string;
}

interface RouteContacts {
  shapeCollisions: Set<string>;
  clearanceFailures: Set<string>;
  connectionCrossings: Set<string>;
}

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const CONTAINER_TYPES = new Set(['bpmn:Participant', 'bpmn:Lane']);

/**
 * Generate and rank deterministic orthogonal routes for one rendered BPMN edge.
 * The router is deliberately side-effect free so auto-layout, proposal tools,
 * and future geometry operations can share the same candidate generation.
 */
export class ConnectionRouter {
  route(
    document: BpmnDocument,
    connectionId: string,
    options: ConnectionRouteOptions
  ): ConnectionRouteCandidate[] {
    const connection = document.connections.get(connectionId);
    if (!connection) throw new Error(`Connection ${connectionId} not found`);
    const diagramShapes = options.shapes ?? Array.from(document.diagram.shapes.values());
    const diagramEdges = options.edges ?? Array.from(document.diagram.edges.values());
    const shapesByElement = new Map(diagramShapes.map(shape => [shape.elementId, shape]));
    const edgesByConnection = new Map(diagramEdges.map(edge => [edge.connectionId, edge]));
    const edge = edgesByConnection.get(connectionId);
    if (!edge) throw new Error(`Rendered connection ${connectionId} has no BPMNEdge`);
    const source = shapesByElement.get(connection.source);
    const target = shapesByElement.get(connection.target);
    if (!source || !target) {
      throw new Error(
        `Connection ${connectionId} requires rendered source and target BPMNShapes`
      );
    }
    assertAvoidLists(connection, options, shapesByElement, edgesByConnection);

    const allShapeBounds = diagramShapes
      .map(shape => ({ id: shape.elementId, ...currentShapeBounds(document, shape) }));
    const shapes = diagramShapes
      .filter(shape => !isCrossableContainer(document, shape))
      .map(shape => ({ id: shape.elementId, ...currentShapeBounds(document, shape) }));
    const otherEdges = diagramEdges
      .filter(candidate => candidate.connectionId !== connectionId);
    const labelObstacles = labelObstacleBounds(diagramShapes, diagramEdges, connectionId);
    const maxCoordinate = options.maxCoordinate ?? Number.POSITIVE_INFINITY;
    const routes = routeCandidates(
      currentShapeBounds(document, source),
      currentShapeBounds(document, target),
      shapes,
      options.clearance,
      options.maxCandidates ?? 256,
      maxCoordinate
    );

    const consideredRoutes = routes.length > 0
      ? routes
      : [compactRoute(edge.waypoints.map(point => ({ ...point })))];
    return consideredRoutes.map(waypoints => {
      const labelBounds = placeConnectionLabel(
        connection,
        edge,
        waypoints,
        [...allShapeBounds, ...labelObstacles],
        options.clearance,
        maxCoordinate
      );
      const contacts = inspectRoute(
        waypoints,
        connection,
        shapes,
        otherEdges,
        options.clearance
      );
      const labelContacts = labelBounds
        ? labelObstacleContacts(
          labelBounds,
          [...allShapeBounds, ...labelObstacles],
          options.clearance
        )
        : { collisions: new Set<string>(), clearance: new Set<string>() };
      const score = scoreRoute(
        waypoints,
        contacts,
        labelContacts.collisions.size,
        labelContacts.clearance.size
      );
      const boundaryDiagnostics: GeometryDiagnostic[] = [];
      if (waypoints.length < 2) {
        boundaryDiagnostics.push({
          code: 'INSUFFICIENT_WAYPOINTS', severity: 'error',
          message: `Candidate route for ${connectionId} has fewer than two waypoints`,
          ids: [connectionId]
        });
      } else if (waypoints.some(point => !validPoint(point, maxCoordinate))) {
        boundaryDiagnostics.push({
          code: 'NON_FINITE_GEOMETRY', severity: 'error',
          message: `Candidate route for ${connectionId} is outside the supported coordinate range`,
          ids: [connectionId]
        });
      }
      return {
        waypoints,
        ...(labelBounds ? { labelBounds } : {}),
        score,
        diagnostics: [
          ...boundaryDiagnostics,
          ...routeDiagnostics(
            connectionId,
            contacts,
            labelContacts.collisions,
            labelContacts.clearance,
            options
          )
        ]
      };
    }).sort(compareCandidates);
  }
}

function assertAvoidLists(
  connection: BpmnDocumentConnection,
  options: ConnectionRouteOptions,
  shapesByElement: Map<string, BpmnShapeModel>,
  edgesByConnection: Map<string, BpmnEdgeModel>
): void {
  for (const elementId of options.avoidElementIds) {
    if (!shapesByElement.has(elementId)) {
      throw new Error(`Avoided element ${elementId} has no rendered BPMNShape`);
    }
    if (elementId === connection.source || elementId === connection.target) {
      throw new Error(
        `Connection ${connection.id} cannot avoid its endpoint ${elementId}`
      );
    }
  }
  for (const avoidedConnectionId of options.avoidConnectionIds) {
    if (avoidedConnectionId === connection.id) {
      throw new Error(`Connection ${connection.id} cannot avoid itself`);
    }
    if (!edgesByConnection.has(avoidedConnectionId)) {
      throw new Error(`Avoided connection ${avoidedConnectionId} has no rendered BPMNEdge`);
    }
  }
}

function routeCandidates(
  source: Bounds,
  target: Bounds,
  shapes: IdentifiedBounds[],
  clearance: number,
  limit: number,
  maxCoordinate: number
): Position[][] {
  const unique = new Map<string, Position[]>();
  const xCorridors = corridorCoordinates(shapes, 'x', clearance, maxCoordinate);
  const yCorridors = corridorCoordinates(shapes, 'y', clearance, maxCoordinate);

  const add = (route: Position[]): void => {
    if (unique.size >= limit) return;
    const compacted = compactRoute(route);
    if (compacted.length < 2
      || compacted.length > 256
      || compacted.some(point => !validPoint(point, maxCoordinate))) return;
    unique.set(JSON.stringify(compacted), compacted);
  };

  const endpointPairs = SIDES.flatMap(sourceSide => SIDES.map(targetSide => {
    const sourceAnchor = pointOnSide(source, sourceSide);
    const targetAnchor = pointOnSide(target, targetSide);
    const sourceExit = moveOut(sourceAnchor, sourceSide, clearance);
    const targetExit = moveOut(targetAnchor, targetSide, clearance);
    return {
      sourceExit,
      targetExit,
      prefix: [sourceAnchor, sourceExit],
      suffix: [targetExit, targetAnchor]
    };
  }));

  for (const { sourceExit, targetExit, prefix, suffix } of endpointPairs) {
      add([...prefix, ...orthogonalMiddle(sourceExit, targetExit, true), ...suffix]);
      add([...prefix, ...orthogonalMiddle(sourceExit, targetExit, false), ...suffix]);
      const middleX = (sourceExit.x + targetExit.x) / 2;
      const middleY = (sourceExit.y + targetExit.y) / 2;
      add([...prefix,
        { x: middleX, y: sourceExit.y },
        { x: middleX, y: targetExit.y },
        ...suffix]);
      add([...prefix,
        { x: sourceExit.x, y: middleY },
        { x: targetExit.x, y: middleY },
        ...suffix]);
  }

  for (const { sourceExit, targetExit, prefix, suffix } of endpointPairs) {
    if (unique.size >= limit) break;
      for (const x of xCorridors) {
        if (unique.size >= limit) break;
        add([...prefix, { x, y: sourceExit.y }, { x, y: targetExit.y }, ...suffix]);
      }
      for (const y of yCorridors) {
        if (unique.size >= limit) break;
        add([...prefix, { x: sourceExit.x, y }, { x: targetExit.x, y }, ...suffix]);
      }
  }

  return Array.from(unique.values());
}

function corridorCoordinates(
  shapes: IdentifiedBounds[],
  axis: 'x' | 'y',
  clearance: number,
  maxCoordinate: number
): number[] {
  const values = new Set<number>();
  for (const shape of shapes) {
    const origin = axis === 'x' ? shape.x : shape.y;
    const extent = axis === 'x' ? shape.width : shape.height;
    values.add(clamp(origin - clearance, 0, maxCoordinate));
    values.add(clamp(origin + extent + clearance, 0, maxCoordinate));
  }
  return Array.from(values).sort((left, right) => left - right);
}

function orthogonalMiddle(start: Position, end: Position, horizontalFirst: boolean): Position[] {
  if (start.x === end.x || start.y === end.y) return [end];
  return horizontalFirst
    ? [{ x: end.x, y: start.y }, end]
    : [{ x: start.x, y: end.y }, end];
}

function compactRoute(route: Position[]): Position[] {
  const withoutDuplicates = route.filter((point, index) => index === 0
    || point.x !== route[index - 1].x
    || point.y !== route[index - 1].y);
  return withoutDuplicates.filter((point, index) => {
    if (index === 0 || index === withoutDuplicates.length - 1) return true;
    const previous = withoutDuplicates[index - 1];
    const next = withoutDuplicates[index + 1];
    const betweenVertical = previous.x === point.x && point.x === next.x
      && point.y >= Math.min(previous.y, next.y)
      && point.y <= Math.max(previous.y, next.y);
    const betweenHorizontal = previous.y === point.y && point.y === next.y
      && point.x >= Math.min(previous.x, next.x)
      && point.x <= Math.max(previous.x, next.x);
    return !betweenVertical && !betweenHorizontal;
  });
}

function inspectRoute(
  route: Position[],
  connection: BpmnDocumentConnection,
  shapes: IdentifiedBounds[],
  edges: BpmnEdgeModel[],
  clearance: number
): RouteContacts {
  const contacts: RouteContacts = {
    shapeCollisions: new Set(),
    clearanceFailures: new Set(),
    connectionCrossings: new Set()
  };
  route.slice(1).forEach((end, segmentIndex) => {
    const start = route[segmentIndex];
    for (const shape of shapes) {
      const legalSource = shape.id === connection.source && segmentIndex === 0;
      const legalTarget = shape.id === connection.target && segmentIndex === route.length - 2;
      if (legalSource || legalTarget) {
        const leavesEndpoint = legalSource
          ? leavesBounds(start, end, shape)
          : leavesBounds(end, start, shape);
        if (leavesEndpoint) continue;
        contacts.shapeCollisions.add(shape.id);
        continue;
      }
      if (segmentIntersectsBounds(start, end, shape)) {
        contacts.shapeCollisions.add(shape.id);
      } else if (clearance > 0
        && segmentIntersectsBounds(start, end, expandBounds(shape, clearance))) {
        contacts.clearanceFailures.add(shape.id);
      }
    }
    for (const edge of edges) {
      if (routeCrossesEdge(start, end, edge.waypoints)) {
        contacts.connectionCrossings.add(edge.connectionId);
      }
    }
  });
  return contacts;
}

function placeConnectionLabel(
  connection: BpmnDocumentConnection,
  edge: BpmnEdgeModel,
  route: Position[],
  obstacles: IdentifiedBounds[],
  clearance: number,
  maxCoordinate: number
): Bounds | undefined {
  const size = edge.labelBounds
    ? { width: edge.labelBounds.width, height: edge.labelBounds.height }
    : connection.label
      ? { width: Math.max(40, Math.min(240, connection.label.length * 7)), height: 20 }
      : undefined;
  if (!size) return undefined;
  const gap = Math.max(5, clearance);
  const candidates: Array<Bounds & { segmentLength: number }> = [];
  route.slice(1).forEach((end, index) => {
    const start = route[index];
    const segmentLength = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    if (start.y === end.y) {
      candidates.push(
        { x: middle.x - size.width / 2, y: middle.y - size.height - gap, ...size, segmentLength },
        { x: middle.x - size.width / 2, y: middle.y + gap, ...size, segmentLength }
      );
    } else {
      candidates.push(
        { x: middle.x - size.width - gap, y: middle.y - size.height / 2, ...size, segmentLength },
        { x: middle.x + gap, y: middle.y - size.height / 2, ...size, segmentLength }
      );
    }
  });
  const ranked = candidates.filter(candidate => validBounds(candidate, maxCoordinate))
    .map(candidate => {
    const contacts = labelObstacleContacts(candidate, obstacles, clearance);
    return {
      candidate,
      collisions: contacts.collisions.size,
      clearanceFailures: contacts.clearance.size
    };
    }).sort((left, right) => left.collisions - right.collisions
    || left.clearanceFailures - right.clearanceFailures
    || right.candidate.segmentLength - left.candidate.segmentLength
    || left.candidate.x - right.candidate.x
    || left.candidate.y - right.candidate.y);
  if (!ranked[0]) {
    return edge.labelBounds && validBounds(edge.labelBounds, maxCoordinate)
      ? { ...edge.labelBounds }
      : undefined;
  }
  const { segmentLength: _segmentLength, ...bounds } = ranked[0].candidate;
  return bounds;
}

function labelObstacleBounds(
  shapes: BpmnShapeModel[],
  edges: BpmnEdgeModel[],
  connectionId: string
): IdentifiedBounds[] {
  const labels: IdentifiedBounds[] = [];
  for (const shape of shapes) {
    if (shape.labelBounds) labels.push({ id: shape.elementId, ...shape.labelBounds });
  }
  for (const edge of edges) {
    if (edge.connectionId !== connectionId && edge.labelBounds) {
      labels.push({ id: edge.connectionId, ...edge.labelBounds });
    }
  }
  return labels;
}

function labelObstacleContacts(
  label: Bounds,
  obstacles: IdentifiedBounds[],
  clearance: number
): { collisions: Set<string>; clearance: Set<string> } {
  const collisions = new Set<string>();
  const clearanceFailures = new Set<string>();
  for (const obstacle of obstacles) {
    if (rectanglesOverlap(label, obstacle)) collisions.add(obstacle.id);
    else if (clearance > 0 && rectanglesOverlap(expandBounds(label, clearance), obstacle)) {
      clearanceFailures.add(obstacle.id);
    }
  }
  return { collisions, clearance: clearanceFailures };
}

function scoreRoute(
  route: Position[],
  contacts: RouteContacts,
  labelCollisions: number,
  labelClearanceFailures: number
): ConnectionRouteScoreBreakdown {
  const shapeCollisions = contacts.shapeCollisions.size;
  const clearanceFailures = contacts.clearanceFailures.size + labelClearanceFailures;
  const connectionCrossings = contacts.connectionCrossings.size;
  const bends = Math.max(0, route.length - 2);
  const length = route.slice(1).reduce((total, point, index) =>
    total + Math.abs(point.x - route[index].x) + Math.abs(point.y - route[index].y), 0);
  return {
    shapeCollisions,
    labelCollisions,
    clearanceFailures,
    connectionCrossings,
    bends,
    length,
    total: shapeCollisions * 1_000_000
      + labelCollisions * 500_000
      + clearanceFailures * 100_000
      + connectionCrossings * 250_000
      + bends * 100
      + length
  };
}

function routeDiagnostics(
  connectionId: string,
  contacts: RouteContacts,
  labelCollisions: Set<string>,
  labelClearance: Set<string>,
  options: ConnectionRouteOptions
): GeometryDiagnostic[] {
  const diagnostics: GeometryDiagnostic[] = [];
  for (const id of contacts.shapeCollisions) {
    diagnostics.push({
      code: 'EDGE_SHAPE_COLLISION', severity: 'error',
      message: `Candidate route for ${connectionId} crosses shape ${id}`,
      ids: [connectionId, id]
    });
  }
  for (const id of labelCollisions) {
    diagnostics.push({
      code: 'LABEL_OVERLAP', severity: 'error',
      message: `Candidate label for ${connectionId} overlaps ${id}`,
      ids: [connectionId, id]
    });
  }
  for (const id of new Set([...contacts.clearanceFailures, ...labelClearance])) {
    diagnostics.push({
      code: 'MINIMUM_CLEARANCE', severity: 'warning',
      message: `Candidate route for ${connectionId} does not meet ${options.clearance}px clearance from ${id}`,
      ids: [connectionId, id]
    });
  }
  for (const id of contacts.connectionCrossings) {
    diagnostics.push({
      code: 'EDGE_EDGE_CROSSING', severity: 'error',
      message: `Candidate route for ${connectionId} crosses connection ${id}`,
      ids: [connectionId, id]
    });
  }
  return diagnostics.sort((left, right) => left.code.localeCompare(right.code)
    || left.ids.join('\0').localeCompare(right.ids.join('\0')));
}

function compareCandidates(left: ConnectionRouteCandidate, right: ConnectionRouteCandidate): number {
  return left.score.total - right.score.total
    || JSON.stringify(left.waypoints).localeCompare(JSON.stringify(right.waypoints));
}

function pointOnSide(bounds: Bounds, side: Side): Position {
  if (side === 'top') return { x: bounds.x + bounds.width / 2, y: bounds.y };
  if (side === 'right') {
    return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
  }
  if (side === 'bottom') {
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  }
  return { x: bounds.x, y: bounds.y + bounds.height / 2 };
}

function moveOut(point: Position, side: Side, distance: number): Position {
  if (side === 'top') return { x: point.x, y: point.y - distance };
  if (side === 'right') return { x: point.x + distance, y: point.y };
  if (side === 'bottom') return { x: point.x, y: point.y + distance };
  return { x: point.x - distance, y: point.y };
}

function segmentIntersectsBounds(start: Position, end: Position, bounds: Bounds): boolean {
  const epsilon = 0.001;
  if (start.x === end.x) {
    return start.x > bounds.x + epsilon
      && start.x < bounds.x + bounds.width - epsilon
      && Math.max(start.y, end.y) > bounds.y + epsilon
      && Math.min(start.y, end.y) < bounds.y + bounds.height - epsilon;
  }
  if (start.y === end.y) {
    return start.y > bounds.y + epsilon
      && start.y < bounds.y + bounds.height - epsilon
      && Math.max(start.x, end.x) > bounds.x + epsilon
      && Math.min(start.x, end.x) < bounds.x + bounds.width - epsilon;
  }
  return true;
}

function leavesBounds(boundary: Position, outside: Position, bounds: Bounds): boolean {
  const epsilon = 0.001;
  return (Math.abs(boundary.x - bounds.x) <= epsilon && outside.x < boundary.x - epsilon)
    || (Math.abs(boundary.x - (bounds.x + bounds.width)) <= epsilon
      && outside.x > boundary.x + epsilon)
    || (Math.abs(boundary.y - bounds.y) <= epsilon && outside.y < boundary.y - epsilon)
    || (Math.abs(boundary.y - (bounds.y + bounds.height)) <= epsilon
      && outside.y > boundary.y + epsilon);
}

function routeCrossesEdge(start: Position, end: Position, waypoints: Position[]): boolean {
  return waypoints.slice(1).some((otherEnd, index) =>
    segmentsProperlyCross(start, end, waypoints[index], otherEnd));
}

function segmentsProperlyCross(
  firstStart: Position,
  firstEnd: Position,
  secondStart: Position,
  secondEnd: Position
): boolean {
  const firstVertical = firstStart.x === firstEnd.x;
  const secondVertical = secondStart.x === secondEnd.x;
  if (firstVertical === secondVertical) return false;
  const verticalStart = firstVertical ? firstStart : secondStart;
  const verticalEnd = firstVertical ? firstEnd : secondEnd;
  const horizontalStart = firstVertical ? secondStart : firstStart;
  const horizontalEnd = firstVertical ? secondEnd : firstEnd;
  const x = verticalStart.x;
  const y = horizontalStart.y;
  return x > Math.min(horizontalStart.x, horizontalEnd.x)
    && x < Math.max(horizontalStart.x, horizontalEnd.x)
    && y > Math.min(verticalStart.y, verticalEnd.y)
    && y < Math.max(verticalStart.y, verticalEnd.y);
}

function rectanglesOverlap(left: Bounds, right: Bounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function expandBounds(bounds: Bounds, clearance: number): Bounds {
  return {
    x: bounds.x - clearance,
    y: bounds.y - clearance,
    width: bounds.width + clearance * 2,
    height: bounds.height + clearance * 2
  };
}

function isCrossableContainer(document: BpmnDocument, shape: BpmnShapeModel): boolean {
  if (document.lanes.has(shape.elementId)) return true;
  const element = document.elements.get(shape.elementId);
  return element !== undefined && CONTAINER_TYPES.has(element.type);
}

function currentShapeBounds(document: BpmnDocument, shape: BpmnShapeModel): Bounds {
  const element = document.elements.get(shape.elementId);
  if (element) return { ...element.position, ...element.size };
  const lane = document.lanes.get(shape.elementId);
  if (lane) return { ...lane.position, ...lane.size };
  return { ...shape.bounds };
}

function validPoint(point: Position, maxCoordinate: number): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.y >= 0
    && point.x <= maxCoordinate && point.y <= maxCoordinate;
}

function validBounds(bounds: Bounds, maxCoordinate: number): boolean {
  return validPoint(bounds, maxCoordinate)
    && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    && bounds.width > 0 && bounds.height > 0
    && bounds.width <= maxCoordinate && bounds.height <= maxCoordinate;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
