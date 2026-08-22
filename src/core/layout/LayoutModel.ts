export type LayoutDirection =
  | 'top-to-bottom'
  | 'bottom-to-top'
  | 'left-to-right'
  | 'right-to-left';

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutBounds extends LayoutPoint {
  width: number;
  height: number;
}

export type LayoutPortSide = 'top' | 'right' | 'bottom' | 'left';
export type LayoutPortRole = 'incoming' | 'outgoing' | 'bidirectional';

export interface LayoutPort {
  id: string;
  nodeId: string;
  role: LayoutPortRole;
  side: LayoutPortSide;
  position: LayoutPoint;
}

export interface LayoutNode {
  id: string;
  semanticId: string;
  semanticType: string;
  ownerId: string;
  scopeId: string;
  containerId?: string;
  bounds: LayoutBounds;
  ports: LayoutPort[];
  labelId?: string;
  virtual: boolean;
}

export interface LayoutEndpoint {
  nodeId: string;
  portId?: string;
}

export interface LayoutEdgeSegment {
  id: string;
  semanticEdgeId: string;
  order: number;
  source: LayoutEndpoint;
  target: LayoutEndpoint;
  waypoints: LayoutPoint[];
  virtual: boolean;
}

export interface LayoutEdge {
  id: string;
  semanticId: string;
  semanticType: string;
  ownerId: string;
  scopeId: string;
  source: LayoutEndpoint;
  target: LayoutEndpoint;
  waypoints: LayoutPoint[];
  segments: LayoutEdgeSegment[];
  labelId?: string;
}

export type LayoutContainerKind =
  | 'root'
  | 'process'
  | 'collaboration'
  | 'participant'
  | 'subprocess'
  | 'subgraph';

export interface LayoutContainer {
  id: string;
  semanticId: string;
  kind: LayoutContainerKind;
  parentId?: string;
  bounds: LayoutBounds;
  direction: LayoutDirection;
  nodeIds: string[];
  childContainerIds: string[];
  labelId?: string;
}

export type LayoutLabelOwnerKind = 'node' | 'edge' | 'container';

export interface LayoutLabel {
  id: string;
  ownerId: string;
  ownerKind: LayoutLabelOwnerKind;
  text: string;
  bounds: LayoutBounds;
}

export interface LayoutWarning {
  code: string;
  message: string;
  elementId?: string;
}

export interface LayoutModel {
  direction: LayoutDirection;
  nodes: Map<string, LayoutNode>;
  edges: Map<string, LayoutEdge>;
  containers: Map<string, LayoutContainer>;
  labels: Map<string, LayoutLabel>;
  bounds: LayoutBounds;
  warnings: LayoutWarning[];
}

export interface NormalizedLayoutModel {
  direction: LayoutDirection;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  containers: LayoutContainer[];
  labels: LayoutLabel[];
  bounds: LayoutBounds;
  warnings: LayoutWarning[];
}

export interface LayoutValidationResult {
  valid: boolean;
  errors: LayoutWarning[];
}

const EMPTY_BOUNDS: LayoutBounds = { x: 0, y: 0, width: 0, height: 0 };

export function compareLayoutIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createLayoutPorts(
  nodeId: string,
  bounds: LayoutBounds,
  direction: LayoutDirection
): LayoutPort[] {
  const horizontal = direction === 'left-to-right' || direction === 'right-to-left';
  const incomingSide: LayoutPortSide = horizontal
    ? (direction === 'left-to-right' ? 'left' : 'right')
    : (direction === 'top-to-bottom' ? 'top' : 'bottom');
  const outgoingSide: LayoutPortSide = horizontal
    ? (direction === 'left-to-right' ? 'right' : 'left')
    : (direction === 'top-to-bottom' ? 'bottom' : 'top');

  return [
    {
      id: `${nodeId}:port:in`,
      nodeId,
      role: 'incoming',
      side: incomingSide,
      position: pointOnSide(bounds, incomingSide)
    },
    {
      id: `${nodeId}:port:out`,
      nodeId,
      role: 'outgoing',
      side: outgoingSide,
      position: pointOnSide(bounds, outgoingSide)
    }
  ];
}

