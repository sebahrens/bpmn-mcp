import { SimpleBpmnEngine } from '../core/SimpleBpmnEngine.js';
import { BpmnSvgRenderer } from '../core/BpmnSvgRenderer.js';
import { config } from '../config/index.js';
import type { ResourceLimits } from '../config/index.js';
import { TypeMappings } from '../utils/TypeMappings.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MermaidConverter } from '../converters/MermaidConverter.js';
import { FileManager } from '../utils/FileManager.js';
import { diagramContext } from '../core/DiagramContext.js';
import { BpmnValidator } from '../core/BpmnValidator.js';
import {
  BpmnAutoLayoutV2Adapter,
  formatBpmnLayoutDiagnostic
} from '../core/layout/BpmnLayoutAdapter.js';
import type {
  AssociationDirection,
  BpmnDocumentConnection,
  BpmnDocumentElement,
  BpmnLane,
  Position,
  Size,
  ValidationLevel
} from '../types/index.js';
import {
  parseToolRequest,
  type ParsedToolRequest,
  type ToolArguments,
  type ToolName
} from './tools.js';

type ToolDispatchers = {
  [Name in ToolName]: (args: ToolArguments<Name>) => Promise<CallToolResult>;
};

interface ElementQueryView {
  id: string;
  type: string;
  name?: string;
  kind: BpmnDocumentElement['kind'] | 'lane';
  ownerId: string;
  scopeId: string;
  position: Position;
  size: Size;
  properties: Record<string, unknown>;
  processRef?: string;
  defaultFlow?: string;
}

interface AssociationQueryView {
  id: string;
  type: 'bpmn:Association';
  kind: 'association';
  ownerId: string;
  scopeId: string;
  sourceId: string;
  targetId: string;
  associationDirection: AssociationDirection;
  waypoints: Position[];
}

export class BpmnRequestHandler {
  private engine: SimpleBpmnEngine;
  private mermaidConverter: MermaidConverter;
  private validator: BpmnValidator;
  private svgRenderer: BpmnSvgRenderer;
  private fileManager: FileManager;
  private resourceLimits: ResourceLimits;
  private readonly dispatchers: ToolDispatchers = {
    new_bpmn: args => this.newBpmn(args),
    new_from_mermaid: args => this.newFromMermaid(args),
    open_bpmn: args => this.openBpmn(args),
    open_mermaid_file: args => this.openMermaidFile(args),
    save: () => this.save(),
    save_as: args => this.saveAs(args),
    close: () => this.close(),
    current: () => this.current(),
    add_event: args => this.addEvent(args),
    add_activity: args => this.addActivity(args),
    add_gateway: args => this.addGateway(args),
    add_data_object: args => this.addDataObject(args),
    add_text_annotation: args => this.addTextAnnotation(args),
    connect: args => this.connect(args),
    add_association: args => this.addAssociation(args),
    add_pool: args => this.addPool(args),
    add_lane: args => this.addLane(args),
    list_elements: args => this.listElements(args),
    get_element: args => this.getElement(args),
    update_element: args => this.updateElement(args),
    delete_element: args => this.deleteElement(args),
    export: args => this.export(args),
    validate: args => this.validate(args),
    auto_layout: args => this.autoLayout(args),
    list_diagrams: args => this.listDiagrams(args),
    delete_diagram_file: args => this.deleteDiagramFile(args),
    get_diagrams_path: () => this.getDiagramsPath()
  };

  constructor(
    engine = new SimpleBpmnEngine(),
    mermaidConverter: MermaidConverter | undefined = undefined,
    resourceLimits: ResourceLimits = config.resourceLimits,
    svgRenderer = new BpmnSvgRenderer()
  ) {
    this.engine = engine;
    this.mermaidConverter = mermaidConverter ?? new MermaidConverter(
      new BpmnAutoLayoutV2Adapter(
        undefined,
        resourceLimits.layoutTimeoutMs,
        resourceLimits.maxConcurrentLayouts
      ),
      resourceLimits
    );
    this.validator = new BpmnValidator();
    this.svgRenderer = svgRenderer;
    this.fileManager = new FileManager(engine.getDiagramsPath());
    this.resourceLimits = { ...resourceLimits };
  }

