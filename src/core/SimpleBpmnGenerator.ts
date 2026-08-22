import type { MermaidAST, MermaidNode, NodeType } from '../converters/ASTTypes.js';
import type { ConversionResult } from '../converters/types.js';
import type {
  BpmnArtifactElement,
  BpmnDocumentConnection,
  BpmnFlowNodeElement,
  BpmnFlowNodeType,
  BpmnParticipantElement
} from '../types/index.js';
import {
  validateLayoutModel,
  type LayoutContainer,
  type LayoutEdge,
  type LayoutModel,
  type LayoutNode
} from './layout/LayoutModel.js';
import { MermaidAstLayoutAdapter } from './layout/adapters/MermaidAstLayoutAdapter.js';
import {
  BpmnDocumentSerializer,
  createBpmnDocument,
  getDefaultElementSize
} from './BpmnDocument.js';

const NODE_TYPE_MAPPING: Record<NodeType, {
  prefix: string;
  type: BpmnFlowNodeType | 'bpmn:DataObjectReference';
}> = {
  start: { prefix: 'StartEvent', type: 'bpmn:StartEvent' },
  end: { prefix: 'EndEvent', type: 'bpmn:EndEvent' },
  process: { prefix: 'Task', type: 'bpmn:Task' },
  decision: { prefix: 'Gateway', type: 'bpmn:ExclusiveGateway' },
  subprocess: { prefix: 'SubProcess', type: 'bpmn:SubProcess' },
  data: { prefix: 'DataObjectReference', type: 'bpmn:DataObjectReference' },
  terminator: { prefix: 'Event', type: 'bpmn:IntermediateThrowEvent' }
};

export class SimpleBpmnGenerator {
  private idCounter = 0;
  private readonly serializer = new BpmnDocumentSerializer();

