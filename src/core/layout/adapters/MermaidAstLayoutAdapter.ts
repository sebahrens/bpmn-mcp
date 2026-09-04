import type {
  MermaidAST,
  MermaidSubgraph,
  NodeType
} from '../../../converters/ASTTypes.js';
import {
  compareLayoutIds,
  createLayoutPorts,
  createLayoutSegments,
  refreshLayoutGeometry,
  type LayoutBounds,
  type LayoutContainer,
  type LayoutDirection,
  type LayoutEdge,
  type LayoutLabel,
  type LayoutModel,
  type LayoutNode
} from '../LayoutModel.js';

const ROOT_CONTAINER_ID = 'mermaid:root';

export const MERMAID_NODE_SIZES: Record<NodeType, { width: number; height: number }> = {
  start: { width: 36, height: 36 },
  end: { width: 36, height: 36 },
  process: { width: 100, height: 80 },
  decision: { width: 50, height: 50 },
  subprocess: { width: 150, height: 100 },
  data: { width: 36, height: 50 },
  terminator: { width: 36, height: 36 }
};

export class MermaidAstLayoutAdapter {
  static toLayoutModel(ast: MermaidAST): LayoutModel {
    const direction = toLayoutDirection(ast.direction);
    const nodes = new Map<string, LayoutNode>();
    const edges = new Map<string, LayoutEdge>();
    const containers = new Map<string, LayoutContainer>();
    const labels = new Map<string, LayoutLabel>();
    const knownNodeIds = new Set(ast.nodes.map(node => node.id));
    const ownerByNode = buildContainerOwnership(ast.subgraphs, knownNodeIds);
    const sortedNodes = [...ast.nodes].sort((left, right) => compareLayoutIds(left.id, right.id));

    assertUniqueIds(sortedNodes, 'Mermaid node');
    assertUniqueIds(ast.edges, 'Mermaid edge');
    sortedNodes.forEach((node, index) => {
      const size = MERMAID_NODE_SIZES[node.type];
      const bounds = defaultNodeBounds(index, sortedNodes.length, size, direction);
      const ownerId = ownerByNode.get(node.id) || ROOT_CONTAINER_ID;
      const labelId = `node:${node.id}:label`;
      nodes.set(node.id, {
        id: node.id,
        semanticId: node.id,
        semanticType: node.type,
        ownerId,
        scopeId: ownerId,
        containerId: ownerId,
        bounds,
        ports: createLayoutPorts(node.id, bounds, direction),
        labelId,
        virtual: false
      });
      labels.set(labelId, createLabel(labelId, node.id, 'node', node.label));
    });

    containers.set(ROOT_CONTAINER_ID, {
      id: ROOT_CONTAINER_ID,
      semanticId: ROOT_CONTAINER_ID,
      kind: 'root',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      direction,
      nodeIds: sortedNodes.filter(node => !ownerByNode.has(node.id)).map(node => node.id),
      childContainerIds: ast.subgraphs.map(subgraph => subgraph.id).sort(compareLayoutIds)
    });
    addSubgraphContainers(ast.subgraphs, ROOT_CONTAINER_ID, direction, containers, labels, nodes);

    for (const edge of [...ast.edges].sort((left, right) => compareLayoutIds(left.id, right.id))) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) {
        throw new Error(`Mermaid edge ${edge.id} references a missing source or target`);
      }
      const sourceEndpoint = { nodeId: source.id, portId: `${source.id}:port:out` };
      const targetEndpoint = { nodeId: target.id, portId: `${target.id}:port:in` };
      const sourcePort = source.ports.find(port => port.role === 'outgoing');
      const targetPort = target.ports.find(port => port.role === 'incoming');
      if (!sourcePort || !targetPort) throw new Error(`Mermaid edge ${edge.id} has no compatible ports`);
      const waypoints = [{ ...sourcePort.position }, { ...targetPort.position }];
      const ownerId = source.ownerId === target.ownerId ? source.ownerId : ROOT_CONTAINER_ID;
      const labelId = edge.label ? `edge:${edge.id}:label` : undefined;
      edges.set(edge.id, {
        id: edge.id,
        semanticId: edge.id,
        semanticType: edge.type,
        ownerId,
        scopeId: ownerId,
        source: sourceEndpoint,
        target: targetEndpoint,
        waypoints,
        segments: createLayoutSegments(edge.id, sourceEndpoint, targetEndpoint, waypoints),
        labelId
      });
      if (edge.label && labelId) {
        labels.set(labelId, createLabel(labelId, edge.id, 'edge', edge.label));
      }
    }

    return refreshLayoutGeometry({
      direction,
      nodes,
      edges,
      containers,
      labels,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      warnings: []
    });
  }
}

