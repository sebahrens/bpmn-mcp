import { calculateConnectionWaypoints } from '../BpmnDocument.js';
import type {
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnEdgeModel,
  Position
} from '../../types/index.js';
import { ConnectionRouter } from './ConnectionRouter.js';

/** Clearance used when a restored edge is re-routed around the new layout. */
const RESTORED_EDGE_CLEARANCE = 20;

/**
 * Re-create the BPMNEdges an external layout engine failed to emit.
 *
 * bpmn-auto-layout ranks the sequence-flow graph and rebuilds the plane from
 * what it ranked. Anything it does not model is silently absent from that
 * plane: an association anchored on a boundary event is the case reported by
 * mcp-bpmn-3g8.15, while an association from a text annotation survives. The
 * engine adopts the adapter's document wholesale, so without this pass a
 * correct diagram loses DI it already had — compensation links in particular.
 *
 * The connection itself is never at risk (the semantic model is compared
 * before adoption); only its rendering is. So the missing edges are taken back
 * from the pre-layout document and re-docked onto the shapes at their new
 * positions, which is the same treatment boundary events get after a
 * reflection.
 *
 * @returns the ids of the connections whose edge was restored, in document order.
 */
export function restoreDroppedLayoutEdges(
  previous: BpmnDocument,
  laidOut: BpmnDocument
): string[] {
  const renderedBefore = new Set(
    Array.from(previous.diagram.edges.values(), edge => edge.connectionId)
  );
  const renderedAfter = new Map(
    Array.from(laidOut.diagram.edges.values(), edge => [edge.connectionId, edge])
  );
  const previousEdgeIds = new Map(
    Array.from(previous.diagram.edges.values(), edge => [edge.connectionId, edge.id])
  );
  const takenEdgeIds = new Set(laidOut.diagram.edges.keys());

  const restored: string[] = [];
  for (const connection of laidOut.connections.values()) {
    if (renderedAfter.has(connection.id) || !renderedBefore.has(connection.id)) continue;
    const edge = createDockedEdge(
      laidOut,
      connection,
      uniqueEdgeId(previousEdgeIds.get(connection.id), connection.id, takenEdgeIds)
    );
    if (!edge) continue;
    laidOut.diagram.edges.set(edge.id, edge);
    takenEdgeIds.add(edge.id);
    restored.push(connection.id);
  }
  if (restored.length > 0) rerouteRestoredEdges(laidOut, restored);
  return restored;
}

/**
 * An edge id the layout output does not already use. The pre-layout id is
 * preferred so a diagram that survives a layout keeps stable DI ids.
 */
function uniqueEdgeId(
  preferred: string | undefined,
  connectionId: string,
  taken: Set<string>
): string {
  const candidates = [preferred, `${connectionId}_di`].filter(
    (candidate): candidate is string => candidate !== undefined
  );
  const free = candidates.find(candidate => !taken.has(candidate));
  if (free) return free;
  let suffix = 2;
  while (taken.has(`${connectionId}_di_${suffix}`)) suffix++;
  return `${connectionId}_di_${suffix}`;
}

function createDockedEdge(
  document: BpmnDocument,
  connection: BpmnDocumentConnection,
  edgeId: string
): BpmnEdgeModel | undefined {
  const source = document.elements.get(connection.source);
  const target = document.elements.get(connection.target);
  if (!source || !target) return undefined;
  const waypoints: Position[] = calculateConnectionWaypoints(source, target);
  connection.waypoints = waypoints.map(point => ({ ...point }));
  return {
    id: edgeId,
    connectionId: connection.id,
    waypoints: waypoints.map(point => ({ ...point }))
  };
}

/**
 * Replace the straight docking line with the best orthogonal route the shared
 * router can find. The router needs the edge to exist, which is why this runs
 * after every restored edge has been placed: a restored edge is an obstacle
 * for the next one.
 */
function rerouteRestoredEdges(document: BpmnDocument, connectionIds: string[]): void {
  const router = new ConnectionRouter();
  for (const connectionId of connectionIds) {
    const connection = document.connections.get(connectionId);
    const edge = Array.from(document.diagram.edges.values()).find(
      candidate => candidate.connectionId === connectionId
    );
    if (!connection || !edge) continue;
    let candidates;
    try {
      candidates = router.route(document, connectionId, {
        avoidElementIds: [],
        avoidConnectionIds: [],
        clearance: RESTORED_EDGE_CLEARANCE
      });
    } catch {
      // A route the router cannot even attempt (an endpoint without a shape,
      // for instance) keeps the straight docking line, which still renders.
      continue;
    }
    const selected = candidates.find(candidate => candidate.diagnostics.length === 0)
      ?? candidates[0];
    if (!selected) continue;
    connection.waypoints = selected.waypoints.map(point => ({ ...point }));
    edge.waypoints = selected.waypoints.map(point => ({ ...point }));
    if (selected.labelBounds) edge.labelBounds = { ...selected.labelBounds };
  }
}
