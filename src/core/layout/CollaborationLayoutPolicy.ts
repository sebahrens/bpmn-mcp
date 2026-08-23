import type {
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnDocumentElement,
  BpmnEdgeModel,
  BpmnLane,
  BpmnShapeModel,
  Position
} from '../../types/index.js';

export const COLLABORATION_LAYOUT_POLICY = Object.freeze({
  participantHeaderWidth: 30,
  participantGap: 80,
  participantMinWidth: 300,
  participantMinHeight: 60,
  whiteBoxParticipantMinHeight: 150,
  laneMinHeight: 60,
  routeClearance: 20
});

interface Translation {
  x: number;
  y: number;
}

interface Bounds extends Position {
  width: number;
  height: number;
}

interface DiagramLookup {
  shapesByElement: Map<string, BpmnShapeModel>;
  edgesByConnection: Map<string, BpmnEdgeModel>;
}

/**
 * Enforce the collaboration contract after the selected semantic layout has
 * independently laid out each participant process.
 *
 * Existing node positions are deliberately replaced by auto-layout. Existing
 * participant and lane dimensions are lower bounds, however, so an explicitly
 * requested/imported container is never shrunk. Disconnected nodes remain in
 * their owner process, black-box participants retain their requested bounds,
 * and participants are restacked after expansion. Message flows are routed
 * only after that final container placement and therefore never affect the
 * sequence-flow ranks inside a process.
 */
export function applyCollaborationLayoutPolicy(
  requested: BpmnDocument,
  laidOut: BpmnDocument
): void {
  if (!laidOut.collaborations.has(laidOut.diagram.planeElementId)) return;

  const participants = Array.from(laidOut.elements.values())
    .filter(isParticipant)
    .sort((left, right) =>
      left.position.y - right.position.y
        || left.position.x - right.position.x
        || left.id.localeCompare(right.id)
  );
  if (participants.length === 0) return;
  const diagramLookup = createDiagramLookup(laidOut);

  for (const participant of participants) {
    const constraint = requested.elements.get(participant.id);
    participant.size.width = Math.max(
      participant.size.width,
      constraint?.size.width || 0,
      COLLABORATION_LAYOUT_POLICY.participantMinWidth
    );
    participant.size.height = Math.max(
      participant.size.height,
      constraint?.size.height || 0,
      participant.processRef
        ? COLLABORATION_LAYOUT_POLICY.whiteBoxParticipantMinHeight
        : COLLABORATION_LAYOUT_POLICY.participantMinHeight
    );
    expandParticipantAroundOwnedGeometry(participant, laidOut);
    applyLaneConstraints(participant, requested, laidOut, diagramLookup);
  }

  let nextY = participants.reduce(
    (minimum, participant) => Math.min(minimum, participant.position.y),
    Infinity
  );
  for (const participant of participants) {
    const translation = { x: 0, y: nextY - participant.position.y };
    translateParticipant(participant, translation, laidOut, diagramLookup);
    nextY = participant.position.y + participant.size.height
      + COLLABORATION_LAYOUT_POLICY.participantGap;
  }

  routeCollaborationConnections(laidOut, participants, diagramLookup);
}

