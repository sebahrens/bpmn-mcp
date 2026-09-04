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
  /**
   * Breathing room between a lane band's edge and the content the band owns,
   * and between the band stack and the strip that holds unassigned elements.
   */
  laneContentPadding: 20,
  routeClearance: 20,
  routeCandidateBudget: 1_024
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

/**
 * Reconcile the lane bands with lane membership after the ranked layout.
 *
 * A ranked layout knows nothing about lanes: it places every node of a process
 * on the same canvas and the bands are drawn over the result. That left two
 * ways for the picture to contradict the XML (mcp-bpmn-3g8.16). A node the
 * bands do not claim - the normal outcome of creating elements after
 * `add_lane`, which needs the ids up front - was drawn inside whichever band
 * happened to cover it, and a boundary event could hang over a divider into a
 * neighbouring band. So each band is grown to hold its own members plus the
 * boundary events attached to them, its content is clamped inside it, and
 * everything no band claims is moved into a strip below the stack, still
 * inside the pool it belongs to.
 */
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

  const padding = COLLABORATION_LAYOUT_POLICY.laneContentPadding;
  const laneContents = lanes.map(lane => laneContentElements(lane, laidOut));
  const claimed = new Set(laneContents.flat().map(element => element.id));
  const unassigned = processNodes.filter(element => !claimed.has(element.id));
  const contentBoxes = laneContents.map(content => boundingBox(content, diagramLookup));
  const unassignedBox = boundingBox(unassigned, diagramLookup);
  const stripHeight = unassignedBox ? unassignedBox.height + 2 * padding : 0;

  const heights = lanes.map((lane, index) => Math.max(
    lane.size.height,
    requested.lanes.get(lane.id)?.size.height || 0,
    COLLABORATION_LAYOUT_POLICY.laneMinHeight,
    contentBoxes[index] ? contentBoxes[index]!.height + 2 * padding : 0
  ));
  const bandTotal = (): number => heights.reduce((total, height) => total + height, 0);
  participant.size.height = Math.max(participant.size.height, bandTotal() + stripHeight);
  participant.size.width = lanes.reduce(
    (width, lane) => Math.max(
      width,
      Math.max(lane.size.width, requested.lanes.get(lane.id)?.size.width || 0)
        + COLLABORATION_LAYOUT_POLICY.participantHeaderWidth
    ),
    participant.size.width
  );
  // The bands tile the pool above the unassigned strip, never through it.
  heights[heights.length - 1] += participant.size.height - stripHeight - bandTotal();

  const originalPositions = new Map(lanes.map(lane => [lane.id, { ...lane.position }]));
  let nextY = participant.position.y;
  lanes.forEach((lane, index) => {
    const previous = originalPositions.get(lane.id)!;
    const box = contentBoxes[index];
    // The band's content keeps the offset the ranked layout gave it, unless
    // that would leave a member - or a boundary event attached to one - over a
    // divider, in which case it is clamped into the band.
    let contentShift = nextY - previous.y;
    if (box) {
      contentShift = Math.min(
        Math.max(contentShift, nextY + padding - box.y),
        nextY + heights[index] - padding - (box.y + box.height)
      );
    }
    translateLaneContents(lane, { x: 0, y: contentShift }, laidOut, diagramLookup, new Set());
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

  if (unassignedBox) {
    placeUnassignedElements(
      participant,
      unassigned,
      unassignedBox,
      nextY,
      diagramLookup
    );
  }
  adjustProcessConnectionRoutes(
    participant.processRef,
    originalNodePositions,
    laidOut,
    diagramLookup
  );
  // Interpolating a route whose two ends moved by different amounts stretches
  // it across whatever now sits between them. A connection that spans the
  // strip boundary is therefore routed again from scratch.
  rerouteRelocatedConnections(
    laidOut,
    new Set(unassigned.map(element => element.id)),
    diagramLookup
  );
}

/**
 * Re-route every connection with exactly one endpoint among `relocated`. Both
 * endpoints inside the set means the connection travelled with its group and
 * still holds its shape; neither means nothing moved relative to it.
 */
function rerouteRelocatedConnections(
  document: BpmnDocument,
  relocated: Set<string>,
  diagramLookup: DiagramLookup
): void {
  if (relocated.size === 0) return;
  const connectionIds = Array.from(document.connections.values())
    .filter(connection => connection.type !== 'bpmn:MessageFlow'
      && relocated.has(connection.source) !== relocated.has(connection.target))
    .map(connection => connection.id);
  routeConnections(document, connectionIds, diagramLookup);
}

/**
 * Everything a lane band owns: its own flow nodes, the flow nodes of any lane
 * nested inside it, and the boundary events attached to any of those. A
 * boundary event is not a `flowNodeRef` of the lane its host sits in, but it
 * is drawn on that host's outline, so the band that holds the host has to hold
 * the event too.
 */
function laneContentElements(lane: BpmnLane, document: BpmnDocument): BpmnDocumentElement[] {
  const content = new Map<string, BpmnDocumentElement>();
  const collect = (current: BpmnLane): void => {
    for (const nodeId of current.flowNodeRefs) {
      const element = document.elements.get(nodeId);
      if (element) content.set(element.id, element);
    }
    for (const childSet of document.laneSets.values()) {
      if (childSet.parentLaneId !== current.id) continue;
      for (const childLaneId of childSet.laneIds) {
        const child = document.lanes.get(childLaneId);
        if (child) collect(child);
      }
    }
  };
  collect(lane);
  for (const element of document.elements.values()) {
    if (element.type !== 'bpmn:BoundaryEvent') continue;
    const host = element.properties.attachTo;
    if (typeof host === 'string' && content.has(host)) content.set(element.id, element);
  }
  return Array.from(content.values());
}

/**
 * Move everything no lane claims into the strip under the band stack. The
 * elements travel as one rigid group so the ranked layout's arrangement of
 * them - and any connection drawn entirely between them - survives the move.
 */
function placeUnassignedElements(
  participant: Extract<BpmnDocumentElement, { kind: 'participant' }>,
  elements: BpmnDocumentElement[],
  box: Bounds,
  stripTop: number,
  diagramLookup: DiagramLookup
): void {
  const padding = COLLABORATION_LAYOUT_POLICY.laneContentPadding;
  const left = participant.position.x
    + COLLABORATION_LAYOUT_POLICY.participantHeaderWidth
    + padding;
  const translation = {
    x: Math.max(0, left - box.x),
    y: stripTop + padding - box.y
  };
  for (const element of elements) translateElement(element, translation, diagramLookup);
  participant.size.width = Math.max(
    participant.size.width,
    box.x + translation.x + box.width + padding - participant.position.x
  );
}

/** The union of the elements' bounds and of the labels drawn for them. */
function boundingBox(
  elements: BpmnDocumentElement[],
  diagramLookup: DiagramLookup
): Bounds | undefined {
  const boxes: Bounds[] = [];
  for (const element of elements) {
    boxes.push({ ...element.position, ...element.size });
    const label = diagramLookup.shapesByElement.get(element.id)?.labelBounds;
    if (label) boxes.push({ ...label });
  }
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map(bounds => bounds.x));
  const top = Math.min(...boxes.map(bounds => bounds.y));
  const right = Math.max(...boxes.map(bounds => bounds.x + bounds.width));
  const bottom = Math.max(...boxes.map(bounds => bounds.y + bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
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
    if (!edge) continue;
    // The DI edge is the copy every later pass reads - the router treats it as
    // an obstacle - so it has to follow the model now rather than at
    // serialization time.
    edge.waypoints = connection.waypoints.map(point => ({ ...point }));
    if (edge.labelBounds) {
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
  routeConnections(
    document,
    Array.from(document.connections.values())
      .filter(connection => connection.type === 'bpmn:MessageFlow')
      .map(connection => connection.id),
    diagramLookup
  );
}

/** Replace the named connections' routes with the router's best candidate. */
function routeConnections(
  document: BpmnDocument,
  connectionIds: string[],
  diagramLookup: DiagramLookup
): void {
  const router = new ConnectionRouter();
  // Indexed once for the whole pass: both arrays hold the live DI records, so
  // a label placed for one connection is an obstacle for the next one.
  const shapes = Array.from(diagramLookup.shapesByElement.values());
  const edges = Array.from(diagramLookup.edgesByConnection.values());

  for (const connectionId of connectionIds) {
    const connection = document.connections.get(connectionId);
    if (!connection) continue;
    let candidates;
    try {
      candidates = router.route(document, connectionId, {
        avoidElementIds: [],
        avoidConnectionIds: [],
        clearance: COLLABORATION_LAYOUT_POLICY.routeClearance,
        // Candidates are generated dock side by dock side and truncated at the
        // cap, so the default budget never reaches the corridors of the last
        // sides. A connection that has to leave downwards - out of a boundary
        // event, say - needs the whole set to find its way around.
        maxCandidates: COLLABORATION_LAYOUT_POLICY.routeCandidateBudget,
        shapes,
        edges
      });
    } catch {
      // An unrenderable connection (no BPMNEdge, or an endpoint without a
      // shape) keeps whatever route it already has rather than failing layout.
      continue;
    }
    const selected = candidates.find(candidate => candidate.diagnostics.length === 0)
      ?? candidates[0];
    if (!selected) continue;
    connection.waypoints = selected.waypoints.map(point => ({ ...point }));
    const edge = diagramLookup.edgesByConnection.get(connectionId);
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
