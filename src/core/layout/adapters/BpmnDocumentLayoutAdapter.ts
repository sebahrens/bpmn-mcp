import type {
  BpmnDocument,
  BpmnDocumentElement,
  ProcessContext
} from '../../../types/index.js';
import { synchronizeDiagramInterchange } from '../../BpmnDocument.js';
import {
  compareLayoutIds,
  createLayoutPorts,
  createLayoutSegments,
  refreshLayoutGeometry,
  validateLayoutModel,
  type LayoutBounds,
  type LayoutContainer,
  type LayoutDirection,
  type LayoutEdge,
  type LayoutLabel,
  type LayoutModel,
  type LayoutNode
} from '../LayoutModel.js';

export class BpmnDocumentLayoutAdapter {
  static fromContext(
    context: ProcessContext,
    direction: LayoutDirection = 'left-to-right'
  ): LayoutModel {
    return this.fromDocument(context.document, direction);
  }

  static fromDocument(
    document: BpmnDocument,
    direction: LayoutDirection = 'left-to-right'
  ): LayoutModel {
    const nodes = new Map<string, LayoutNode>();
    const edges = new Map<string, LayoutEdge>();
    const containers = new Map<string, LayoutContainer>();
    const labels = new Map<string, LayoutLabel>();
    const rootId = document.diagram.planeElementId;
    const participantByProcess = new Map<string, string>();
    const rootName = document.processes.get(rootId)?.name || document.collaborations.get(rootId)?.name;
    const rootLabelId = rootName ? `${rootId}:container-label` : undefined;

    for (const element of sortedValues(document.elements)) {
      if (element.kind === 'participant' && element.processRef) {
        participantByProcess.set(element.processRef, element.id);
      }
    }

    containers.set(rootId, {
      id: rootId,
      semanticId: rootId,
      kind: 'root',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      direction,
      nodeIds: [],
      childContainerIds: [],
      labelId: rootLabelId
    });
    if (rootName && rootLabelId) {
      labels.set(rootLabelId, createLabel(rootLabelId, rootId, 'container', rootName));
    }

    for (const process of sortedValues(document.processes)) {
      if (process.id === rootId) continue;
      const participantId = participantByProcess.get(process.id);
      const processLabelId = process.name && !participantId ? `${process.id}:container-label` : undefined;
      containers.set(process.id, {
        id: process.id,
        semanticId: process.id,
        kind: 'process',
        parentId: participantId || rootId,
        bounds: participantId
          ? boundsForElement(document.elements.get(participantId))
          : { x: 0, y: 0, width: 0, height: 0 },
        direction,
        nodeIds: [],
        childContainerIds: [],
        labelId: processLabelId
      });
      if (process.name && processLabelId) {
        labels.set(processLabelId, createLabel(processLabelId, process.id, 'container', process.name));
      }
    }

    for (const element of sortedValues(document.elements)) {
      const bounds = boundsForElement(element);
      const containerId = visualContainerId(element, rootId, participantByProcess);
      const labelText = element.kind === 'participant'
        ? undefined
        : element.name || (typeof element.properties.text === 'string' ? element.properties.text : undefined);
      const labelId = labelText ? `${element.id}:label` : undefined;
      nodes.set(element.id, {
        id: element.id,
        semanticId: element.id,
        semanticType: element.type,
        ownerId: element.ownerId,
        scopeId: element.scopeId,
        containerId,
        bounds,
        ports: createLayoutPorts(element.id, bounds, direction),
        labelId,
        virtual: false
      });
      if (labelText && labelId) {
        labels.set(labelId, createLabel(labelId, element.id, 'node', labelText));
      }

      if (element.kind === 'participant') {
        const participantLabelId = element.name ? `${element.id}:container-label` : undefined;
        containers.set(element.id, {
          id: element.id,
          semanticId: element.id,
          kind: 'participant',
          parentId: rootId,
          bounds: { ...bounds },
          direction,
          nodeIds: [],
          childContainerIds: element.processRef ? [element.processRef] : [],
          labelId: participantLabelId
        });
        if (element.name && participantLabelId) {
          labels.set(participantLabelId, createLabel(
            participantLabelId,
            element.id,
            'container',
            element.name
          ));
        }
      } else if (element.type === 'bpmn:SubProcess' || element.type === 'bpmn:Transaction') {
        containers.set(element.id, {
          id: element.id,
          semanticId: element.id,
          kind: 'subprocess',
          parentId: containerId,
          bounds: { ...bounds },
          direction,
          nodeIds: [],
          childContainerIds: []
        });
      }
    }

    for (const node of nodes.values()) {
      const container = containers.get(node.containerId || rootId) || containers.get(rootId)!;
      if (node.id !== container.id) container.nodeIds.push(node.id);
    }
    for (const container of containers.values()) {
      if (container.id === rootId || !container.parentId) continue;
      const parent = containers.get(container.parentId);
      if (parent && !parent.childContainerIds.includes(container.id)) {
        parent.childContainerIds.push(container.id);
      }
    }
    updateDerivedContainerBounds(containers, nodes, rootId);

    for (const connection of sortedValues(document.connections)) {
      const source = nodes.get(connection.source);
      const target = nodes.get(connection.target);
      if (!source || !target) {
        throw new Error(`BPMN connection ${connection.id} references a missing source or target`);
      }
      const sourceEndpoint = { nodeId: source.id, portId: `${source.id}:port:out` };
      const targetEndpoint = { nodeId: target.id, portId: `${target.id}:port:in` };
      const waypoints = connection.waypoints.map(point => ({ ...point }));
      const labelId = connection.label ? `${connection.id}:label` : undefined;
      edges.set(connection.id, {
        id: connection.id,
        semanticId: connection.id,
        semanticType: connection.type,
        ownerId: connection.ownerId,
        scopeId: connection.scopeId,
        source: sourceEndpoint,
        target: targetEndpoint,
        waypoints,
        segments: createLayoutSegments(connection.id, sourceEndpoint, targetEndpoint, waypoints),
        labelId
      });
      if (connection.label && labelId) {
        labels.set(labelId, createLabel(labelId, connection.id, 'edge', connection.label));
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

  static applyToDocument(model: LayoutModel, document: BpmnDocument): BpmnDocument {
    const validation = validateLayoutModel(model);
    if (!validation.valid) {
      throw new Error(validation.errors.map(error => error.message).join('; '));
    }

    const semanticNodes = [...model.nodes.values()].filter(node => !node.virtual);
    if (semanticNodes.length !== document.elements.size) {
      throw new Error('Layout does not represent every BPMN element exactly once');
    }
    if (model.edges.size !== document.connections.size) {
      throw new Error('Layout does not represent every BPMN connection exactly once');
    }
    const root = [...model.containers.values()].find(container => container.kind === 'root');
    if (!root || root.semanticId !== document.diagram.planeElementId) {
      throw new Error('Layout root does not match the BPMN plane target');
    }
    const participantByProcess = new Map<string, string>();
    for (const element of document.elements.values()) {
      if (element.kind === 'participant' && element.processRef) {
        participantByProcess.set(element.processRef, element.id);
      }
    }
    for (const node of semanticNodes) {
      const element = document.elements.get(node.semanticId);
      if (!element) {
        throw new Error(`Layout node ${node.id} references missing BPMN element ${node.semanticId}`);
      }
      const expectedContainerId = visualContainerId(
        element,
        document.diagram.planeElementId,
        participantByProcess
      );
      if (node.semanticType !== element.type
        || node.ownerId !== element.ownerId
        || node.scopeId !== element.scopeId
        || node.containerId !== expectedContainerId) {
        throw new Error(`Layout node ${node.id} changes BPMN semantic metadata`);
      }
    }
    for (const edge of model.edges.values()) {
      const connection = document.connections.get(edge.semanticId);
      if (!connection) throw new Error(`Layout edge ${edge.id} references missing BPMN connection ${edge.semanticId}`);
      const sourceSemanticId = model.nodes.get(edge.source.nodeId)?.semanticId;
      const targetSemanticId = model.nodes.get(edge.target.nodeId)?.semanticId;
      if (connection.source !== sourceSemanticId || connection.target !== targetSemanticId) {
        throw new Error(`Layout edge ${edge.id} changes semantic connectivity`);
      }
      if (edge.semanticType !== connection.type
        || edge.ownerId !== connection.ownerId
        || edge.scopeId !== connection.scopeId) {
        throw new Error(`Layout edge ${edge.id} changes BPMN semantic metadata`);
      }
    }

    for (const node of semanticNodes) {
      const element = document.elements.get(node.semanticId)!;
      element.position = { x: node.bounds.x, y: node.bounds.y };
      element.size = { width: node.bounds.width, height: node.bounds.height };
    }

    for (const edge of model.edges.values()) {
      const connection = document.connections.get(edge.semanticId)!;
      connection.waypoints = edge.waypoints.map(point => ({ ...point }));
    }

    synchronizeDiagramInterchange(document);
    return document;
  }

  static applyToContext(model: LayoutModel, context: ProcessContext): ProcessContext {
    this.applyToDocument(model, context.document);
    return context;
  }
}

export function bpmnDocumentToLayoutModel(
  document: BpmnDocument,
  direction: LayoutDirection = 'left-to-right'
): LayoutModel {
  return BpmnDocumentLayoutAdapter.fromDocument(document, direction);
}

export function processContextToLayoutModel(
  context: ProcessContext,
  direction: LayoutDirection = 'left-to-right'
): LayoutModel {
  return BpmnDocumentLayoutAdapter.fromContext(context, direction);
}

function visualContainerId(
  element: BpmnDocumentElement,
  rootId: string,
  participantByProcess: Map<string, string>
): string {
  if (element.kind === 'participant') return rootId;
  if (element.scopeId !== element.ownerId) return element.scopeId;
  return participantByProcess.get(element.ownerId) || element.ownerId;
}

function boundsForElement(element: BpmnDocumentElement | undefined): LayoutBounds {
  if (!element) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: element.position.x,
    y: element.position.y,
    width: element.size.width,
    height: element.size.height
  };
}

function updateDerivedContainerBounds(
  containers: Map<string, LayoutContainer>,
  nodes: Map<string, LayoutNode>,
  rootId: string
): void {
  const derived = [...containers.values()]
    .filter(container => container.kind === 'process' && container.bounds.width === 0)
    .sort((left, right) => compareLayoutIds(left.id, right.id));
  for (const container of derived) {
    container.bounds = paddedBounds(container.nodeIds.map(id => nodes.get(id)?.bounds).filter(isBounds));
  }
  const root = containers.get(rootId)!;
  root.bounds = paddedBounds([
    ...root.nodeIds.map(id => nodes.get(id)?.bounds).filter(isBounds),
    ...root.childContainerIds.map(id => containers.get(id)?.bounds).filter(isBounds)
  ]);
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
  return { x: minX - 20, y: minY - 20, width: maxX - minX + 40, height: maxY - minY + 40 };
}

function createLabel(
  id: string,
  ownerId: string,
  ownerKind: LayoutLabel['ownerKind'],
  text: string
): LayoutLabel {
  return { id, ownerId, ownerKind, text, bounds: { x: 0, y: 0, width: 0, height: 0 } };
}

function isBounds(value: LayoutBounds | undefined): value is LayoutBounds {
  return value !== undefined;
}

function sortedValues<T extends { id: string }>(values: Map<string, T>): T[] {
  return Array.from(values.values()).sort((left, right) => compareLayoutIds(left.id, right.id));
}