function applyLaneConstraints(
  participant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  requested: BpmnDocument,
  laidOut: BpmnDocument,
  diagramLookup: DiagramLookup
): void {
  if (!participant.processRef) return;
  const laneSet = Array.from(laidOut.laneSets.values()).find(candidate =>
    candidate.processId === participant.processRef && candidate.parentLaneId === undefined
  );
  if (!laneSet?.laneIds.length) return;

  const lanes = laneSet.laneIds
    .map(id => laidOut.lanes.get(id))
    .filter((lane): lane is BpmnLane => lane !== undefined);
  const processNodes = Array.from(laidOut.elements.values())
    .filter(element => element.ownerId === participant.processRef);
  const originalNodePositions = new Map(processNodes.map(node => [node.id, { ...node.position }]));
  const heights = lanes.map(lane => Math.max(
    lane.size.height,
    requested.lanes.get(lane.id)?.size.height || 0,
    COLLABORATION_LAYOUT_POLICY.laneMinHeight
  ));
  participant.size.height = Math.max(
    participant.size.height,
    heights.reduce((total, height) => total + height, 0)
  );
  participant.size.width = lanes.reduce(
    (width, lane) => Math.max(
      width,
      Math.max(lane.size.width, requested.lanes.get(lane.id)?.size.width || 0)
        + COLLABORATION_LAYOUT_POLICY.participantHeaderWidth
    ),
    participant.size.width
  );
  heights[heights.length - 1] += participant.size.height
    - heights.reduce((total, height) => total + height, 0);

  const originalPositions = new Map(lanes.map(lane => [lane.id, { ...lane.position }]));
  let nextY = participant.position.y;
  lanes.forEach((lane, index) => {
    const previous = originalPositions.get(lane.id)!;
    const translation = { x: 0, y: nextY - previous.y };
    translateLaneContents(lane, translation, laidOut, diagramLookup, new Set());
    lane.position = {
      x: participant.position.x + COLLABORATION_LAYOUT_POLICY.participantHeaderWidth,
      y: nextY
    };
    lane.size = {
      width: participant.size.width - COLLABORATION_LAYOUT_POLICY.participantHeaderWidth,
      height: heights[index]
    };
    nextY += heights[index];
  });
  adjustProcessConnectionRoutes(
    participant.processRef,
    originalNodePositions,
    laidOut,
    diagramLookup
  );
}

function translateLaneContents(
  lane: BpmnLane,
  translation: Translation,
  document: BpmnDocument,
  diagramLookup: DiagramLookup,
  movedNodes: Set<string>
): void {
  translateLane(lane, translation, diagramLookup);
  for (const nodeId of lane.flowNodeRefs) {
    if (movedNodes.has(nodeId)) continue;
    const node = document.elements.get(nodeId);
    if (node) {
      translateElement(node, translation, diagramLookup);
      movedNodes.add(nodeId);
    }
  }
  for (const childSet of document.laneSets.values()) {
    if (childSet.parentLaneId !== lane.id) continue;
    for (const childLaneId of childSet.laneIds) {
      const child = document.lanes.get(childLaneId);
      if (child) {
        translateLaneContents(child, translation, document, diagramLookup, movedNodes);
      }
    }
  }
}

function adjustProcessConnectionRoutes(
  processId: string,
  originalPositions: Map<string, Position>,
  document: BpmnDocument,
  diagramLookup: DiagramLookup
): void {
  for (const connection of document.connections.values()) {
    if (connection.ownerId !== processId || connection.waypoints.length < 2) continue;
    const source = document.elements.get(connection.source);
    const target = document.elements.get(connection.target);
    const originalSource = originalPositions.get(connection.source);
    const originalTarget = originalPositions.get(connection.target);
    if (!source || !target || !originalSource || !originalTarget) continue;
    const sourceTranslation = {
      x: source.position.x - originalSource.x,
      y: source.position.y - originalSource.y
    };
    const targetTranslation = {
      x: target.position.x - originalTarget.x,
      y: target.position.y - originalTarget.y
    };
    const lastIndex = connection.waypoints.length - 1;
    connection.waypoints.forEach((point, index) => {
      const ratio = index / lastIndex;
      point.x += sourceTranslation.x * (1 - ratio) + targetTranslation.x * ratio;
      point.y += sourceTranslation.y * (1 - ratio) + targetTranslation.y * ratio;
    });
    const edge = diagramLookup.edgesByConnection.get(connection.id);
    if (edge?.labelBounds) {
      edge.labelBounds.x += (sourceTranslation.x + targetTranslation.x) / 2;
      edge.labelBounds.y += (sourceTranslation.y + targetTranslation.y) / 2;
    }
  }
}