  async generateBpmn(
    ast: MermaidAST,
    processName: string,
    layout?: LayoutModel
  ): Promise<ConversionResult> {
    const startTime = Date.now();
    this.idCounter = 0;
    const sourceLayout = MermaidAstLayoutAdapter.toLayoutModel(ast);
    if (ast.subgraphs.some(subgraph => (subgraph.subgraphs?.length || 0) > 0)) {
      throw new Error('Nested Mermaid subgraphs are not supported for BPMN generation');
    }
    const effectiveLayout = layout || sourceLayout;
    const layoutValidation = validateLayoutModel(effectiveLayout);
    if (!layoutValidation.valid) {
      throw new Error(layoutValidation.errors.map(error => error.message).join('; '));
    }
    const layoutNodesBySemanticId = this.indexBySemanticId(effectiveLayout.nodes, 'node');
    const layoutEdgesBySemanticId = this.indexBySemanticId(effectiveLayout.edges, 'edge');
    const layoutContainersBySemanticId = this.indexBySemanticId(effectiveLayout.containers, 'container');
    this.assertLayoutMatchesAst(
      sourceLayout,
      effectiveLayout,
      layoutNodesBySemanticId,
      layoutEdgesBySemanticId,
      layoutContainersBySemanticId
    );
    const hasSubgraphs = ast.subgraphs.length > 0;
    const rootId = this.generateId(hasSubgraphs ? 'Collaboration' : 'Process');
    const document = createBpmnDocument(rootId, processName, hasSubgraphs ? 'collaboration' : 'process');
    const elements: ConversionResult['elements'] = [];
    const flows: ConversionResult['flows'] = [];
    const pools: ConversionResult['pools'] = [];
    const nodeIdMap = new Map<string, string>();
    const cleanedNodes = this.cleanupNodes(ast);
    const processBySubgraph = new Map<string, string>();

    if (hasSubgraphs) {
      for (const subgraph of [...ast.subgraphs].sort((left, right) => this.compareIds(left.id, right.id))) {
        const participantId = this.generateId('Participant');
        const subgraphProcessId = this.generateId('Process');
        document.processes.set(subgraphProcessId, {
          id: subgraphProcessId,
          name: subgraph.title,
          isExecutable: true
        });
        processBySubgraph.set(subgraph.id, subgraphProcessId);

        const containerBounds = layoutContainersBySemanticId.get(subgraph.id)?.bounds;
        const participant: BpmnParticipantElement = {
          kind: 'participant',
          id: participantId,
          type: 'bpmn:Participant',
          name: subgraph.title,
          ownerId: rootId,
          scopeId: rootId,
          processRef: subgraphProcessId,
          position: containerBounds
            ? { x: containerBounds.x, y: containerBounds.y }
            : { x: 50, y: 50 + pools.length * 300 },
          size: containerBounds
            ? { width: containerBounds.width, height: containerBounds.height }
            : getDefaultElementSize('bpmn:Participant'),
          properties: {}
        };
        document.elements.set(participantId, participant);
        pools.push({ id: participantId, name: subgraph.title, lanes: [] });
      }
    }

    for (const node of cleanedNodes) {
      const nodeType = NODE_TYPE_MAPPING[node.type];
      const bpmnType = nodeType.type;
      const bpmnId = `${nodeType.prefix}_${node.id}`;
      const layoutNode = layoutNodesBySemanticId.get(node.id)!;
      const ownerId = hasSubgraphs
        ? processBySubgraph.get(layoutNode.ownerId)
        : rootId;
      if (!ownerId) throw new Error(`Mermaid node ${node.id} is not owned by a subgraph`);
      let x = 100 + elements.length * 150;
      let y = 100;
      x = layoutNode.bounds.x;
      y = layoutNode.bounds.y;

      const size = { width: layoutNode.bounds.width, height: layoutNode.bounds.height };
      let modelElement: BpmnArtifactElement | BpmnFlowNodeElement;
      if (bpmnType === 'bpmn:DataObjectReference') {
        const dataObjectId = `DataObject_${node.id}`;
        document.dataObjects.set(dataObjectId, {
          id: dataObjectId,
          name: this.elementName(node, dataObjectId),
          ownerId,
          scopeId: ownerId
        });
        modelElement = {
          kind: 'artifact',
          id: bpmnId,
          type: bpmnType,
          name: this.elementName(node, bpmnId),
          ownerId,
          scopeId: ownerId,
          position: { x, y },
          size,
          properties: { dataObjectRef: dataObjectId }
        };
      } else {
        modelElement = {
          kind: 'flowNode',
          id: bpmnId,
          type: bpmnType,
          name: this.elementName(node, bpmnId),
          ownerId,
          scopeId: ownerId,
          position: { x, y },
          size,
          properties: {}
        };
      }
      document.elements.set(bpmnId, modelElement);
      elements.push({ id: bpmnId, type: bpmnType, businessObject: {}, x, y });
      nodeIdMap.set(node.id, bpmnId);
    }

    for (const edge of [...ast.edges].sort((left, right) => this.compareIds(left.id, right.id))) {
      const sourceId = nodeIdMap.get(edge.source);
      const targetId = nodeIdMap.get(edge.target);
      if (!sourceId || !targetId) {
        continue;
      }
      const source = document.elements.get(sourceId)!;
      const target = document.elements.get(targetId)!;
      if (source.kind !== 'flowNode' || target.kind !== 'flowNode') {
        throw new Error(`Mermaid edge ${edge.id} cannot be represented as a BPMN sequence flow`);
      }

      const isInternal = source.ownerId === target.ownerId;
      const flowId = this.generateId(isInternal ? 'Flow' : 'MessageFlow');
      const layoutEdge = layoutEdgesBySemanticId.get(edge.id)!;
      const connection: BpmnDocumentConnection = {
        id: flowId,
        source: sourceId,
        target: targetId,
        type: isInternal ? 'bpmn:SequenceFlow' : 'bpmn:MessageFlow',
        ownerId: isInternal ? source.ownerId : rootId,
        scopeId: isInternal ? source.scopeId : rootId,
        label: edge.label,
        waypoints: layoutEdge.waypoints.map(point => ({ ...point })),
        properties: {}
      };
      document.connections.set(flowId, connection);
      flows.push({ id: flowId, source: sourceId, target: targetId, label: edge.label });
    }

    const xml = await this.serializer.serialize(document);
    return {
      processId: rootId,
      xml,
      elements,
      flows,
      pools,
      lanes: [],
      statistics: {
        totalElements: elements.length,
        tasks: elements.filter(element => element.type.includes('Task')).length,
        events: elements.filter(element => element.type.includes('Event')).length,
        gateways: elements.filter(element => element.type.includes('Gateway')).length,
        flows: flows.length
      },
      warnings: effectiveLayout.warnings.map(warning => warning.message),
      confidence: 0.9,
      conversionTime: Date.now() - startTime,
      stats: {
        nodeCount: ast.nodes.length,
        edgeCount: ast.edges.length
      }
    };
  }