export function createLayoutSegments(
  edgeId: string,
  source: LayoutEndpoint,
  target: LayoutEndpoint,
  waypoints: LayoutPoint[],
  semanticEdgeId = edgeId
): LayoutEdgeSegment[] {
  return [{
    id: `${edgeId}:segment:0`,
    semanticEdgeId,
    order: 0,
    source: { ...source },
    target: { ...target },
    waypoints: waypoints.map(point => ({ ...point })),
    virtual: false
  }];
}

export function setLayoutEdgeWaypoints(edge: LayoutEdge, waypoints: LayoutPoint[]): LayoutEdge {
  edge.waypoints = waypoints.map(point => ({ ...point }));
  edge.segments = createLayoutSegments(
    edge.id,
    edge.source,
    edge.target,
    edge.waypoints,
    edge.semanticId
  );
  return edge;
}

export function refreshLayoutGeometry(model: LayoutModel): LayoutModel {
  for (const node of model.nodes.values()) {
    node.ports = createLayoutPorts(node.id, node.bounds, model.direction);
  }

  for (const edge of model.edges.values()) {
    const sourceNode = model.nodes.get(edge.source.nodeId);
    const targetNode = model.nodes.get(edge.target.nodeId);
    if (!sourceNode || !targetNode) continue;

    const sourcePort = requiredPort(sourceNode, 'outgoing');
    const targetPort = requiredPort(targetNode, 'incoming');
    edge.source.portId = sourcePort.id;
    edge.target.portId = targetPort.id;
    if (edge.waypoints.length < 2) {
      edge.waypoints = [{ ...sourcePort.position }, { ...targetPort.position }];
    }
    if (edge.segments.length === 0
      || (edge.segments.length === 1 && !edge.segments[0].virtual)) {
      edge.segments = createLayoutSegments(
        edge.id,
        edge.source,
        edge.target,
        edge.waypoints,
        edge.semanticId
      );
    }
  }

  positionLabels(model);
  model.bounds = calculateLayoutBounds(model);
  const root = Array.from(model.containers.values()).find(container => container.kind === 'root');
  if (root) root.bounds = { ...model.bounds };
  return model;
}

export function calculateLayoutBounds(model: LayoutModel, padding = 20): LayoutBounds {
  const points: LayoutBounds[] = [];
  points.push(...Array.from(model.nodes.values(), node => node.bounds));
  points.push(...Array.from(model.labels.values(), label => label.bounds));
  points.push(...Array.from(model.containers.values())
    .filter(container => container.kind !== 'root')
    .map(container => container.bounds));
  for (const edge of model.edges.values()) {
    points.push(...edge.waypoints.map(point => ({ ...point, width: 0, height: 0 })));
  }
  if (points.length === 0) return { ...EMPTY_BOUNDS };

  const minX = Math.min(...points.map(bounds => bounds.x));
  const minY = Math.min(...points.map(bounds => bounds.y));
  const maxX = Math.max(...points.map(bounds => bounds.x + bounds.width));
  const maxY = Math.max(...points.map(bounds => bounds.y + bounds.height));
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2
  };
}

export function normalizeLayoutModel(model: LayoutModel): NormalizedLayoutModel {
  return {
    direction: model.direction,
    nodes: sortedValues(model.nodes).map(node => ({
      ...node,
      bounds: { ...node.bounds },
      ports: [...node.ports]
        .sort((left, right) => compareLayoutIds(left.id, right.id))
        .map(port => ({ ...port, position: { ...port.position } }))
    })),
    edges: sortedValues(model.edges).map(edge => ({
      ...edge,
      source: { ...edge.source },
      target: { ...edge.target },
      waypoints: edge.waypoints.map(point => ({ ...point })),
      segments: [...edge.segments]
        .sort((left, right) => left.order - right.order || compareLayoutIds(left.id, right.id))
        .map(segment => ({
          ...segment,
          source: { ...segment.source },
          target: { ...segment.target },
          waypoints: segment.waypoints.map(point => ({ ...point }))
        }))
    })),
    containers: sortedValues(model.containers).map(container => ({
      ...container,
      bounds: { ...container.bounds },
      nodeIds: [...container.nodeIds].sort(compareLayoutIds),
      childContainerIds: [...container.childContainerIds].sort(compareLayoutIds)
    })),
    labels: sortedValues(model.labels).map(label => ({ ...label, bounds: { ...label.bounds } })),
    bounds: { ...model.bounds },
    warnings: [...model.warnings]
      .sort((left, right) => compareLayoutIds(
        `${left.code}\u0000${left.elementId || ''}\u0000${left.message}`,
        `${right.code}\u0000${right.elementId || ''}\u0000${right.message}`
      ))
      .map(warning => ({ ...warning }))
  };
}