function expandParticipantAroundOwnedGeometry(
  participant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  document: BpmnDocument
): void {
  if (!participant.processRef) return;
  const owned = [
    ...Array.from(document.elements.values())
      .filter(element => element.ownerId === participant.processRef)
      .map(elementBounds),
    ...Array.from(document.lanes.values())
      .filter(lane => lane.processId === participant.processRef)
      .map(laneBounds)
  ];
  if (owned.length === 0) return;

  const maxRight = owned.reduce(
    (maximum, bounds) => Math.max(maximum, bounds.x + bounds.width),
    -Infinity
  );
  const maxBottom = owned.reduce(
    (maximum, bounds) => Math.max(maximum, bounds.y + bounds.height),
    -Infinity
  );
  participant.size.width = Math.max(
    participant.size.width,
    maxRight - participant.position.x
  );
  participant.size.height = Math.max(
    participant.size.height,
    maxBottom - participant.position.y
  );
}

function translateParticipant(
  participant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  translation: Translation,
  document: BpmnDocument,
  diagramLookup: DiagramLookup
): void {
  translateElement(participant, translation, diagramLookup);
  if (!participant.processRef) return;

  for (const element of document.elements.values()) {
    if (element.ownerId === participant.processRef) {
      translateElement(element, translation, diagramLookup);
    }
  }
  for (const lane of document.lanes.values()) {
    if (lane.processId === participant.processRef) {
      translateLane(lane, translation, diagramLookup);
    }
  }
  for (const connection of document.connections.values()) {
    if (connection.ownerId === participant.processRef) {
      translateConnection(connection, translation, diagramLookup);
    }
  }
}

function translateElement(
  element: BpmnDocumentElement,
  translation: Translation,
  diagramLookup: DiagramLookup
): void {
  element.position.x += translation.x;
  element.position.y += translation.y;
  const shape = diagramLookup.shapesByElement.get(element.id);
  if (shape?.labelBounds) {
    shape.labelBounds.x += translation.x;
    shape.labelBounds.y += translation.y;
  }
}

function translateLane(
  lane: BpmnLane,
  translation: Translation,
  diagramLookup: DiagramLookup
): void {
  lane.position.x += translation.x;
  lane.position.y += translation.y;
  const shape = diagramLookup.shapesByElement.get(lane.id);
  if (shape?.labelBounds) {
    shape.labelBounds.x += translation.x;
    shape.labelBounds.y += translation.y;
  }
}

function translateConnection(
  connection: BpmnDocumentConnection,
  translation: Translation,
  diagramLookup: DiagramLookup
): void {
  connection.waypoints.forEach(point => {
    point.x += translation.x;
    point.y += translation.y;
  });
  const edge = diagramLookup.edgesByConnection.get(connection.id);
  if (edge?.labelBounds) {
    edge.labelBounds.x += translation.x;
    edge.labelBounds.y += translation.y;
  }
}