  private cleanupNodes(ast: MermaidAST): MermaidNode[] {
    const nodes = new Map<string, MermaidNode>();
    for (const node of ast.nodes) {
      if (!node.id.includes('|')) {
        nodes.set(node.id, node);
      }
    }
    return Array.from(nodes.values()).sort((left, right) => this.compareIds(left.id, right.id));
  }

  private generateId(type: string): string {
    return `${type.replace('bpmn:', '')}_${++this.idCounter}`;
  }

  private compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private indexBySemanticId<T extends { semanticId: string; virtual?: boolean }>(
    values: Map<string, T>,
    subject: string
  ): Map<string, T> {
    const indexed = new Map<string, T>();
    for (const value of values.values()) {
      if (value.virtual) continue;
      if (indexed.has(value.semanticId)) {
        throw new Error(`Duplicate layout ${subject} semantic ID: ${value.semanticId}`);
      }
      indexed.set(value.semanticId, value);
    }
    return indexed;
  }

  private assertLayoutMatchesAst(
    source: LayoutModel,
    supplied: LayoutModel,
    nodesBySemanticId: Map<string, LayoutNode>,
    edgesBySemanticId: Map<string, LayoutEdge>,
    containersBySemanticId: Map<string, LayoutContainer>
  ): void {
    if (source.direction !== supplied.direction) {
      throw new Error(`Layout direction ${supplied.direction} does not match Mermaid direction ${source.direction}`);
    }
    for (const sourceNode of source.nodes.values()) {
      const suppliedNode = nodesBySemanticId.get(sourceNode.semanticId);
      if (!suppliedNode
        || suppliedNode.semanticType !== sourceNode.semanticType
        || suppliedNode.ownerId !== sourceNode.ownerId
        || suppliedNode.scopeId !== sourceNode.scopeId) {
        throw new Error(`Layout does not preserve Mermaid node ${sourceNode.semanticId}`);
      }
    }
    if (nodesBySemanticId.size !== source.nodes.size) {
      throw new Error('Layout contains nodes that are not present in the Mermaid AST');
    }
    for (const sourceEdge of source.edges.values()) {
      const suppliedEdge = edgesBySemanticId.get(sourceEdge.semanticId);
      const suppliedSourceId = suppliedEdge
        ? supplied.nodes.get(suppliedEdge.source.nodeId)?.semanticId
        : undefined;
      const suppliedTargetId = suppliedEdge
        ? supplied.nodes.get(suppliedEdge.target.nodeId)?.semanticId
        : undefined;
      if (!suppliedEdge
        || suppliedEdge.semanticType !== sourceEdge.semanticType
        || suppliedEdge.ownerId !== sourceEdge.ownerId
        || suppliedEdge.scopeId !== sourceEdge.scopeId
        || suppliedSourceId !== sourceEdge.source.nodeId
        || suppliedTargetId !== sourceEdge.target.nodeId) {
        throw new Error(`Layout does not preserve Mermaid edge ${sourceEdge.semanticId}`);
      }
    }
    if (edgesBySemanticId.size !== source.edges.size) {
      throw new Error('Layout contains edges that are not present in the Mermaid AST');
    }
    for (const sourceContainer of source.containers.values()) {
      const suppliedContainer = containersBySemanticId.get(sourceContainer.semanticId);
      if (!suppliedContainer || suppliedContainer.kind !== sourceContainer.kind) {
        throw new Error(`Layout does not preserve Mermaid container ${sourceContainer.semanticId}`);
      }
    }
    if (containersBySemanticId.size !== source.containers.size) {
      throw new Error('Layout contains containers that are not present in the Mermaid AST');
    }
  }

  private elementName(node: MermaidNode, elementId: string): string | undefined {
    if (node.type === 'start' || node.type === 'end') {
      const genericName = node.type === 'start' ? /start/i : /end/i;
      if (node.label === elementId || genericName.test(node.label)) {
        return undefined;
      }
    }
    return node.label;
  }
}