  async handleRequest(name: string, args: unknown): Promise<CallToolResult> {
    try {
      const request = parseToolRequest(name, args);
      return await this.dispatch(request);
    } catch (error: unknown) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage(error)}`
          }
        ],
        isError: true
      };
    }
  }

  private dispatch(request: ParsedToolRequest): Promise<CallToolResult> {
    switch (request.name) {
      case 'new_bpmn': return this.dispatchers.new_bpmn(request.args);
      case 'new_from_mermaid': return this.dispatchers.new_from_mermaid(request.args);
      case 'open_bpmn': return this.dispatchers.open_bpmn(request.args);
      case 'open_mermaid_file': return this.dispatchers.open_mermaid_file(request.args);
      case 'save': return this.dispatchers.save(request.args);
      case 'save_as': return this.dispatchers.save_as(request.args);
      case 'close': return this.dispatchers.close(request.args);
      case 'current': return this.dispatchers.current(request.args);
      case 'add_event': return this.dispatchers.add_event(request.args);
      case 'add_activity': return this.dispatchers.add_activity(request.args);
      case 'add_gateway': return this.dispatchers.add_gateway(request.args);
      case 'add_data_object': return this.dispatchers.add_data_object(request.args);
      case 'add_text_annotation': return this.dispatchers.add_text_annotation(request.args);
      case 'connect': return this.dispatchers.connect(request.args);
      case 'add_association': return this.dispatchers.add_association(request.args);
      case 'add_pool': return this.dispatchers.add_pool(request.args);
      case 'add_lane': return this.dispatchers.add_lane(request.args);
      case 'list_elements': return this.dispatchers.list_elements(request.args);
      case 'get_element': return this.dispatchers.get_element(request.args);
      case 'update_element': return this.dispatchers.update_element(request.args);
      case 'delete_element': return this.dispatchers.delete_element(request.args);
      case 'export': return this.dispatchers.export(request.args);
      case 'validate': return this.dispatchers.validate(request.args);
      case 'auto_layout': return this.dispatchers.auto_layout(request.args);
      case 'list_diagrams': return this.dispatchers.list_diagrams(request.args);
      case 'delete_diagram_file': return this.dispatchers.delete_diagram_file(request.args);
      case 'get_diagrams_path': return this.dispatchers.get_diagrams_path(request.args);
      default: return assertNever(request);
    }
  }

  // Creation tools
  private async newBpmn(args: ToolArguments<'new_bpmn'>): Promise<CallToolResult> {
    const { name, type = 'process', extensionProfile = 'portable' } = args;
    const context = await this.engine.createProcess(name, type, extensionProfile);
    
    diagramContext.setCurrent(context, name);
    
    return {
      content: [
        {
          type: 'text',
          text: `Created new ${type} diagram "${name}"\nExtension profile: ${context.extensionProfile}`
        }
      ]
    };
  }

  private async newFromMermaid(args: ToolArguments<'new_from_mermaid'>): Promise<CallToolResult> {
    const { name, mermaidCode, extensionProfile = 'portable' } = args;
    this.assertMermaidByteLimit(mermaidCode);
    
    // Convert Mermaid to BPMN
    const conversionResult = await this.mermaidConverter.convert(mermaidCode);
    
    // Import the XML into the engine
    const context = await this.engine.importXml(conversionResult.xml, name, extensionProfile);
    
    diagramContext.setCurrent(context, name);
    
    return {
      content: [
        {
          type: 'text',
          text: `Created new BPMN diagram "${name}" from Mermaid\nExtension profile: ${context.extensionProfile}\nElements: ${conversionResult.stats.nodeCount} nodes, ${conversionResult.stats.edgeCount} flows${this.conversionWarningText(conversionResult.warnings)}`
        }
      ]
    };
  }

  // File operations
  private async openBpmn(args: ToolArguments<'open_bpmn'>): Promise<CallToolResult> {
    const { filename } = args;
    
    const context = await this.engine.loadDiagram(filename);
    diagramContext.setCurrent(context, context.name);
    
    return {
      content: [
        {
          type: 'text',
          text: `Opened BPMN diagram "${context.name}" from ${filename}\nExtension profile: ${context.extensionProfile}\nElements: ${context.elements.size}, Connections: ${context.connections.size}`
        }
      ]
    };
  }

  private async openMermaidFile(args: ToolArguments<'open_mermaid_file'>): Promise<CallToolResult> {
    const { filename, extensionProfile = 'portable' } = args;
    
    const mermaidCode = await this.fileManager.readMermaidFile(
      filename,
      this.resourceLimits.maxMermaidBytes
    );
    
    // Convert to BPMN
    const conversionResult = await this.mermaidConverter.convert(mermaidCode);
    
    // Import the XML
    // Extract name from filename
    const name = filename.replace(/\.(mmd|mermaid|txt)$/i, '');
    const context = await this.engine.importXml(conversionResult.xml, name, extensionProfile);
    
    diagramContext.setCurrent(context, name);
    
    return {
      content: [
        {
          type: 'text',
          text: `Opened and converted Mermaid file "${filename}" to BPMN\nExtension profile: ${context.extensionProfile}\nElements: ${conversionResult.stats.nodeCount} nodes, ${conversionResult.stats.edgeCount} flows${this.conversionWarningText(conversionResult.warnings)}`
        }
      ]
    };
  }

  private async save(): Promise<CallToolResult> {
    const info = diagramContext.getCurrentInfo();
    if (!info) {
      throw new Error('No current diagram to save');
    }
    
    if (!info.filename) {
      throw new Error('No filename set. Use save_as() to specify a filename');
    }
    
    const context = diagramContext.getCurrent();
    await this.engine.save(context.id);
    
    return {
      content: [
        {
          type: 'text',
          text: `Saved diagram "${info.name}" to ${info.filename}`
        }
      ]
    };
  }

  private async saveAs(args: ToolArguments<'save_as'>): Promise<CallToolResult> {
    const { filename } = args;
    const context = diagramContext.getCurrent();
    const info = diagramContext.getCurrentInfo()!;
    const activeFilename = await this.engine.saveAs(context.id, filename);
    
    return {
      content: [
        {
          type: 'text',
          text: `Saved diagram "${info.name}" as ${activeFilename}`
        }
      ]
    };
  }

  private async close(): Promise<CallToolResult> {
    const info = diagramContext.getCurrentInfo();
    if (!info) {
      throw new Error('No current diagram to close');
    }
    
    const name = info.name;
    diagramContext.clear();
    
    return {
      content: [
        {
          type: 'text',
          text: `Closed diagram "${name}"`
        }
      ]
    };
  }

  private async current(): Promise<CallToolResult> {
    const info = diagramContext.getCurrentInfo();
    
    if (!info) {
      return {
        content: [
          {
            type: 'text',
            text: 'No current diagram'
          }
        ]
      };
    }
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(info, null, 2)
        }
      ]
    };
  }

  // Element manipulation methods
  private async addEvent(args: ToolArguments<'add_event'>): Promise<CallToolResult> {
    const {
      eventType,
      name,
      eventDefinition,
      eventDefinitionPayload,
      cancelActivity,
      position,
      attachTo,
      ownerId,
      scopeId
    } = args;
    const context = diagramContext.getCurrent();
    
    const bpmnType = TypeMappings.mapEventType(eventType, eventDefinition);
    const elementDef = {
      type: bpmnType,
      name,
      position,
      properties: {
        eventDefinition,
        eventDefinitionPayload,
        cancelActivity,
        attachTo
      },
      ownerId,
      scopeId
    };

    const element = await this.engine.createElement(context.id, elementDef);

    return {
      content: [
        {
          type: 'text',
          text: `Added ${eventType} event "${name || 'Unnamed'}" with ID: ${element.id}`
        }
      ]
    };
  }

  private async addActivity(args: ToolArguments<'add_activity'>): Promise<CallToolResult> {
    const { activityType, name, position, properties = {}, ownerId, scopeId } = args;
    const context = diagramContext.getCurrent();
    
    const bpmnType = TypeMappings.mapActivityType(activityType);
    const elementDef = {
      type: bpmnType,
      name,
      position,
      properties,
      ownerId,
      scopeId
    };

    const element = await this.engine.createElement(context.id, elementDef);

    return {
      content: [
        {
          type: 'text',
          text: `Added ${activityType} "${name}" with ID: ${element.id}`
        }
      ]
    };
  }

  private async addGateway(args: ToolArguments<'add_gateway'>): Promise<CallToolResult> {
    const { gatewayType, name, position, ownerId, scopeId } = args;
    const context = diagramContext.getCurrent();
    
    const bpmnType = TypeMappings.mapGatewayType(gatewayType);
    const elementDef = {
      type: bpmnType,
      name,
      position,
      ownerId,
      scopeId
    };

    const element = await this.engine.createElement(context.id, elementDef);

    return {
      content: [
        {
          type: 'text',
          text: `Added ${gatewayType} gateway "${name || 'Gateway'}" with ID: ${element.id}`
        }
      ]
    };
  }

  private async addDataObject(args: ToolArguments<'add_data_object'>): Promise<CallToolResult> {
    const {
      name,
      position,
      isCollection = false,
      itemSubjectRef,
      ownerId,
      scopeId
    } = args;
    const context = diagramContext.getCurrent();
    const { dataObject, reference } = await this.engine.addDataObject(context.id, name, {
      position,
      isCollection,
      itemSubjectRef,
      ownerId,
      scopeId
    });

    return {
      content: [{
        type: 'text',
        text: `Added data object "${name}" with reference ID: ${reference.id} and backing ID: ${dataObject.id}`
      }]
    };
  }

  private async addTextAnnotation(
    args: ToolArguments<'add_text_annotation'>
  ): Promise<CallToolResult> {
    const { text, textFormat, position, size, associatedElementId } = args;
    const context = diagramContext.getCurrent();
    const { annotation, association } = await this.engine.addTextAnnotation(context.id, text, {
      textFormat,
      position,
      size,
      associatedElementId
    });

    return {
      content: [{
        type: 'text',
        text: association
          ? `Added text annotation ${annotation.id} with association ${association.id} to ${associatedElementId}`
          : `Added text annotation ${annotation.id}`
      }]
    };
  }

  private async connect(args: ToolArguments<'connect'>): Promise<CallToolResult> {
    const {
      sourceId,
      targetId,
      label,
      condition,
      conditionLanguage,
      conditionType,
      isDefault
    } = args;
    const context = diagramContext.getCurrent();

    await this.engine.connect(context.id, sourceId, targetId, label, {
      condition,
      conditionLanguage,
      conditionType,
      isDefault
    });

    return {
      content: [
        {
          type: 'text',
          text: `Connected ${sourceId} to ${targetId}${label ? ` with label "${label}"` : ''}`
        }
      ]
    };
  }

  private async addAssociation(args: ToolArguments<'add_association'>): Promise<CallToolResult> {
    const { sourceId, targetId, associationDirection = 'None' } = args;
    const context = diagramContext.getCurrent();
    const association = await this.engine.addAssociation(
      context.id,
      sourceId,
      targetId,
      associationDirection
    );

    return {
      content: [{
        type: 'text',
        text: `Added association ${association.id} from ${sourceId} to ${targetId} (${associationDirection})`
      }]
    };
  }

  private async addPool(args: ToolArguments<'add_pool'>): Promise<CallToolResult> {
    const { name, position, size, blackBox = false } = args;
    const context = diagramContext.getCurrent();
    
    if (context.type !== 'collaboration') {
      throw new Error('Pools can only be added to collaborations. Create a collaboration first with new_bpmn()');
    }

    const elementDef = {
      type: 'bpmn:Participant' as const,
      name,
      position: position || { x: 100, y: 100 },
      size: size || { width: 600, height: 250 },
      properties: { blackBox }
    };

    const element = await this.engine.createElement(context.id, elementDef);

    return {
      content: [
        {
          type: 'text',
          text: `Added pool "${name}" with ID: ${element.id}`
        }
      ]
    };
  }

  private async addLane(args: ToolArguments<'add_lane'>): Promise<CallToolResult> {
    const { poolId, name, flowNodeIds, position = 'bottom' } = args;
    const context = diagramContext.getCurrent();
    const lane = await this.engine.addLane(context.id, poolId, name, flowNodeIds, position);

    return {
      content: [{
        type: 'text',
        text: `Added lane "${name}" with ID: ${lane.id}; assigned ${lane.flowNodeRefs.length} flow node(s)`
      }]
    };
  }

  // Query and manipulation methods
  private async listElements(args: ToolArguments<'list_elements'>): Promise<CallToolResult> {
    const { elementType, limit, offset } = args;
    const context = diagramContext.getCurrent();
    const associationCount = Array.from(context.connections.values())
      .filter(connection => connection.type === 'bpmn:Association').length;
    const candidateCount = context.elements.size + context.document.lanes.size + associationCount;
    if (candidateCount > this.resourceLimits.maxListingItems) {
      throw new Error(
        `Element listing rejected: item limit ${this.resourceLimits.maxListingItems} exceeded`
      );
    }
    if (context.connections.size > this.resourceLimits.maxListingItems) {
      throw new Error(
        `Element listing rejected: connection scan limit ${this.resourceLimits.maxListingItems} exceeded`
      );
    }
    
    const associations: AssociationQueryView[] = Array.from(context.connections.values())
      .filter((connection): connection is BpmnDocumentConnection & { type: 'bpmn:Association' } => (
        connection.type === 'bpmn:Association'
      ))
      .map(associationQueryView);
    const elements: Array<ElementQueryView | AssociationQueryView> = [
      ...Array.from(context.elements.values()),
      ...Array.from(context.document.lanes.values(), laneQueryView),
      ...associations
    ];
    const incomingCounts = new Map<string, number>();
    const outgoingCounts = new Map<string, number>();
    for (const connection of context.connections.values()) {
      incomingCounts.set(connection.target, (incomingCounts.get(connection.target) ?? 0) + 1);
      outgoingCounts.set(connection.source, (outgoingCounts.get(connection.source) ?? 0) + 1);
    }

    const filteredElements = elements.filter(e => {
      if (elementType) {
        return e.type === elementType;
      }
      return true;
    }).sort((left, right) => compareStableText(left.id, right.id));

    const page = filteredElements.slice(offset, offset + limit);

    const elementList = page.map(e => {
      if (e.kind === 'association') return e;
      return {
        id: e.id,
        type: e.type,
        name: e.name,
        ownerId: e.ownerId,
        scopeId: e.scopeId,
        processRef: e.kind === 'participant' ? e.processRef : undefined,
        position: e.position,
        size: e.size,
        defaultFlow: e.kind === 'flowNode' ? e.defaultFlow : undefined,
        incoming: incomingCounts.get(e.id) ?? 0,
        outgoing: outgoingCounts.get(e.id) ?? 0
      };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: filteredElements.length,
            returnedCount: elementList.length,
            offset,
            limit,
            hasMore: offset + elementList.length < filteredElements.length,
            elements: elementList
          }, null, 2)
        }
      ]
    };
  }

  private async getElement(args: ToolArguments<'get_element'>): Promise<CallToolResult> {
    const { elementId } = args;
    const context = diagramContext.getCurrent();
    
    const connection = context.connections.get(elementId);
    if (connection?.type === 'bpmn:Association') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(associationQueryView(connection), null, 2)
        }]
      };
    }

    const lane = context.document.lanes.get(elementId);
    const element: ElementQueryView | undefined = context.elements.get(elementId)
      ?? (lane ? laneQueryView(lane) : undefined);
    if (!element) {
      throw new Error(`Element ${elementId} not found`);
    }

    const incoming = [];
    const outgoing = [];
    for (const connection of context.connections.values()) {
      if (connection.target === elementId) incoming.push(connection);
      if (connection.source === elementId) outgoing.push(connection);
    }

    const details = {
      id: element.id,
      type: element.type,
      name: element.name,
      ownerId: element.ownerId,
      scopeId: element.scopeId,
      processRef: element.kind === 'participant' ? element.processRef : undefined,
      position: element.position,
      size: element.size,
      defaultFlow: element.kind === 'flowNode' ? element.defaultFlow : undefined,
      incoming: incoming.map(c => ({ id: c.id, source: c.source })),
      outgoing: outgoing.map(c => ({
        id: c.id,
        type: c.type,
        target: c.target,
        label: c.label,
        condition: c.condition,
        isDefault: element.kind === 'flowNode' && element.defaultFlow === c.id
      })),
      properties: element.properties
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(details, null, 2)
        }
      ]
    };
  }

  private async updateElement(args: ToolArguments<'update_element'>): Promise<CallToolResult> {
    const { elementId, name, properties, defaultFlow } = args;
    const context = diagramContext.getCurrent();
    await this.engine.updateElement(context.id, elementId, {
      name,
      properties,
      ...(Object.prototype.hasOwnProperty.call(args, 'defaultFlow') ? { defaultFlow } : {})
    });

    return {
      content: [
        {
          type: 'text',
          text: `Updated element ${elementId}`
        }
      ]
    };
  }

  private async deleteElement(args: ToolArguments<'delete_element'>): Promise<CallToolResult> {
    const { elementId } = args;
    const context = diagramContext.getCurrent();
    const connection = context.connections.get(elementId);
    if (connection?.type === 'bpmn:Association') {
      await this.engine.deleteAssociation(context.id, elementId);
      return {
        content: [{ type: 'text', text: `Deleted association ${elementId}` }]
      };
    }
    const removedConnectionCount = await this.engine.deleteElement(context.id, elementId);

    return {
      content: [
        {
          type: 'text',
          text: `Deleted element ${elementId} and ${removedConnectionCount} associated connections`
        }
      ]
    };
  }

  // Utility methods
  private async export(args: ToolArguments<'export'>): Promise<CallToolResult> {
    const { format = 'xml', formatted = true } = args;
    const context = diagramContext.getCurrent();
    
    if (format === 'svg') {
      const xml = await this.engine.exportXml(context.id, true);
      const svg = await this.svgRenderer.render(xml);
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `bpmn://diagram/${encodeURIComponent(context.id)}.svg`,
              mimeType: 'image/svg+xml',
              text: svg
            }
          }
        ]
      };
    }
    
    const content = await this.engine.exportXml(context.id, formatted);

    return {
      content: [
        {
          type: 'text',
          text: content
        }
      ]
    };
  }

  private async validate(args: ToolArguments<'validate'>): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const level = (args.level || 'full') as ValidationLevel;
    const xml = await this.engine.exportXml(context.id, true);
    const result = await this.validator.validate(xml, level);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  private async autoLayout(args: ToolArguments<'auto_layout'>): Promise<CallToolResult> {
    const { algorithm = 'horizontal' } = args;
    const context = diagramContext.getCurrent();
    
    const elementCount = context.elements.size;
    const connectionCount = context.connections.size;
    
    // Apply auto-layout
    const layout = await this.engine.applyAutoLayout(context.id, algorithm);
    const warningText = layout.warnings.length === 0
      ? ''
      : `\n\nWarnings:\n${layout.warnings.map(formatBpmnLayoutDiagnostic).join('\n')}`;
    
    return {
      content: [
        {
          type: 'text',
          text: `Applied ${algorithm} auto-layout to current diagram\n\nRepositioned ${elementCount} elements and ${connectionCount} connections.${warningText}`
        }
      ]
    };
  }

  private conversionWarningText(warnings: string[]): string {
    return warnings.length === 0 ? '' : `\n\nWarnings:\n${warnings.join('\n')}`;
  }

  private assertMermaidByteLimit(mermaidCode: string): void {
    if (Buffer.byteLength(mermaidCode, 'utf8') > this.resourceLimits.maxMermaidBytes) {
      throw new Error('Mermaid import exceeds the configured byte limit');
    }
  }

  // File management methods
  private async listDiagrams(
    args: ToolArguments<'list_diagrams'>
  ): Promise<CallToolResult> {
    const { limit, offset } = args;
    const diagrams = (await this.engine.listDiagrams())
      .sort((left, right) => compareStableText(left.filename, right.filename));
    const page = diagrams.slice(offset, offset + limit);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: diagrams.length,
            returnedCount: page.length,
            offset,
            limit,
            hasMore: offset + page.length < diagrams.length,
            diagrams: page,
            path: this.engine.getDiagramsPath()
          }, null, 2)
        }
      ]
    };
  }

  private async deleteDiagramFile(
    args: ToolArguments<'delete_diagram_file'>
  ): Promise<CallToolResult> {
    const { filename } = args;
    await this.engine.deleteDiagram(filename);
    if (diagramContext.getCurrentInfo()?.filename === filename) {
      diagramContext.clear();
    }
    
    return {
      content: [
        {
          type: 'text',
          text: `Deleted diagram file: ${filename}`
        }
      ]
    };
  }

  private async getDiagramsPath(): Promise<CallToolResult> {
    const path = this.engine.getDiagramsPath();
    
    return {
      content: [
        {
          type: 'text',
          text: `BPMN diagrams are saved to: ${path}\n\nYou can set a custom path using the environment variable: MCP_BPMN_DIAGRAMS_PATH`
        }
      ]
    };
  }
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function laneQueryView(lane: BpmnLane): ElementQueryView {
  return {
    ...lane,
    kind: 'lane',
    type: 'bpmn:Lane',
    ownerId: lane.processId,
    scopeId: lane.processId,
    properties: { flowNodeRefs: lane.flowNodeRefs }
  };
}

function associationQueryView(connection: BpmnDocumentConnection): AssociationQueryView {
  return {
    id: connection.id,
    type: 'bpmn:Association',
    kind: 'association',
    ownerId: connection.ownerId,
    scopeId: connection.scopeId,
    sourceId: connection.source,
    targetId: connection.target,
    associationDirection: connection.associationDirection ?? 'None',
    waypoints: connection.waypoints.map(point => ({ ...point }))
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

function assertNever(value: never): never {
  throw new Error(`Unhandled validated tool request: ${String(value)}`);
}