function routeCollaborationConnections(
  document: BpmnDocument,
  participants: Array<Extract<BpmnDocumentElement, { kind: 'participant' }>>,
  diagramLookup: DiagramLookup
): void {
  const participantByProcess = new Map(participants
    .filter(participant => participant.processRef)
    .map(participant => [participant.processRef!, participant]));
  const obstacleBounds = Array.from(document.elements.values())
    .filter(element => element.kind !== 'participant')
    .map(elementBounds);
  const labelObstacles = [
    ...Array.from(document.elements.values()).map(elementBounds),
    ...Array.from(document.lanes.values()).map(laneBounds)
  ];
  const outer = {
    left: participants.reduce(
      (minimum, participant) => Math.min(minimum, participant.position.x),
      Infinity
    ),
    right: participants.reduce(
      (maximum, participant) => Math.max(
        maximum,
        participant.position.x + participant.size.width
      ),
      -Infinity
    ),
    top: participants.reduce(
      (minimum, participant) => Math.min(minimum, participant.position.y),
      Infinity
    ),
    bottom: participants.reduce(
      (maximum, participant) => Math.max(
        maximum,
        participant.position.y + participant.size.height
      ),
      -Infinity
    )
  };

  for (const connection of document.connections.values()) {
    if (connection.type !== 'bpmn:MessageFlow') continue;
    const source = document.elements.get(connection.source);
    const target = document.elements.get(connection.target);
    if (!source || !target) continue;
    const sourceParticipant = source.kind === 'participant'
      ? source
      : participantByProcess.get(source.ownerId);
    const targetParticipant = target.kind === 'participant'
      ? target
      : participantByProcess.get(target.ownerId);
    if (!sourceParticipant || !targetParticipant) continue;

    const candidates = messageRouteCandidates(
      source,
      target,
      sourceParticipant,
      targetParticipant,
      outer
    );
    connection.waypoints = candidates
      .map(points => ({
        points,
        collisions: countRouteCollisions(points, obstacleBounds, source, target),
        length: routeLength(points)
      }))
      .sort((left, right) => left.collisions - right.collisions || left.length - right.length)[0]
      .points;
    const edge = diagramLookup.edgesByConnection.get(connection.id);
    if (edge?.labelBounds) {
      edge.labelBounds = placeMessageLabel(
        connection.waypoints,
        edge.labelBounds,
        labelObstacles,
        outer
      );
      labelObstacles.push({ id: connection.id, ...edge.labelBounds });
    }
  }
}

function placeMessageLabel(
  route: Position[],
  label: Bounds,
  obstacles: Array<Bounds & { id: string }>,
  outer: { left: number; right: number; top: number; bottom: number }
): Bounds {
  const gap = 5;
  const candidates = route.slice(1).flatMap((point, index) => {
    const start = route[index];
    const middle = { x: (start.x + point.x) / 2, y: (start.y + point.y) / 2 };
    const length = Math.abs(point.x - start.x) + Math.abs(point.y - start.y);
    return start.y === point.y
      ? [
          { x: middle.x - label.width / 2, y: middle.y - label.height - gap, length },
          { x: middle.x - label.width / 2, y: middle.y + gap, length }
        ]
      : [
          { x: middle.x - label.width - gap, y: middle.y - label.height / 2, length },
          { x: middle.x + gap, y: middle.y - label.height / 2, length }
        ];
  }).filter(candidate => obstacles.every(obstacle => !rectanglesOverlap(candidate, {
    width: label.width,
    height: label.height
  }, obstacle)));
  const selected = candidates.sort((left, right) => right.length - left.length)[0];
  if (selected) return { ...label, x: selected.x, y: selected.y };

  const fallback = {
    ...label,
    x: outer.right + gap,
    y: (outer.top + outer.bottom - label.height) / 2
  };
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const collisions = obstacles.filter(obstacle => rectanglesOverlap(
      fallback,
      { width: fallback.width, height: fallback.height },
      obstacle
    ));
    if (collisions.length === 0) return fallback;
    fallback.y = collisions.reduce(
      (maximum, obstacle) => Math.max(maximum, obstacle.y + obstacle.height),
      -Infinity
    ) + gap;
  }
  return fallback;
}