export function toLayoutDirection(direction: MermaidAST['direction']): LayoutDirection {
  switch (direction) {
    case 'TD':
    case 'TB':
      return 'top-to-bottom';
    case 'BT':
      return 'bottom-to-top';
    case 'RL':
      return 'right-to-left';
    case 'LR':
      return 'left-to-right';
  }
}

function buildContainerOwnership(
  subgraphs: MermaidSubgraph[],
  knownNodeIds: Set<string>
): Map<string, string> {
  const owners = new Map<string, string>();
  const containerIds = new Set<string>([ROOT_CONTAINER_ID]);
  const visit = (subgraph: MermaidSubgraph): void => {
    if (subgraph.id === ROOT_CONTAINER_ID) {
      throw new Error(`Reserved Mermaid subgraph ID: ${subgraph.id}`);
    }
    if (containerIds.has(subgraph.id)) {
      throw new Error(`Duplicate Mermaid subgraph ID: ${subgraph.id}`);
    }
    containerIds.add(subgraph.id);
    for (const nodeId of subgraph.nodes) {
      if (!knownNodeIds.has(nodeId)) {
        throw new Error(`Mermaid subgraph ${subgraph.id} references unknown node ${nodeId}`);
      }
      const existing = owners.get(nodeId);
      if (existing && existing !== subgraph.id) {
        throw new Error(`Mermaid node ${nodeId} belongs to multiple subgraphs`);
      }
      owners.set(nodeId, subgraph.id);
    }
    for (const child of subgraph.subgraphs || []) visit(child);
  };
  for (const subgraph of subgraphs) visit(subgraph);
  return owners;
}

function addSubgraphContainers(
  subgraphs: MermaidSubgraph[],
  parentId: string,
  direction: LayoutDirection,
  containers: Map<string, LayoutContainer>,
  labels: Map<string, LayoutLabel>,
  nodes: Map<string, LayoutNode>
): void {
  for (const subgraph of [...subgraphs].sort((left, right) => compareLayoutIds(left.id, right.id))) {
    const childContainerIds = (subgraph.subgraphs || []).map(child => child.id).sort(compareLayoutIds);
    const nodeIds = [...subgraph.nodes].sort(compareLayoutIds);
    addSubgraphContainers(subgraph.subgraphs || [], subgraph.id, direction, containers, labels, nodes);
    const bounds = paddedBounds([
      ...nodeIds.map(id => nodes.get(id)?.bounds).filter(isBounds),
      ...childContainerIds.map(id => containers.get(id)?.bounds).filter(isBounds)
    ]);
    const labelId = `container:${subgraph.id}:label`;
    containers.set(subgraph.id, {
      id: subgraph.id,
      semanticId: subgraph.id,
      kind: 'subgraph',
      parentId,
      bounds,
      direction,
      nodeIds,
      childContainerIds,
      labelId
    });
    labels.set(labelId, createLabel(labelId, subgraph.id, 'container', subgraph.title));
  }
}

function defaultNodeBounds(
  index: number,
  count: number,
  size: { width: number; height: number },
  direction: LayoutDirection
): LayoutBounds {
  const reverse = direction === 'right-to-left' || direction === 'bottom-to-top';
  const orderedIndex = reverse ? count - index - 1 : index;
  if (direction === 'left-to-right' || direction === 'right-to-left') {
    return { x: 100 + orderedIndex * 150, y: 100, ...size };
  }
  return { x: 100, y: 100 + orderedIndex * 120, ...size };
}

function createLabel(
  id: string,
  ownerId: string,
  ownerKind: LayoutLabel['ownerKind'],
  text: string
): LayoutLabel {
  return { id, ownerId, ownerKind, text, bounds: { x: 0, y: 0, width: 0, height: 0 } };
}

function paddedBounds(bounds: LayoutBounds[]): LayoutBounds {
  if (bounds.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = bounds.reduce((minimum, item) => Math.min(minimum, item.x), Infinity);
  const minY = bounds.reduce((minimum, item) => Math.min(minimum, item.y), Infinity);
  const maxX = bounds.reduce(
    (maximum, item) => Math.max(maximum, item.x + item.width),
    -Infinity
  );
  const maxY = bounds.reduce(
    (maximum, item) => Math.max(maximum, item.y + item.height),
    -Infinity
  );
  return { x: minX - 20, y: minY - 40, width: maxX - minX + 40, height: maxY - minY + 60 };
}

function isBounds(value: LayoutBounds | undefined): value is LayoutBounds {
  return value !== undefined;
}

function assertUniqueIds(items: Array<{ id: string }>, subject: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate ${subject} ID: ${item.id}`);
    ids.add(item.id);
  }
}