export function validateLayoutModel(model: LayoutModel): LayoutValidationResult {
  const errors: LayoutWarning[] = [];
  const segmentIds = new Set<string>();
  const semanticNodeIds = new Set<string>();
  const semanticEdgeIds = new Set<string>();
  const semanticContainerIds = new Set<string>();
  if (!validBounds(model.bounds, false)) {
    errors.push({ code: 'invalid-diagram-bounds', message: 'Layout has invalid diagram bounds' });
  } else if (!sameBounds(model.bounds, calculateLayoutBounds(model))) {
    errors.push({ code: 'stale-diagram-bounds', message: 'Layout bounds do not match its geometry' });
  }
  for (const [key, node] of model.nodes) {
    if (key !== node.id) {
      errors.push({ code: 'node-map-key-mismatch', message: `Node key ${key} does not match ID ${node.id}`, elementId: node.id });
    }
    if (!validBounds(node.bounds, true)) {
      errors.push({ code: 'invalid-node-bounds', message: `Node ${node.id} has invalid bounds`, elementId: node.id });
    }
    if (!node.virtual && semanticNodeIds.has(node.semanticId)) {
      errors.push({
        code: 'duplicate-semantic-node-id',
        message: `Multiple layout nodes represent semantic node ${node.semanticId}`,
        elementId: node.id
      });
    }
    if (!node.virtual) semanticNodeIds.add(node.semanticId);
    if (node.containerId && !model.containers.has(node.containerId)) {
      errors.push({
        code: 'missing-node-container',
        message: `Node ${node.id} references missing container ${node.containerId}`,
        elementId: node.id
      });
    }
    if (node.containerId && !model.containers.get(node.containerId)?.nodeIds.includes(node.id)) {
      errors.push({
        code: 'nonreciprocal-node-container',
        message: `Node ${node.id} is not listed by container ${node.containerId}`,
        elementId: node.id
      });
    }
    if (!model.containers.has(node.ownerId) || !model.containers.has(node.scopeId)) {
      errors.push({
        code: 'missing-node-ownership',
        message: `Node ${node.id} references missing owner or scope`,
        elementId: node.id
      });
    }
    const portIds = new Set(node.ports.map(port => port.id));
    const hasIncoming = node.ports.some(port => port.role === 'incoming' || port.role === 'bidirectional');
    const hasOutgoing = node.ports.some(port => port.role === 'outgoing' || port.role === 'bidirectional');
    if (portIds.size !== node.ports.length || !hasIncoming || !hasOutgoing) {
      errors.push({ code: 'invalid-node-port-set', message: `Node ${node.id} has an invalid port set`, elementId: node.id });
    }
    for (const port of node.ports) {
      if (port.nodeId !== node.id
        || !validPoint(port.position)
        || !samePoint(port.position, pointOnSide(node.bounds, port.side))) {
        errors.push({ code: 'invalid-node-port', message: `Node ${node.id} has invalid port ${port.id}`, elementId: node.id });
      }
    }
  }
  for (const [key, edge] of model.edges) {
    if (key !== edge.id) {
      errors.push({ code: 'edge-map-key-mismatch', message: `Edge key ${key} does not match ID ${edge.id}`, elementId: edge.id });
    }
    if (semanticEdgeIds.has(edge.semanticId)) {
      errors.push({
        code: 'duplicate-semantic-edge-id',
        message: `Multiple layout edges represent semantic edge ${edge.semanticId}`,
        elementId: edge.id
      });
    }
    semanticEdgeIds.add(edge.semanticId);
    if (!model.containers.has(edge.ownerId) || !model.containers.has(edge.scopeId)) {
      errors.push({
        code: 'missing-edge-ownership',
        message: `Edge ${edge.id} references missing owner or scope`,
        elementId: edge.id
      });
    }
    if (!model.nodes.has(edge.source.nodeId)) {
      errors.push({ code: 'missing-edge-source', message: `Edge ${edge.id} has no source node`, elementId: edge.id });
    }
    if (!model.nodes.has(edge.target.nodeId)) {
      errors.push({ code: 'missing-edge-target', message: `Edge ${edge.id} has no target node`, elementId: edge.id });
    }
    if (edge.waypoints.length < 2 || edge.waypoints.some(point => !validPoint(point))) {
      errors.push({ code: 'invalid-edge-waypoints', message: `Edge ${edge.id} has invalid waypoints`, elementId: edge.id });
    }
    validateEndpointPort(model, edge.id, edge.source, errors);
    validateEndpointPort(model, edge.id, edge.target, errors);
    validateRouteDocking(model, edge, errors);
    if (edge.segments.length === 0) {
      errors.push({ code: 'missing-edge-segments', message: `Edge ${edge.id} has no routing segments`, elementId: edge.id });
    }
    edge.segments.forEach((segment, index) => {
      if (segmentIds.has(segment.id)) {
        errors.push({ code: 'duplicate-segment-id', message: `Duplicate segment ID ${segment.id}`, elementId: edge.id });
      }
      segmentIds.add(segment.id);
      if (segment.semanticEdgeId !== edge.semanticId) {
        errors.push({
          code: 'segment-semantic-edge-mismatch',
          message: `Segment ${segment.id} does not preserve semantic edge ${edge.semanticId}`,
          elementId: edge.id
        });
      }
      if (segment.order !== index) {
        errors.push({ code: 'segment-order-gap', message: `Segment ${segment.id} has non-contiguous order`, elementId: edge.id });
      }
      if (segment.waypoints.length < 2 || segment.waypoints.some(point => !validPoint(point))) {
        errors.push({ code: 'invalid-segment-waypoints', message: `Segment ${segment.id} has invalid waypoints`, elementId: edge.id });
      }
    });
    validateSegmentChain(edge, errors);
  }
  for (const [key, container] of model.containers) {
    if (key !== container.id) {
      errors.push({
        code: 'container-map-key-mismatch',
        message: `Container key ${key} does not match ID ${container.id}`,
        elementId: container.id
      });
    }
    if (semanticContainerIds.has(container.semanticId)) {
      errors.push({
        code: 'duplicate-semantic-container-id',
        message: `Multiple layout containers represent semantic container ${container.semanticId}`,
        elementId: container.id
      });
    }
    semanticContainerIds.add(container.semanticId);
    if (!validBounds(container.bounds, false)) {
      errors.push({
        code: 'invalid-container-bounds',
        message: `Container ${container.id} has invalid bounds`,
        elementId: container.id
      });
    }
    if (container.parentId && !model.containers.has(container.parentId)) {
      errors.push({
        code: 'missing-container-parent',
        message: `Container ${container.id} references missing parent ${container.parentId}`,
        elementId: container.id
      });
    }
    if (container.parentId
      && !model.containers.get(container.parentId)?.childContainerIds.includes(container.id)) {
      errors.push({
        code: 'nonreciprocal-container-parent',
        message: `Container ${container.id} is not listed by parent ${container.parentId}`,
        elementId: container.id
      });
    }
    if (new Set(container.nodeIds).size !== container.nodeIds.length
      || new Set(container.childContainerIds).size !== container.childContainerIds.length) {
      errors.push({
        code: 'duplicate-container-member',
        message: `Container ${container.id} contains duplicate members`,
        elementId: container.id
      });
    }
    for (const nodeId of container.nodeIds) {
      const node = model.nodes.get(nodeId);
      if (!node) {
        errors.push({
          code: 'missing-container-node',
          message: `Container ${container.id} references missing node ${nodeId}`,
          elementId: container.id
        });
      } else if (node.containerId !== container.id) {
        errors.push({
          code: 'nonreciprocal-container-node',
          message: `Container ${container.id} lists node ${nodeId} owned by another container`,
          elementId: container.id
        });
      }
    }
    for (const childId of container.childContainerIds) {
      const child = model.containers.get(childId);
      if (!child) {
        errors.push({
          code: 'missing-child-container',
          message: `Container ${container.id} references missing child ${childId}`,
          elementId: container.id
        });
      } else if (child.parentId !== container.id) {
        errors.push({
          code: 'nonreciprocal-child-container',
          message: `Container ${container.id} lists child ${childId} with another parent`,
          elementId: container.id
        });
      }
    }
    if (container.kind === 'participant' || container.kind === 'subprocess') {
      const node = model.nodes.get(container.semanticId);
      if (node && !sameBounds(node.bounds, container.bounds)) {
        errors.push({
          code: 'container-node-bounds-mismatch',
          message: `Container ${container.id} and its semantic node have different bounds`,
          elementId: container.id
        });
      }
    }
  }
  validateContainerCycles(model, errors);
  for (const [key, label] of model.labels) {
    if (key !== label.id) {
      errors.push({ code: 'label-map-key-mismatch', message: `Label key ${key} does not match ID ${label.id}`, elementId: label.id });
    }
    const ownerExists = label.ownerKind === 'node'
      ? model.nodes.has(label.ownerId)
      : label.ownerKind === 'edge'
        ? model.edges.has(label.ownerId)
        : model.containers.has(label.ownerId);
    if (!ownerExists || !validBounds(label.bounds, false)) {
      errors.push({ code: 'invalid-layout-label', message: `Label ${label.id} has invalid ownership or bounds`, elementId: label.id });
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateRouteDocking(model: LayoutModel, edge: LayoutEdge, errors: LayoutWarning[]): void {
  const sourcePort = edge.source.portId
    ? model.nodes.get(edge.source.nodeId)?.ports.find(port => port.id === edge.source.portId)
    : undefined;
  const targetPort = edge.target.portId
    ? model.nodes.get(edge.target.nodeId)?.ports.find(port => port.id === edge.target.portId)
    : undefined;
  const sourceRoleValid = sourcePort?.role === 'outgoing' || sourcePort?.role === 'bidirectional';
  const targetRoleValid = targetPort?.role === 'incoming' || targetPort?.role === 'bidirectional';
  if (!sourceRoleValid || !targetRoleValid
    || !samePoint(edge.waypoints[0], sourcePort?.position)
    || !samePoint(edge.waypoints[edge.waypoints.length - 1], targetPort?.position)) {
    errors.push({
      code: 'undocked-edge-route',
      message: `Edge ${edge.id} is not docked to compatible endpoint ports`,
      elementId: edge.id
    });
  }
}

function validateContainerCycles(model: LayoutModel, errors: LayoutWarning[]): void {
  for (const container of model.containers.values()) {
    const visited = new Set<string>();
    let current: LayoutContainer | undefined = container;
    while (current?.parentId) {
      if (visited.has(current.id)) {
        errors.push({
          code: 'container-cycle',
          message: `Container ${container.id} participates in a containment cycle`,
          elementId: container.id
        });
        break;
      }
      visited.add(current.id);
      current = model.containers.get(current.parentId);
    }
  }
}

function validateSegmentChain(edge: LayoutEdge, errors: LayoutWarning[]): void {
  if (edge.segments.length === 0) return;
  const first = edge.segments[0];
  const last = edge.segments[edge.segments.length - 1];
  if (!sameEndpoint(first.source, edge.source) || !sameEndpoint(last.target, edge.target)) {
    errors.push({
      code: 'segment-endpoint-mismatch',
      message: `Segments for edge ${edge.id} do not connect its semantic endpoints`,
      elementId: edge.id
    });
  }
  for (let index = 1; index < edge.segments.length; index++) {
    const previous = edge.segments[index - 1];
    const current = edge.segments[index];
    if (!sameEndpoint(previous.target, current.source)
      || !samePoint(previous.waypoints[previous.waypoints.length - 1], current.waypoints[0])) {
      errors.push({
        code: 'disconnected-edge-segments',
        message: `Segments for edge ${edge.id} are not continuous at index ${index}`,
        elementId: edge.id
      });
    }
  }
  const flattened = edge.segments.flatMap((segment, index) =>
    index === 0 ? segment.waypoints : segment.waypoints.slice(1));
  if (flattened.length !== edge.waypoints.length
    || flattened.some((point, index) => !samePoint(point, edge.waypoints[index]))) {
    errors.push({
      code: 'segment-waypoint-mismatch',
      message: `Segments for edge ${edge.id} disagree with its aggregate waypoints`,
      elementId: edge.id
    });
  }
}

function validateEndpointPort(
  model: LayoutModel,
  edgeId: string,
  endpoint: LayoutEndpoint,
  errors: LayoutWarning[]
): void {
  if (!endpoint.portId) return;
  const node = model.nodes.get(endpoint.nodeId);
  if (!node?.ports.some(port => port.id === endpoint.portId)) {
    errors.push({
      code: 'missing-endpoint-port',
      message: `Edge ${edgeId} references missing port ${endpoint.portId}`,
      elementId: edgeId
    });
  }
}

function requiredPort(node: LayoutNode, role: LayoutPortRole): LayoutPort {
  const port = node.ports.find(candidate => candidate.role === role);
  if (!port) throw new Error(`Layout node ${node.id} has no ${role} port`);
  return port;
}

function validBounds(bounds: LayoutBounds, requirePositiveSize: boolean): boolean {
  return validPoint(bounds)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && (requirePositiveSize ? bounds.width > 0 && bounds.height > 0 : bounds.width >= 0 && bounds.height >= 0);
}

function validPoint(point: LayoutPoint | undefined): point is LayoutPoint {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(left: LayoutPoint | undefined, right: LayoutPoint | undefined): boolean {
  return left !== undefined && right !== undefined && left.x === right.x && left.y === right.y;
}

function sameEndpoint(left: LayoutEndpoint, right: LayoutEndpoint): boolean {
  return left.nodeId === right.nodeId && left.portId === right.portId;
}

function sameBounds(left: LayoutBounds, right: LayoutBounds): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function pointOnSide(bounds: LayoutBounds, side: LayoutPortSide): LayoutPoint {
  switch (side) {
    case 'top': return { x: bounds.x + bounds.width / 2, y: bounds.y };
    case 'right': return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
    case 'bottom': return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
    case 'left': return { x: bounds.x, y: bounds.y + bounds.height / 2 };
  }
}

function positionLabels(model: LayoutModel): void {
  for (const label of model.labels.values()) {
    const width = Math.max(1, Math.min(300, label.text.length * 7));
    const height = 20;
    if (label.ownerKind === 'node') {
      const node = model.nodes.get(label.ownerId);
      if (node) label.bounds = {
        x: node.bounds.x + (node.bounds.width - width) / 2,
        y: node.bounds.y + (node.bounds.height - height) / 2,
        width,
        height
      };
    } else if (label.ownerKind === 'edge') {
      const edge = model.edges.get(label.ownerId);
      const middle = edge?.waypoints[Math.floor(edge.waypoints.length / 2)];
      if (middle) label.bounds = { x: middle.x - width / 2, y: middle.y - height - 4, width, height };
    } else {
      const container = model.containers.get(label.ownerId);
      if (container) label.bounds = { x: container.bounds.x + 10, y: container.bounds.y + 5, width, height };
    }
  }
}

function sortedValues<T extends { id: string }>(values: Map<string, T>): T[] {
  return Array.from(values.values()).sort((left, right) => compareLayoutIds(left.id, right.id));
}