function messageRouteCandidates(
  source: BpmnDocumentElement,
  target: BpmnDocumentElement,
  sourceParticipant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  targetParticipant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  outer: { left: number; right: number; top: number; bottom: number }
): Position[][] {
  const clearance = COLLABORATION_LAYOUT_POLICY.routeClearance;
  const sourceBounds = elementBounds(source);
  const targetBounds = elementBounds(target);
  const right = outer.right + clearance;
  const left = outer.left - clearance;
  const sourceRight = { x: sourceBounds.x + sourceBounds.width, y: centerY(sourceBounds) };
  const targetRight = { x: targetBounds.x + targetBounds.width, y: centerY(targetBounds) };
  const sourceLeft = { x: sourceBounds.x, y: centerY(sourceBounds) };
  const targetLeft = { x: targetBounds.x, y: centerY(targetBounds) };
  const sourceAbove = centerY(elementBounds(sourceParticipant))
    < centerY(elementBounds(targetParticipant));
  const sourceVertical = sourceAbove
    ? { x: centerX(sourceBounds), y: sourceBounds.y + sourceBounds.height }
    : { x: centerX(sourceBounds), y: sourceBounds.y };
  const targetVertical = sourceAbove
    ? { x: centerX(targetBounds), y: targetBounds.y }
    : { x: centerX(targetBounds), y: targetBounds.y + targetBounds.height };
  const sourcePoolEdge = sourceAbove
    ? sourceParticipant.position.y + sourceParticipant.size.height
    : sourceParticipant.position.y;
  const targetPoolEdge = sourceAbove
    ? targetParticipant.position.y
    : targetParticipant.position.y + targetParticipant.size.height;
  const betweenParticipants = (sourcePoolEdge + targetPoolEdge) / 2;
  return [
    compactRoute([sourceRight, { x: right, y: sourceRight.y }, { x: right, y: targetRight.y }, targetRight]),
    compactRoute([sourceLeft, { x: left, y: sourceLeft.y }, { x: left, y: targetLeft.y }, targetLeft]),
    compactRoute([
      sourceVertical,
      { x: sourceVertical.x, y: betweenParticipants },
      { x: targetVertical.x, y: betweenParticipants },
      targetVertical
    ])
  ];
}

function countRouteCollisions(
  route: Position[],
  obstacles: Array<Bounds & { id: string }>,
  source: BpmnDocumentElement,
  target: BpmnDocumentElement
): number {
  const ignored = new Set([source.id, target.id]);
  return route.slice(1).reduce((total, point, index) => total + obstacles.filter(obstacle =>
    !ignored.has(obstacle.id)
      && segmentCrossesInterior(route[index], point, obstacle)
  ).length, 0);
}

function segmentCrossesInterior(start: Position, end: Position, bounds: Bounds): boolean {
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

function routeLength(route: Position[]): number {
  return route.slice(1).reduce((total, point, index) =>
    total + Math.abs(point.x - route[index].x) + Math.abs(point.y - route[index].y), 0
  );
}

function compactRoute(route: Position[]): Position[] {
  return route.filter((point, index) => index === 0
    || point.x !== route[index - 1].x
    || point.y !== route[index - 1].y
  );
}

function rectanglesOverlap(
  position: Position,
  size: { width: number; height: number },
  obstacle: Bounds
): boolean {
  return position.x < obstacle.x + obstacle.width
    && position.x + size.width > obstacle.x
    && position.y < obstacle.y + obstacle.height
    && position.y + size.height > obstacle.y;
}

function createDiagramLookup(document: BpmnDocument): DiagramLookup {
  return {
    shapesByElement: new Map(
      Array.from(document.diagram.shapes.values(), shape => [shape.elementId, shape])
    ),
    edgesByConnection: new Map(
      Array.from(document.diagram.edges.values(), edge => [edge.connectionId, edge])
    )
  };
}

function elementBounds(element: BpmnDocumentElement): Bounds & { id: string } {
  return { id: element.id, ...element.position, ...element.size };
}

function laneBounds(lane: BpmnLane): Bounds & { id: string } {
  return { id: lane.id, ...lane.position, ...lane.size };
}

function centerX(bounds: Bounds): number {
  return bounds.x + bounds.width / 2;
}

function centerY(bounds: Bounds): number {
  return bounds.y + bounds.height / 2;
}

function isParticipant(
  element: BpmnDocumentElement
): element is Extract<BpmnDocumentElement, { kind: 'participant' }> {
  return element.kind === 'participant';
}
