import type {
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnDocumentElement,
  BpmnEdgeModel,
  BpmnLane,
  BpmnShapeModel,
  Position
} from '../../types/index.js';
import { ConnectionRouter } from './ConnectionRouter.js';

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
 * their owner process, black-box participants keep their requested bounds as
 * lower bounds, and participants are restacked after expansion onto a shared
 * left edge and a shared width. Message flows are routed only after that final
 * container placement and therefore never affect the sequence-flow ranks
 * inside a process.
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
    // A size the caller never asked for is not a constraint. Treating the
    // 600x250 type default as a floor left one-row pools mostly empty.
    const requestedSize = constraint?.sizeManaged ? undefined : constraint?.size;
    participant.size.width = Math.max(
      participant.size.width,
      requestedSize?.width || 0,
      COLLABORATION_LAYOUT_POLICY.participantMinWidth
    );
    participant.size.height = Math.max(
      participant.size.height,
      requestedSize?.height || 0,
      participant.processRef
        ? COLLABORATION_LAYOUT_POLICY.whiteBoxParticipantMinHeight
        : COLLABORATION_LAYOUT_POLICY.participantMinHeight
    );
    expandParticipantAroundOwnedGeometry(participant, laidOut, constraint?.sizeManaged === true);
    applyLaneConstraints(participant, requested, laidOut, diagramLookup);
  }

  // Pools of a collaboration form one stack: they share a left edge and a
  // width, so the diagram does not read as ragged columns of whitespace.
  const alignedX = participants.reduce(
    (minimum, participant) => Math.min(minimum, participant.position.x),
    Infinity
  );
  const alignedWidth = participants.reduce(
    (maximum, participant) => Math.max(maximum, participant.size.width),
    0
  );
  let nextY = participants.reduce(
    (minimum, participant) => Math.min(minimum, participant.position.y),
    Infinity
  );
  for (const participant of participants) {
    const translation = {
      x: alignedX - participant.position.x,
      y: nextY - participant.position.y
    };
    translateParticipant(participant, translation, laidOut, diagramLookup);
    participant.size.width = alignedWidth;
    stretchParticipantLanes(participant, laidOut);
    nextY = participant.position.y + participant.size.height
      + COLLABORATION_LAYOUT_POLICY.participantGap;
  }

  routeCollaborationConnections(laidOut, diagramLookup);
}

function stretchParticipantLanes(
  participant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  document: BpmnDocument
): void {
  if (!participant.processRef) return;
  const laneSet = Array.from(document.laneSets.values()).find(candidate =>
    candidate.processId === participant.processRef && candidate.parentLaneId === undefined
  );
  for (const laneId of laneSet?.laneIds ?? []) {
    const lane = document.lanes.get(laneId);
    if (lane) {
      lane.size.width = participant.size.width - COLLABORATION_LAYOUT_POLICY.participantHeaderWidth;
    }
  }
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
  document: BpmnDocument,
  /**
   * True when the pool's size came from the type default rather than the
   * caller. The laid-out participant is a fresh parse of the layout output and
   * carries no provenance of its own, so it is passed in from the requested
   * document.
   */
  sizeManaged: boolean
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
  const contentWidth = maxRight - participant.position.x;
  const contentHeight = maxBottom - participant.position.y;
  if (sizeManaged) {
    // The pool carries a type default nobody asked for, so it is free to
    // shrink to what it actually contains, down to the readable minimum.
    // Sizes the caller chose are only ever grown, never reduced.
    participant.size.width = Math.max(
      contentWidth,
      COLLABORATION_LAYOUT_POLICY.participantMinWidth
    );
    participant.size.height = Math.max(
      contentHeight,
      participant.processRef
        ? COLLABORATION_LAYOUT_POLICY.whiteBoxParticipantMinHeight
        : COLLABORATION_LAYOUT_POLICY.participantMinHeight
    );
    return;
  }
  participant.size.width = Math.max(participant.size.width, contentWidth);
  participant.size.height = Math.max(participant.size.height, contentHeight);
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
  diagramLookup: DiagramLookup
): void {
  const router = new ConnectionRouter();
  // Indexed once for the whole pass: both arrays hold the live DI records, so
  // a label placed for one message flow is an obstacle for the next one.
  const shapes = Array.from(diagramLookup.shapesByElement.values());
  const edges = Array.from(diagramLookup.edgesByConnection.values());

  for (const connection of document.connections.values()) {
    if (connection.type !== 'bpmn:MessageFlow') continue;
    const candidates = router.route(document, connection.id, {
      avoidElementIds: [],
      avoidConnectionIds: [],
      clearance: COLLABORATION_LAYOUT_POLICY.routeClearance,
      shapes,
      edges
    });
    const selected = candidates.find(candidate => candidate.diagnostics.length === 0)
      ?? candidates[0];
    if (!selected) continue;
    connection.waypoints = selected.waypoints.map(point => ({ ...point }));
    const edge = diagramLookup.edgesByConnection.get(connection.id);
    if (edge) {
      edge.waypoints = connection.waypoints.map(point => ({ ...point }));
      if (selected.labelBounds) edge.labelBounds = { ...selected.labelBounds };
    }
  }
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

function isParticipant(
  element: BpmnDocumentElement
): element is Extract<BpmnDocumentElement, { kind: 'participant' }> {
  return element.kind === 'participant';
}
