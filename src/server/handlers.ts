import {
  ConnectionGeometryConflictError,
  ConnectionRoutingFailureError,
  ConnectionSemanticConflictError,
  DocumentRevisionConflictError,
  ElementGeometryConflictError,
  GeometryPatchConflictError,
  SimpleBpmnEngine,
  connectionGeometryRevision,
  connectionSemanticState
} from '../core/SimpleBpmnEngine.js';
import { BpmnSvgRenderer, type PngRenderResult } from '../core/BpmnSvgRenderer.js';
import { config } from '../config/index.js';
import type { ResourceLimits } from '../config/index.js';
import { WorkspaceSession } from '../config/WorkspaceSession.js';
import { TypeMappings } from '../utils/TypeMappings.js';
import { assertSafeFilename } from '../utils/SafeFilePath.js';
import { ToolError, isToolError, type ToolErrorCode } from '../utils/ToolError.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MermaidConverter } from '../converters/MermaidConverter.js';
import { diagramContext } from '../core/DiagramContext.js';
import { BpmnValidator } from '../core/BpmnValidator.js';
import { validateBpmnGeometry } from '../core/BpmnGeometry.js';
import type { GeometryDiagnostic } from '../core/BpmnGeometry.js';
import {
  BpmnAutoLayoutV2Adapter,
  closeActiveLayoutSubprocesses,
  formatBpmnLayoutDiagnostic
} from '../core/layout/BpmnLayoutAdapter.js';
import type {
  AssociationDirection,
  BpmnEdgeModel,
  BpmnDocument,
  BpmnDocumentConnection,
  BpmnDocumentElement,
  BpmnLane,
  Position,
  ProcessContext,
  Size,
  ValidationLevel
} from '../types/index.js';
import {
  parseToolRequest,
  parseToolResult,
  type ParsedToolRequest,
  type ToolArguments,
  type ToolName,
  type ToolResult
} from './tools.js';

type ToolDispatchers = {
  [Name in ToolName]: (args: ToolArguments<Name>) => Promise<CallToolResult>;
};

/** A rendered artifact awaiting persistence, with the PNG's pixel geometry. */
type RenderedArtifact =
  | { format: 'svg'; content: string }
  | {
    format: 'png';
    content: Buffer;
    raster: { width: number; height: number; scale: number; downscaled: boolean };
  };

interface DiagramArtifactRenderer {
  render(xml: string): Promise<string>;
  renderPng(xml: string, scale?: number): Promise<PngRenderResult>;
  close(): Promise<void>;
}

interface ElementQueryView {
  id: string;
  type: string;
  name?: string;
  kind: BpmnDocumentElement['kind'] | 'lane';
  ownerId: string;
  scopeId: string;
  position: Position;
  size: Size;
  shapeId?: string;
  bounds?: Position & Size;
  labelBounds?: Position & Size;
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

interface ConnectionQueryView {
  id: string;
  type: BpmnDocumentConnection['type'];
  ownerId: string;
  scopeId: string;
  sourceId: string;
  targetId: string;
  label?: string;
  condition?: BpmnDocumentConnection['condition'];
  isDefault: boolean;
  defaultOwnerId?: string;
  associationDirection?: AssociationDirection;
  waypoints: Position[];
  edgeId?: string;
  labelBounds?: Position & Size;
  geometryRevision: string;
  semanticRevision: string;
}

export class BpmnRequestHandler {
  private engine: SimpleBpmnEngine;
  private readonly workspace: WorkspaceSession;
  private mermaidConverter: MermaidConverter;
  private validator: BpmnValidator;
  private svgRenderer: DiagramArtifactRenderer;
  private resourceLimits: ResourceLimits;
  private requestQueue: Promise<void> = Promise.resolve();
  private readonly activeSnapshotReads = new Set<Promise<void>>();
  private acceptingRequests = true;
  private shutdownPromise: Promise<void> | undefined;
  private readonly dispatchers: ToolDispatchers = {
    new_bpmn: args => this.newBpmn(args),
    new_from_mermaid: args => this.newFromMermaid(args),
    open_bpmn: args => this.openBpmn(args),
    open_mermaid_file: args => this.openMermaidFile(args),
    save: args => this.save(args),
    save_as: args => this.saveAs(args),
    close: () => this.closeDiagram(),
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
    list_connections: args => this.listConnections(args),
    get_connection: args => this.getConnection(args),
    update_element: args => this.updateElement(args),
    update_connection: args => this.updateConnection(args),
    update_element_geometry: args => this.updateElementGeometry(args),
    update_connection_geometry: args => this.updateConnectionGeometry(args),
    apply_geometry_patch: args => this.applyGeometryPatch(args),
    route_connection: args => this.routeConnection(args),
    build_process: args => this.buildProcess(args),
    delete_element: args => this.deleteElement(args),
    export: args => this.export(args),
    save_svg: args => this.saveSvg(args),
    save_png: args => this.savePng(args),
    validate: args => this.validate(args),
    analyze_geometry: args => this.analyzeGeometry(args),
    auto_layout: args => this.autoLayout(args),
    list_diagrams: args => this.listDiagrams(args),
    delete_diagram_file: args => this.deleteDiagramFile(args),
    get_diagrams_path: () => this.getDiagramsPath(),
    get_workspace: () => this.getWorkspace(),
    select_workspace: args => this.selectWorkspace(args)
  };

  constructor(
    engine = new SimpleBpmnEngine(),
    mermaidConverter: MermaidConverter | undefined = undefined,
    resourceLimits: ResourceLimits = config.resourceLimits,
    svgRenderer: DiagramArtifactRenderer = new BpmnSvgRenderer(),
    workspace = WorkspaceSession.fixed(engine.getDiagramsPath())
  ) {
    this.engine = engine;
    this.workspace = workspace;
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
    this.resourceLimits = { ...resourceLimits };
  }

  /**
   * Execute context-changing tool calls in invocation order. Adjacent exports
   * may run as one read batch after earlier calls finish; later calls wait for
   * that batch, so each export keeps a stable current-diagram snapshot. The
   * recovered queue tail keeps later calls runnable after any rejection.
   */
  handleRequest(name: string, args: unknown): Promise<CallToolResult> {
    if (!this.acceptingRequests) {
      return Promise.resolve(toolErrorResult(new ToolError(
        'server_shutting_down',
        'Server is shutting down',
        { recovery: 'Reconnect to a new server process before retrying.' }
      )));
    }

    if (name === 'export' || name === 'analyze_geometry') {
      return this.enqueueSnapshotRead(name, args);
    }

    const precedingCalls = [this.requestQueue, ...this.activeSnapshotReads];
    const result = Promise.all(precedingCalls).then(() => this.executeRequest(name, args));
    this.requestQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  beginShutdown(): void {
    this.acceptingRequests = false;
  }

  shutdown(): Promise<void> {
    this.beginShutdown();
    this.shutdownPromise ??= this.finishShutdown();
    return this.shutdownPromise;
  }

  async forceCloseResources(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled([
      this.svgRenderer.close(),
      closeActiveLayoutSubprocesses()
    ]);
  }

  private async finishShutdown(): Promise<void> {
    await Promise.all([this.requestQueue, ...this.activeSnapshotReads]);

    if (diagramContext.hasCurrent()) {
      const context = diagramContext.getCurrent();
      await this.engine.releaseProcess(context);
      diagramContext.clear();
    }

    await this.forceCloseResources();
  }

  private enqueueSnapshotRead(name: string, args: unknown): Promise<CallToolResult> {
    const result = this.requestQueue.then(() => this.executeRequest(name, args));
    const completion = result.then(
      () => undefined,
      () => undefined
    );
    this.activeSnapshotReads.add(completion);
    void completion.then(() => this.activeSnapshotReads.delete(completion));
    return result;
  }

  private async executeRequest(name: string, args: unknown): Promise<CallToolResult> {
    let request: ParsedToolRequest;
    try {
      request = parseToolRequest(name, args);
    } catch (error: unknown) {
      // Schema validation runs before any state is touched, so this is always
      // a caller mistake and never a partially applied change.
      return toolErrorResult(new ToolError('invalid_arguments', errorMessage(error), {
        recovery: `Correct the named argument and retry; see the inputSchema for "${name}" in tools/list.`,
        details: { tool: name }
      }));
    }

    try {
      return await this.dispatch(request);
    } catch (error: unknown) {
      if (error instanceof DocumentRevisionConflictError) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            conflict: true,
            reason: error.reason,
            filename: error.filename,
            expectedRevision: error.expectedRevision ?? null,
            actualRevision: error.actualRevision ?? null,
            recovery: error.actualRevision
              ? 'Reopen the file, or retry with actualRevision to explicitly overwrite that version.'
              : 'Reopen the file before retrying.'
          }
        };
      }
      if (error instanceof ElementGeometryConflictError) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            conflict: true,
            elementId: error.elementId,
            expectedBounds: error.expectedBounds,
            actualBounds: error.actualBounds,
            recovery: 'Refresh the element geometry and retry with its current bounds or revision.'
          }
        };
      }
      if (error instanceof ConnectionGeometryConflictError) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            conflict: true,
            reason: error.reason,
            connectionId: error.connectionId,
            ...(error.expectedWaypoints
              ? { expectedWaypoints: error.expectedWaypoints }
              : {}),
            actualWaypoints: error.actualWaypoints,
            expectedGeometryRevision: error.expectedGeometryRevision ?? null,
            actualGeometryRevision: error.actualGeometryRevision,
            recovery: 'Refresh the connection geometry and retry with its current waypoints or geometry revision.'
          }
        };
      }
      if (error instanceof ConnectionSemanticConflictError) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            conflict: true,
            connectionId: error.connectionId,
            expectedSemanticRevision: error.expectedSemanticRevision,
            actualSemanticRevision: error.actualSemanticRevision,
            recovery: 'Refresh the connection and retry with its current semantic or document revision.'
          }
        };
      }
      if (error instanceof GeometryPatchConflictError) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            conflict: true,
            objectType: error.objectType,
            objectId: error.objectId,
            field: error.field,
            expectedValue: error.expectedValue,
            actualValue: error.actualValue,
            recovery: 'Refresh the object geometry and retry with its current before values or document revision.'
          }
        };
      }
      if (error instanceof ConnectionRoutingFailureError) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            connectionId: error.connectionId,
            mutated: false,
            rankedDiagnostics: error.rankedDiagnostics,
            recovery: 'Move an obstacle, reduce clearance, or inspect the ranked candidate diagnostics before retrying.'
          }
        };
      }
      return toolErrorResult(asToolError(error));
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
      case 'list_connections': return this.dispatchers.list_connections(request.args);
      case 'get_connection': return this.dispatchers.get_connection(request.args);
      case 'update_element': return this.dispatchers.update_element(request.args);
      case 'update_connection': return this.dispatchers.update_connection(request.args);
      case 'update_element_geometry': return this.dispatchers.update_element_geometry(request.args);
      case 'update_connection_geometry': return this.dispatchers.update_connection_geometry(request.args);
      case 'apply_geometry_patch': return this.dispatchers.apply_geometry_patch(request.args);
      case 'route_connection': return this.dispatchers.route_connection(request.args);
      case 'build_process': return this.dispatchers.build_process(request.args);
      case 'delete_element': return this.dispatchers.delete_element(request.args);
      case 'export': return this.dispatchers.export(request.args);
      case 'save_svg': return this.dispatchers.save_svg(request.args);
      case 'save_png': return this.dispatchers.save_png(request.args);
      case 'validate': return this.dispatchers.validate(request.args);
      case 'analyze_geometry': return this.dispatchers.analyze_geometry(request.args);
      case 'auto_layout': return this.dispatchers.auto_layout(request.args);
      case 'list_diagrams': return this.dispatchers.list_diagrams(request.args);
      case 'delete_diagram_file': return this.dispatchers.delete_diagram_file(request.args);
      case 'get_diagrams_path': return this.dispatchers.get_diagrams_path(request.args);
      case 'get_workspace': return this.dispatchers.get_workspace(request.args);
      case 'select_workspace': return this.dispatchers.select_workspace(request.args);
      default: return assertNever(request);
    }
  }

  // Creation tools
  private async newBpmn(args: ToolArguments<'new_bpmn'>): Promise<CallToolResult> {
    const { name, type = 'process', extensionProfile = 'portable', filename } = args;
    const context = await this.engine.createProcess(name, type, extensionProfile, filename);
    const replacedDiagram = await this.replaceCurrent(context, name);

    return textToolResult('new_bpmn', {
      processId: context.id,
      name,
      type,
      extensionProfile: context.extensionProfile,
      filename: activeFilename(context),
      ...(replacedDiagram ? { replacedDiagram } : {}),
      revision: context.revision
    }, `Created new ${type} diagram "${name}"\nExtension profile: ${context.extensionProfile}`
      + replacedDiagramText(replacedDiagram));
  }

  private async newFromMermaid(args: ToolArguments<'new_from_mermaid'>): Promise<CallToolResult> {
    const { name, mermaidCode, extensionProfile = 'portable', filename } = args;
    this.assertMermaidByteLimit(mermaidCode);
    
    // Convert Mermaid to BPMN
    const conversionResult = await this.mermaidConverter.convert(mermaidCode);
    
    // Import the XML into the engine
    const context = await this.engine.importXml(
      conversionResult.xml, name, extensionProfile, filename
    );
    const replacedDiagram = await this.replaceCurrent(context, name);
    
    return textToolResult('new_from_mermaid', {
      processId: context.id,
      name,
      type: context.type,
      extensionProfile: context.extensionProfile,
      filename: activeFilename(context),
      ...(replacedDiagram ? { replacedDiagram } : {}),
      revision: context.revision,
      nodeCount: conversionResult.stats.nodeCount,
      flowCount: conversionResult.stats.edgeCount,
      warnings: conversionResult.warnings
    }, `Created new BPMN diagram "${name}" from Mermaid\nExtension profile: ${context.extensionProfile}\nElements: ${conversionResult.stats.nodeCount} nodes, ${conversionResult.stats.edgeCount} flows${replacedDiagramText(replacedDiagram)}${this.conversionWarningText(conversionResult.warnings)}`);
  }

  // File operations
  private async openBpmn(args: ToolArguments<'open_bpmn'>): Promise<CallToolResult> {
    const { filename } = args;
    
    const context = await this.engine.loadDiagram(filename);
    const replacedDiagram = await this.replaceCurrent(context, context.name);
    
    return textToolResult('open_bpmn', {
      processId: context.id,
      name: context.name,
      type: context.type,
      extensionProfile: context.extensionProfile,
      filename: activeFilename(context),
      ...(replacedDiagram ? { replacedDiagram } : {}),
      revision: context.revision,
      elementCount: context.elements.size,
      connectionCount: context.connections.size
    }, `Opened BPMN diagram "${context.name}" from ${filename}\nExtension profile: ${context.extensionProfile}\nElements: ${context.elements.size}, Connections: ${context.connections.size}`
      + replacedDiagramText(replacedDiagram));
  }

  private async openMermaidFile(args: ToolArguments<'open_mermaid_file'>): Promise<CallToolResult> {
    const { filename, bpmnFilename, extensionProfile = 'portable' } = args;
    
    const mermaidCode = await this.engine.readMermaidFile(
      filename,
      this.resourceLimits.maxMermaidBytes
    );
    
    // Convert to BPMN
    const conversionResult = await this.mermaidConverter.convert(mermaidCode);
    
    // Import the XML
    // Extract name from filename
    const name = filename.replace(/\.(mmd|mermaid|txt)$/i, '');
    const context = await this.engine.importXml(
      conversionResult.xml, name, extensionProfile, bpmnFilename
    );
    const replacedDiagram = await this.replaceCurrent(context, name);
    
    return textToolResult('open_mermaid_file', {
      processId: context.id,
      name,
      type: context.type,
      extensionProfile: context.extensionProfile,
      filename: activeFilename(context),
      ...(replacedDiagram ? { replacedDiagram } : {}),
      revision: context.revision,
      sourceFilename: filename,
      nodeCount: conversionResult.stats.nodeCount,
      flowCount: conversionResult.stats.edgeCount,
      warnings: conversionResult.warnings
    }, `Opened and converted Mermaid file "${filename}" to BPMN\nExtension profile: ${context.extensionProfile}\nElements: ${conversionResult.stats.nodeCount} nodes, ${conversionResult.stats.edgeCount} flows${replacedDiagramText(replacedDiagram)}${this.conversionWarningText(conversionResult.warnings)}`);
  }

  private async save(args: ToolArguments<'save'>): Promise<CallToolResult> {
    const info = diagramContext.getCurrentInfo();
    if (!info) {
      throw new ToolError('no_current_diagram', 'No diagram is currently open', {
        recovery: 'Open or create a diagram before saving.'
      });
    }
    
    if (!info.filename) {
      throw new ToolError('invalid_arguments', 'The active diagram has no filename', {
        recovery: 'Use save_as with a filename to give this diagram a file.'
      });
    }
    
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    await this.engine.save(context.id, args.expectedRevision);
    
    return textToolResult('save', {
      processId: context.id,
      name: info.name,
      filename: info.filename,
      beforeRevision,
      afterRevision: context.revision
    }, `Saved diagram "${info.name}" to ${info.filename}`);
  }

  private async saveAs(args: ToolArguments<'save_as'>): Promise<CallToolResult> {
    const { filename, overwrite, expectedRevision } = args;
    const context = diagramContext.getCurrent();
    const info = diagramContext.getCurrentInfo()!;
    const beforeRevision = context.revision;
    const previousFilename = context.filename;
    const previousWasPlaceholder = context.filenameManaged === true;
    const activeFilename = await this.engine.saveAs(
      context.id, filename, expectedRevision, overwrite
    );
    const removedPreviousFile = previousWasPlaceholder
      && previousFilename !== undefined
      && previousFilename !== activeFilename;

    return textToolResult('save_as', {
      processId: context.id,
      name: info.name,
      filename: activeFilename,
      ...(previousFilename ? { previousFilename } : {}),
      removedPreviousFile,
      beforeRevision,
      afterRevision: context.revision
    }, `Saved diagram "${info.name}" as ${activeFilename}`
      + (removedPreviousFile ? ` (removed the generated placeholder ${previousFilename})` : ''));
  }

  private async closeDiagram(): Promise<CallToolResult> {
    const info = diagramContext.getCurrentInfo();
    if (!info) {
      throw new ToolError('no_current_diagram', 'No diagram is currently open', {
        recovery: 'Nothing to close; use current to check the active diagram.'
      });
    }
    
    const context = diagramContext.getCurrent();
    const name = info.name;
    const filename = activeFilename(context);
    await this.engine.releaseProcess(context);
    diagramContext.clear();
    
    return textToolResult('close', {
      processId: context.id,
      name,
      filename,
      revision: context.revision
    }, `Closed diagram "${name}"`);
  }

  /**
   * Make `context` current, reporting the diagram it displaced. Creating or
   * opening a diagram silently closed the previous one, so an agent holding
   * unsaved work in it had no signal at all; every caller now names the
   * replaced diagram in its result text and structured content.
   */
  private async replaceCurrent(
    context: ProcessContext,
    name: string
  ): Promise<ReplacedDiagram | undefined> {
    const previous = diagramContext.hasCurrent()
      ? diagramContext.getCurrent()
      : undefined;
    const previousInfo = previous && previous !== context
      ? { name: diagramContext.getCurrentInfo()?.name ?? previous.name, filename: previous.filename }
      : undefined;
    if (previous && previous !== context) {
      await this.engine.releaseProcess(previous);
    }
    diagramContext.setCurrent(context, name);
    return previousInfo;
  }

  private async current(): Promise<CallToolResult> {
    const info = diagramContext.getCurrentInfo();
    
    if (!info) {
      return textToolResult('current', { current: false }, 'No current diagram');
    }
    
    return textToolResult('current', {
      current: true,
      diagram: {
        ...info,
        filename: activeFilename(diagramContext.getCurrent())
      }
    }, JSON.stringify(info, null, 2));
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
      scopeId,
      documentation,
      expectedRevision
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
        attachTo,
        ...(documentation === undefined ? {} : { documentation })
      },
      ownerId,
      scopeId
    };

    const beforeRevision = context.revision;
    const element = await this.engine.createElement(context.id, elementDef, expectedRevision);

    return textToolResult('add_event', {
      elementId: element.id,
      elementType: element.type,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added ${eventType} event "${name || 'Unnamed'}" with ID: ${element.id}`);
  }

  private async addActivity(args: ToolArguments<'add_activity'>): Promise<CallToolResult> {
    const {
      activityType, name, position, properties = {}, ownerId, scopeId, documentation,
      expectedRevision
    } = args;
    const context = diagramContext.getCurrent();
    
    const bpmnType = TypeMappings.mapActivityType(activityType);
    const elementDef = {
      type: bpmnType,
      name,
      position,
      properties: { ...properties, ...(documentation === undefined ? {} : { documentation }) },
      ownerId,
      scopeId
    };

    const beforeRevision = context.revision;
    const element = await this.engine.createElement(context.id, elementDef, expectedRevision);

    return textToolResult('add_activity', {
      elementId: element.id,
      elementType: element.type,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added ${activityType} "${name}" with ID: ${element.id}`);
  }

  private async addGateway(args: ToolArguments<'add_gateway'>): Promise<CallToolResult> {
    const {
      gatewayType, name, position, ownerId, scopeId, documentation, expectedRevision
    } = args;
    const context = diagramContext.getCurrent();
    
    const bpmnType = TypeMappings.mapGatewayType(gatewayType);
    const elementDef = {
      type: bpmnType,
      name,
      position,
      ...(documentation === undefined ? {} : { properties: { documentation } }),
      ownerId,
      scopeId
    };

    const beforeRevision = context.revision;
    const element = await this.engine.createElement(context.id, elementDef, expectedRevision);

    return textToolResult('add_gateway', {
      elementId: element.id,
      elementType: element.type,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added ${gatewayType} gateway "${name || 'Gateway'}" with ID: ${element.id}`);
  }

  private async addDataObject(args: ToolArguments<'add_data_object'>): Promise<CallToolResult> {
    const {
      name,
      position,
      isCollection = false,
      itemSubjectRef,
      ownerId,
      scopeId,
      expectedRevision
    } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const { dataObject, reference } = await this.engine.addDataObject(context.id, name, {
      position,
      isCollection,
      itemSubjectRef,
      ownerId,
      scopeId,
      expectedRevision
    });

    return textToolResult('add_data_object', {
      referenceId: reference.id,
      dataObjectId: dataObject.id,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added data object "${name}" with reference ID: ${reference.id} and backing ID: ${dataObject.id}`);
  }

  private async addTextAnnotation(
    args: ToolArguments<'add_text_annotation'>
  ): Promise<CallToolResult> {
    const { text, textFormat, position, size, associatedElementId, expectedRevision } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const { annotation, association } = await this.engine.addTextAnnotation(context.id, text, {
      textFormat,
      position,
      size,
      associatedElementId,
      expectedRevision
    });

    return textToolResult('add_text_annotation', {
      annotationId: annotation.id,
      associationId: association?.id,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, association
      ? `Added text annotation ${annotation.id} with association ${association.id} to ${associatedElementId}`
      : `Added text annotation ${annotation.id}`);
  }

  private async connect(args: ToolArguments<'connect'>): Promise<CallToolResult> {
    const {
      sourceId,
      targetId,
      label,
      condition,
      conditionLanguage,
      conditionType,
      isDefault,
      documentation,
      expectedRevision
    } = args;
    const context = diagramContext.getCurrent();

    const beforeRevision = context.revision;
    const connection = await this.engine.connect(context.id, sourceId, targetId, label, {
      condition,
      conditionLanguage,
      conditionType,
      isDefault,
      documentation,
      expectedRevision
    });

    return textToolResult('connect', {
      connectionId: connection.id,
      connectionType: connection.type,
      sourceId,
      targetId,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Connected ${sourceId} to ${targetId}${label ? ` with label "${label}"` : ''}`);
  }

  private async addAssociation(args: ToolArguments<'add_association'>): Promise<CallToolResult> {
    const { sourceId, targetId, associationDirection = 'None', expectedRevision } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const association = await this.engine.addAssociation(
      context.id,
      sourceId,
      targetId,
      associationDirection,
      expectedRevision
    );

    return textToolResult('add_association', {
      associationId: association.id,
      sourceId,
      targetId,
      associationDirection,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added association ${association.id} from ${sourceId} to ${targetId} (${associationDirection})`);
  }

  private async addPool(args: ToolArguments<'add_pool'>): Promise<CallToolResult> {
    const { name, position, size, blackBox = false, expectedRevision } = args;
    const context = diagramContext.getCurrent();
    
    if (context.type !== 'collaboration') {
      throw new ToolError(
        'wrong_object_kind',
        'Pools exist only in collaborations, and the active diagram is a process',
        {
          recovery: 'Create a collaboration with new_bpmn({ type: "collaboration" }), '
            + 'then add pools to it.',
          details: { diagramType: context.type }
        }
      );
    }

    const elementDef = {
      type: 'bpmn:Participant' as const,
      name,
      position: position || defaultPoolPosition(context),
      // Deliberately passed through unset when omitted. The engine applies the
      // participant type default and records that the size was defaulted, so
      // auto_layout can size the pool to its content instead of treating a
      // number the caller never chose as a floor.
      size,
      properties: { blackBox }
    };

    const beforeRevision = context.revision;
    const element = await this.engine.createElement(context.id, elementDef, expectedRevision);

    return textToolResult('add_pool', {
      elementId: element.id,
      processId: element.kind === 'participant' ? element.processRef : undefined,
      blackBox,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added pool "${name}" with ID: ${element.id}`);
  }

  private async addLane(args: ToolArguments<'add_lane'>): Promise<CallToolResult> {
    const { poolId, name, flowNodeIds, position = 'bottom', expectedRevision } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const lane = await this.engine.addLane(
      context.id, poolId, name, flowNodeIds, position, expectedRevision
    );

    return textToolResult('add_lane', {
      laneId: lane.id,
      poolId,
      assignedFlowNodeCount: lane.flowNodeRefs.length,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Added lane "${name}" with ID: ${lane.id}; assigned ${lane.flowNodeRefs.length} flow node(s)`);
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
        // Every row carries its kind, not just associations: an agent paging a
        // mixed listing has to tell participants, lanes, flow nodes and
        // artifacts apart without a lookup table of BPMN type strings.
        kind: e.kind,
        ownerId: e.ownerId,
        scopeId: e.scopeId,
        processRef: e.kind === 'participant' ? e.processRef : undefined,
        position: e.position,
        size: e.size,
        ...elementGeometryQueryFields(context.document, e.id),
        defaultFlow: e.kind === 'flowNode' ? e.defaultFlow : undefined,
        incoming: incomingCounts.get(e.id) ?? 0,
        outgoing: outgoingCounts.get(e.id) ?? 0
      };
    });

    const result = {
      count: filteredElements.length,
      returnedCount: elementList.length,
      offset,
      limit,
      hasMore: offset + elementList.length < filteredElements.length,
      elements: elementList,
      revision: context.revision
    };
    return textToolResult('list_elements', result, JSON.stringify(result, null, 2));
  }

  private async getElement(args: ToolArguments<'get_element'>): Promise<CallToolResult> {
    const { elementId } = args;
    const context = diagramContext.getCurrent();
    
    const connection = context.connections.get(elementId);
    if (connection?.type === 'bpmn:Association') {
      const result = { ...associationQueryView(connection), revision: context.revision };
      return textToolResult('get_element', result, JSON.stringify(result, null, 2));
    }
    if (connection) {
      throw new ToolError(
        'wrong_object_kind',
        `${elementId} is a ${connection.type}, which is a connection rather than an element.`,
        {
          recovery: 'Use get_connection to read it, or list_connections to find it.',
          details: { elementId, actualType: connection.type }
        }
      );
    }

    const lane = context.document.lanes.get(elementId);
    const element: ElementQueryView | undefined = context.elements.get(elementId)
      ?? (lane ? laneQueryView(lane) : undefined);
    if (!element) {
      // add_data_object returns the backing bpmn:DataObject id alongside the
      // rendered reference, so agents reasonably try to read it back here.
      const backingReference = Array.from(context.elements.values()).find(
        candidate => candidate.type === 'bpmn:DataObjectReference'
          && candidate.properties.dataObjectRef === elementId
      );
      if (backingReference) {
        throw new ToolError(
          'wrong_object_kind',
          `${elementId} is the non-rendered bpmn:DataObject backing ${backingReference.id}.`,
          {
            recovery: `Use get_element with ${backingReference.id} instead.`,
            details: { elementId, renderedReferenceId: backingReference.id }
          }
        );
      }
      throw new ToolError('element_not_found', `Element ${elementId} not found`, {
        recovery: 'List elements with list_elements and use an id from that result.',
        details: { elementId }
      });
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
      kind: element.kind,
      ownerId: element.ownerId,
      scopeId: element.scopeId,
      processRef: element.kind === 'participant' ? element.processRef : undefined,
      position: element.position,
      size: element.size,
      ...elementGeometryQueryFields(context.document, element.id),
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
      properties: element.properties,
      revision: context.revision
    };

    return textToolResult('get_element', details, JSON.stringify(details, null, 2));
  }

  private async listConnections(
    args: ToolArguments<'list_connections'>
  ): Promise<CallToolResult> {
    const { connectionType, sourceId, targetId, ownerId, scopeId, limit, offset } = args;
    const context = diagramContext.getCurrent();
    if (context.connections.size > this.resourceLimits.maxListingItems) {
      throw new Error(
        `Connection listing rejected: scan limit ${this.resourceLimits.maxListingItems} exceeded`
      );
    }

    const edgesByConnection = new Map(Array.from(
      context.document.diagram.edges.values(),
      edge => [edge.connectionId, edge]
    ));
    const filtered = Array.from(context.connections.values())
      .filter(connection => (
        (!connectionType || connection.type === connectionType)
        && (!sourceId || connection.source === sourceId)
        && (!targetId || connection.target === targetId)
        && (!ownerId || connection.ownerId === ownerId)
        && (!scopeId || connection.scopeId === scopeId)
      ))
      .sort((left, right) => compareStableText(left.id, right.id));
    const connections = filtered
      .slice(offset, offset + limit)
      .map(connection => connectionQueryView(
        context,
        connection,
        edgesByConnection.get(connection.id)
      ));
    const result = {
      count: filtered.length,
      returnedCount: connections.length,
      offset,
      limit,
      hasMore: offset + connections.length < filtered.length,
      connections,
      revision: context.revision
    };
    return textToolResult('list_connections', result, JSON.stringify(result, null, 2));
  }

  private async getConnection(
    args: ToolArguments<'get_connection'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const connection = context.connections.get(args.connectionId);
    if (!connection) {
      throw new ToolError('connection_not_found', `Connection ${args.connectionId} not found`, {
        recovery: 'List connections with list_connections and use an id from that result.',
        details: { connectionId: args.connectionId }
      });
    }
    const edge = Array.from(context.document.diagram.edges.values()).find(
      candidate => candidate.connectionId === connection.id
    );
    const result = {
      ...connectionQueryView(context, connection, edge),
      revision: context.revision
    };
    return textToolResult('get_connection', result, JSON.stringify(result, null, 2));
  }

  private async updateElement(args: ToolArguments<'update_element'>): Promise<CallToolResult> {
    const { elementId, name, properties, documentation, defaultFlow, expectedRevision } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const mergedProperties = documentation === undefined
      ? properties
      : { ...(properties ?? {}), documentation };
    await this.engine.updateElement(context.id, elementId, {
      name,
      properties: mergedProperties,
      ...(Object.prototype.hasOwnProperty.call(args, 'defaultFlow') ? { defaultFlow } : {})
    }, expectedRevision);

    // The engine leaves the revision alone when the serialized document is
    // unchanged, so an update that matched what was already there is reported
    // as such instead of silently invalidating the caller's revision token.
    const changed = context.revision !== beforeRevision;
    return textToolResult('update_element', {
      elementId,
      changed,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, changed
      ? `Updated element ${elementId}`
      : `Element ${elementId} already had these values, so nothing was written `
        + 'and the revision is unchanged');
  }

  private async updateConnection(
    args: ToolArguments<'update_connection'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const result = await this.engine.updateConnection(context.id, args.connectionId, args);
    const structuredResult = {
      connectionId: args.connectionId,
      ...result,
      endpointPolicy: args.endpointPolicy,
      collisionPolicy: args.collisionPolicy,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    };
    return textToolResult(
      'update_connection',
      structuredResult,
      JSON.stringify(structuredResult, null, 2)
    );
  }

  private async updateElementGeometry(
    args: ToolArguments<'update_element_geometry'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const result = await this.engine.updateElementGeometry(context.id, args.elementId, args);
    const structuredResult = {
      elementId: args.elementId,
      ...result,
      dryRun: args.dryRun,
      applied: !args.dryRun,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    };
    return textToolResult(
      'update_element_geometry',
      structuredResult,
      JSON.stringify(structuredResult, null, 2)
    );
  }

  private async updateConnectionGeometry(
    args: ToolArguments<'update_connection_geometry'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const result = await this.engine.updateConnectionGeometry(
      context.id,
      args.connectionId,
      args
    );
    const structuredResult = {
      connectionId: args.connectionId,
      ...result,
      endpointPolicy: args.endpointPolicy,
      collisionPolicy: args.collisionPolicy,
      dryRun: args.dryRun,
      applied: !args.dryRun,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    };
    return textToolResult(
      'update_connection_geometry',
      structuredResult,
      JSON.stringify(structuredResult, null, 2)
    );
  }

  private async applyGeometryPatch(
    args: ToolArguments<'apply_geometry_patch'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const result = await this.engine.applyGeometryPatch(context.id, args);
    const structuredResult = {
      ...result,
      summary: summarizeGeometryDiagnostics(result.diagnostics),
      collisionPolicy: args.collisionPolicy,
      dryRun: args.dryRun,
      applied: !args.dryRun,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    };
    return textToolResult(
      'apply_geometry_patch',
      structuredResult,
      JSON.stringify(structuredResult, null, 2)
    );
  }

  private async routeConnection(
    args: ToolArguments<'route_connection'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const result = await this.engine.routeConnection(context.id, args.connectionId, args);
    const structuredResult = {
      ...result,
      clearance: args.clearance,
      preserveOtherGeometry: args.preserveOtherGeometry,
      apply: args.apply,
      applied: args.apply,
      filename: activeFilename(context),
      revision: context.revision,
      beforeRevision,
      afterRevision: context.revision
    };
    return textToolResult(
      'route_connection',
      structuredResult,
      JSON.stringify(structuredResult, null, 2)
    );
  }

  private async buildProcess(args: ToolArguments<'build_process'>): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;

    const nodes = args.nodes.map(node => {
      const { kind, ref, ownerId, scopeId, position } = node;
      const shared = { ref, ownerId, scopeId, position };
      if (kind === 'activity') {
        return {
          ...shared,
          type: TypeMappings.mapActivityType(node.activityType),
          name: node.name,
          ...(node.properties ? { properties: { ...node.properties } } : {})
        };
      }
      if (kind === 'gateway') {
        return {
          ...shared,
          type: TypeMappings.mapGatewayType(node.gatewayType),
          name: node.name
        };
      }
      return {
        ...shared,
        type: TypeMappings.mapEventType(node.eventType),
        name: node.name,
        properties: {
          ...(node.eventDefinition ? { eventDefinition: node.eventDefinition } : {}),
          ...(node.attachTo ? { attachTo: node.attachTo } : {}),
          ...(node.cancelActivity !== undefined ? { cancelActivity: node.cancelActivity } : {})
        }
      };
    });

    const result = await this.engine.buildProcess(
      context.id,
      {
        nodes: nodes as Parameters<typeof this.engine.buildProcess>[1]['nodes'],
        flows: args.flows.map(flow => ({
          source: flow.source,
          target: flow.target,
          label: flow.label,
          condition: flow.condition,
          conditionLanguage: flow.conditionLanguage,
          isDefault: flow.isDefault
        }))
      },
      args.expectedRevision
    );

    const structured = {
      ...result,
      elementCount: result.elements.length,
      connectionCount: result.connections.length,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    };
    return textToolResult('build_process', structured, JSON.stringify(structured, null, 2));
  }

  private async deleteElement(args: ToolArguments<'delete_element'>): Promise<CallToolResult> {
    const { elementId, expectedRevision } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;
    const connection = context.connections.get(elementId);
    if (connection) {
      await this.engine.deleteElement(context.id, elementId, expectedRevision);
      const connectionKind = connection.type === 'bpmn:SequenceFlow'
        ? 'sequence flow'
        : connection.type === 'bpmn:MessageFlow'
          ? 'message flow'
          : connection.type === 'bpmn:Association'
            ? 'association'
            : 'connection';
      return textToolResult('delete_element', {
        elementId,
        deletedKind: 'connection',
        removedConnectionCount: 0,
        removedElementCount: 0,
        removedElementIds: [],
        filename: activeFilename(context),
        beforeRevision,
        afterRevision: context.revision
      }, `Deleted ${connectionKind} ${elementId}`);
    }
    const { removedConnectionCount, removedElementIds } = await this.engine.deleteElement(
      context.id, elementId, expectedRevision
    );

    // Deleting a container cascades to everything inside it. Reporting only
    // the connection count hid those removals from the agent entirely.
    const cascaded = removedElementIds.filter(id => id !== elementId);
    const cascadeSummary = cascaded.length > 0
      ? `, ${cascaded.length} contained element${cascaded.length === 1 ? '' : 's'} `
        + `(${cascaded.join(', ')})`
      : '';
    return textToolResult('delete_element', {
      elementId,
      deletedKind: 'element',
      removedConnectionCount,
      removedElementCount: removedElementIds.length,
      removedElementIds,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `Deleted element ${elementId}${cascadeSummary} and ${removedConnectionCount} `
      + `associated connection${removedConnectionCount === 1 ? '' : 's'}`);
  }

  // Utility methods
  private async export(args: ToolArguments<'export'>): Promise<CallToolResult> {
    const { format = 'xml', formatted = true } = args;
    const context = diagramContext.getCurrent();
    
    if (format === 'svg') {
      const xml = await this.engine.exportXml(context.id, true);
      const svg = await this.svgRenderer.render(xml);
      const uri = `bpmn://diagram/${encodeURIComponent(context.id)}.svg`;
      return toolResult('export', {
        processId: context.id,
        filename: activeFilename(context),
        format,
        mimeType: 'image/svg+xml',
        byteLength: Buffer.byteLength(svg, 'utf8'),
        uri
      }, [{
        type: 'resource',
        resource: {
          uri,
          mimeType: 'image/svg+xml',
          text: svg
        }
      }]);
    }
    
    const content = await this.engine.exportXml(context.id, formatted);

    return textToolResult('export', {
      processId: context.id,
      filename: activeFilename(context),
      format,
      mimeType: 'application/xml',
      byteLength: Buffer.byteLength(content, 'utf8')
    }, content);
  }

  private async saveSvg(args: ToolArguments<'save_svg'>): Promise<CallToolResult> {
    assertSafeFilename(args.filename, ['.svg']);
    const context = diagramContext.getCurrent();
    const xml = await this.engine.exportXml(context.id, true);
    const svg = await this.svgRenderer.render(xml);
    return this.saveRenderedArtifact(
      context,
      args.filename,
      args.overwrite,
      { format: 'svg', content: svg }
    );
  }

  private async savePng(args: ToolArguments<'save_png'>): Promise<CallToolResult> {
    assertSafeFilename(args.filename, ['.png']);
    const context = diagramContext.getCurrent();
    const xml = await this.engine.exportXml(context.id, true);
    const png = await this.svgRenderer.renderPng(xml, args.scale ?? 1);
    return this.saveRenderedArtifact(
      context,
      args.filename,
      args.overwrite,
      {
        format: 'png',
        content: png.image,
        raster: {
          width: png.width,
          height: png.height,
          scale: png.scale,
          downscaled: png.downscaled
        }
      }
    );
  }

  private async saveRenderedArtifact(
    context: ProcessContext,
    filename: string,
    overwrite: boolean,
    artifact: RenderedArtifact
  ): Promise<CallToolResult> {
    const { format, content } = artifact;
    const byteLength = typeof content === 'string'
      ? Buffer.byteLength(content, 'utf8')
      : content.byteLength;
    const result = await this.engine.saveRenderedArtifact(
      content,
      filename,
      format,
      overwrite,
      this.resourceLimits.maxArtifactBytes
    );
    if (!result.success) {
      throw new ToolError(
        'storage_unavailable',
        result.error || 'Unable to save rendered artifact',
        { recovery: 'Check that the workspace reported by get_workspace is writable.' }
      );
    }

    if (artifact.format === 'svg') {
      return textToolResult('save_svg', {
        processId: context.id,
        filename,
        format: 'svg',
        mimeType: 'image/svg+xml',
        byteLength
      }, `Saved rendered SVG artifact as ${filename}`);
    }

    const { raster } = artifact;
    return textToolResult('save_png', {
      processId: context.id,
      filename,
      format: 'png',
      mimeType: 'image/png',
      byteLength,
      ...raster
    }, raster.downscaled
      ? `Saved rendered PNG artifact as ${filename} at ${raster.width}x${raster.height}px; `
        + `the requested scale was reduced to ${raster.scale.toFixed(3)} to stay inside `
        + 'the renderer pixel limits'
      : `Saved rendered PNG artifact as ${filename} at ${raster.width}x${raster.height}px`);
  }

  private async validate(args: ToolArguments<'validate'>): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const level = (args.level || 'full') as ValidationLevel;
    const xml = await this.engine.exportXml(context.id, true);
    const result = await this.validator.validate(xml, level);

    const structuredResult = {
      ...result,
      filename: activeFilename(context)
    };
    return textToolResult('validate', structuredResult, JSON.stringify(result, null, 2));
  }

  private async analyzeGeometry(
    args: ToolArguments<'analyze_geometry'>
  ): Promise<CallToolResult> {
    const context = diagramContext.getCurrent();
    const xml = await this.engine.exportXml(context.id, true);
    const report = await validateBpmnGeometry(xml, {
      ...args,
      maxShapes: this.resourceLimits.maxLayoutElements,
      maxEdges: this.resourceLimits.maxLayoutConnections,
      maxDiagnostics: this.resourceLimits.maxListingItems
    });
    const structuredResult = {
      valid: report.valid,
      diagnostics: report.diagnostics,
      summary: report.summary,
      scope: {
        elementIds: [...args.elementIds].sort(compareStableText),
        connectionIds: [...args.connectionIds].sort(compareStableText),
        clearance: args.clearance,
        tolerance: args.tolerance,
        requireOrthogonal: args.requireOrthogonal
      },
      geometry: report.geometry,
      filename: activeFilename(context),
      revision: context.revision
    };
    return textToolResult(
      'analyze_geometry',
      structuredResult,
      JSON.stringify(structuredResult, null, 2)
    );
  }

  private async autoLayout(args: ToolArguments<'auto_layout'>): Promise<CallToolResult> {
    const {
      algorithm = 'horizontal',
      direction = 'left-to-right',
      expectedRevision
    } = args;
    const context = diagramContext.getCurrent();
    const beforeRevision = context.revision;

    const elementCount = context.elements.size;
    const connectionCount = context.connections.size;

    const layout = await this.engine.applyAutoLayout(context.id, expectedRevision, direction);
    const warningText = layout.warnings.length === 0
      ? ''
      : `\n\nWarnings:\n${layout.warnings.map(formatBpmnLayoutDiagnostic).join('\n')}`;
    const summary = layout.changed
      ? `Applied ${direction} auto-layout to current diagram\n\n`
        + `Repositioned ${elementCount} elements and ${connectionCount} connections.`
      : `The ${direction} layout matches the current diagram, so nothing was changed `
        + 'and the revision is unchanged.';

    return textToolResult('auto_layout', {
      algorithm,
      direction,
      changed: layout.changed,
      elementCount,
      connectionCount,
      warnings: layout.warnings,
      filename: activeFilename(context),
      beforeRevision,
      afterRevision: context.revision
    }, `${summary}${warningText}`);
  }

  private conversionWarningText(warnings: string[]): string {
    return warnings.length === 0 ? '' : `\n\nWarnings:\n${warnings.join('\n')}`;
  }

  private assertMermaidByteLimit(mermaidCode: string): void {
    if (Buffer.byteLength(mermaidCode, 'utf8') > this.resourceLimits.maxMermaidBytes) {
      throw new ToolError(
        'limit_exceeded',
        'Mermaid import exceeds the configured byte limit',
        {
          recovery: 'Split the diagram, or raise MCP_BPMN_MAX_MERMAID_BYTES on the server.',
          details: { maxBytes: this.resourceLimits.maxMermaidBytes }
        }
      );
    }
  }

  // File management methods
  private async listDiagrams(
    args: ToolArguments<'list_diagrams'>
  ): Promise<CallToolResult> {
    const { limit, offset } = args;
    const page = await this.engine.listDiagrams({ limit, offset });
    
    const result = {
      count: page.count,
      returnedCount: page.diagrams.length,
      offset,
      limit,
      hasMore: page.hasMore,
      diagrams: page.diagrams,
      path: this.engine.getDiagramsPath()
    };
    return textToolResult('list_diagrams', result, JSON.stringify(result, null, 2));
  }

  private async deleteDiagramFile(
    args: ToolArguments<'delete_diagram_file'>
  ): Promise<CallToolResult> {
    const { filename } = args;
    const closedCurrent = diagramContext.getCurrentInfo()?.filename === filename;
    await this.engine.deleteDiagram(filename);
    if (closedCurrent) {
      diagramContext.clear();
    }
    
    return textToolResult('delete_diagram_file', {
      filename,
      closedCurrent
    }, `Deleted diagram file: ${filename}`
      + (closedCurrent ? ' (closed the active diagram; there is no current diagram now)' : ''));
  }

  private async getDiagramsPath(): Promise<CallToolResult> {
    const path = this.engine.getDiagramsPath();
    
    return textToolResult('get_diagrams_path', { path },
      `BPMN diagrams are saved to: ${path}\n\n`
      + 'Call get_workspace for the launch cwd and the immutable startup boundary, and '
      + 'select_workspace to switch to another existing directory below that boundary '
      + 'for the rest of this session.');
  }

  private async getWorkspace(): Promise<CallToolResult> {
    const info = this.workspace.getInfo();
    return textToolResult('get_workspace', info, JSON.stringify(info, null, 2));
  }

  private async selectWorkspace(
    args: ToolArguments<'select_workspace'>
  ): Promise<CallToolResult> {
    const workspace = this.workspace.resolveSelection(args.path);
    const changed = workspace !== this.workspace.path;
    if (changed) {
      if (diagramContext.hasCurrent()) {
        await this.engine.releaseProcess(diagramContext.getCurrent());
        diagramContext.clear();
      }
      this.engine.selectDiagramsPath(workspace);
    }

    const selection = this.workspace.activateSelection(workspace);
    const result = { ...selection.info, changed };
    return textToolResult('select_workspace', result, JSON.stringify(result, null, 2));
  }
}

function toolResult<Name extends ToolName>(
  name: Name,
  structuredContent: ToolResult<Name>,
  content: CallToolResult['content']
): CallToolResult {
  return {
    content,
    structuredContent: parseToolResult(name, structuredContent)
  };
}

function textToolResult<Name extends ToolName>(
  name: Name,
  structuredContent: ToolResult<Name>,
  text: string
): CallToolResult {
  return toolResult(name, structuredContent, [{ type: 'text', text }]);
}

/** Render a failed tool call with a stable code and a recovery hint. */
function toolErrorResult(error: ToolError): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${error.message}` }],
    isError: true,
    structuredContent: {
      code: error.code,
      message: error.message,
      ...(error.recovery ? { recovery: error.recovery } : {}),
      ...error.details
    }
  };
}

/**
 * Classification for errors raised outside the typed error classes.
 *
 * The engine predates the taxonomy and still signals most failures with plain
 * Error messages it builds itself. Matching those known phrasings is a bridge,
 * not the destination: each entry is a message this code base produces, and
 * anything unrecognized is reported honestly as unexpected rather than being
 * given a confidently wrong code.
 */
const ERROR_CLASSIFIERS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly code: ToolErrorCode;
  readonly recovery: string;
  /** Pull identifiers out of the matched message so callers need not re-parse it. */
  readonly details?: (match: RegExpMatchArray) => Record<string, unknown>;
}> = [
  {
    pattern: /^No current diagram|no current diagram|No diagram is currently open/i,
    code: 'no_current_diagram',
    recovery: 'Open or create a diagram first with new_bpmn, new_from_mermaid, or open_bpmn.'
  },
  {
    pattern: /is a bpmn:\w+, which is a connection|use get_connection/i,
    code: 'wrong_object_kind',
    recovery: 'Use get_connection or list_connections for connections.'
  },
  {
    pattern: /^Connection (\S+) not found/,
    code: 'connection_not_found',
    recovery: 'List connections with list_connections and use an id from that result.',
    details: match => ({ connectionId: match[1] })
  },
  {
    pattern: /^(?:Associated element|Source element|Target element|Element) "?([^"\s]+)"? not found/,
    code: 'element_not_found',
    recovery: 'List elements with list_elements and use an id from that result.',
    details: match => ({ elementId: match[1] })
  },
  {
    // add_lane takes the pool's own element id, not the process it references.
    pattern: /^Participant (\S+) not found/,
    code: 'owner_or_scope_invalid',
    recovery: 'Pass the pool elementId as poolId; list_elements reports each pool with '
      + 'kind "participant" and its processRef.',
    details: match => ({ poolId: match[1] })
  },
  {
    pattern: /Missing BPMN process owner|ownerId|scopeId|not found in scope|scope/i,
    code: 'owner_or_scope_invalid',
    recovery: 'Pass the owning process id as ownerId, and the containing process or subprocess '
      + 'id as scopeId; the message names the id this diagram expects.'
  },
  {
    // A newly introduced collision. collisionPolicy is the caller's escape
    // hatch here, so the recovery names it alongside the router.
    pattern: /^Geometry (?:collision rejected for (\S+?)|patch rejected): (.+)$/s,
    code: 'geometry_rejected',
    recovery: 'Inspect the obstacle with analyze_geometry, then either let route_connection '
      + 'propose a collision-free route for the edge, move the obstacle with '
      + 'update_element_geometry, or repeat this call with collisionPolicy "allow" to accept '
      + 'the reported collision.',
    details: match => ({
      reason: 'collision',
      ...(match[1] ? { objectId: match[1] } : {}),
      diagnostics: [{ message: match[2], ids: match[1] ? [match[1]] : [] }],
      collisionPolicyApplies: true
    })
  },
  {
    // A broken invariant: non-finite or inverted bounds, an element outside its
    // container, or an edge that no longer touches its endpoints. No
    // collisionPolicy waives these, so saying "retry with allow" would be a
    // wrong hint that costs the agent another round trip.
    pattern: /^Unsafe geometry(?: for (\S+?))?(?: patch)?: (.+)$/s,
    code: 'geometry_rejected',
    recovery: 'collisionPolicy "allow" does not waive this: the geometry itself is unusable. '
      + 'Keep every bound finite and positive, keep the element inside its pool or subprocess '
      + '(resize the container first with update_element_geometry), and keep edge endpoints on '
      + 'their shapes; analyze_geometry reports the current state.',
    details: match => ({
      reason: 'invariant',
      ...(match[1] ? { objectId: match[1] } : {}),
      diagnostics: [{ message: match[2], ids: match[1] ? [match[1]] : [] }],
      collisionPolicyApplies: false
    })
  },
  {
    pattern: /not contained by/i,
    code: 'geometry_rejected',
    recovery: 'Move the element inside its container, or resize the container first with '
      + 'update_element_geometry; collisionPolicy does not waive containment.',
    details: () => ({ reason: 'invariant', collisionPolicyApplies: false })
  },
  {
    pattern: /^File already exists/i,
    code: 'file_exists',
    recovery: 'Choose another filename, or delete the existing file with delete_diagram_file first.'
  },
  {
    pattern: /requires Chrome or Chromium|Browser launch failed|SVG renderer/i,
    code: 'render_unavailable',
    recovery: 'Install a Chrome or Chromium build and point PUPPETEER_EXECUTABLE_PATH at it, '
      + 'or export format "xml" instead.'
  },
  {
    pattern: /does not exist below the startup boundary|must be a descendant of the startup boundary|Workspace path components must be directories/i,
    code: 'file_not_found',
    recovery: 'Create the directory first, or call get_workspace and select an existing '
      + 'directory below the startup boundary it reports.'
  },
  {
    pattern: /Unable to save|Unable to read|diagram file is busy/i,
    code: 'storage_unavailable',
    recovery: 'Check that the managed workspace reported by get_workspace exists and is writable.'
  },
  {
    pattern: /limit .*exceeded|exceeds|too large|rejected: .*limit/i,
    code: 'limit_exceeded',
    recovery: 'Reduce the size of the request, or page through the result with limit and offset.'
  },
  {
    pattern: /must be|cannot|invalid|not legal|unsupported/i,
    code: 'invalid_bpmn',
    recovery: 'Adjust the request so the resulting model is valid BPMN, then retry.'
  }
];

/** Map any thrown value onto the tool error taxonomy. */
function asToolError(error: unknown): ToolError {
  if (isToolError(error)) return error;
  const message = errorMessage(error);
  for (const { pattern, code, recovery, details } of ERROR_CLASSIFIERS) {
    const match = message.match(pattern);
    if (match) return new ToolError(code, message, { recovery, details: details?.(match) });
  }
  return new ToolError('unexpected_error', message);
}

/** Vertical gap left between stacked pools before auto_layout runs. */
const POOL_STACK_GAP = 50;
const DEFAULT_POOL_ORIGIN = { x: 100, y: 100 } as const;

/**
 * Placeholder position for a pool the caller did not place.
 *
 * Every pool used to default to the same point, so a second pool overlapped
 * the first and every geometry read, collision check or render taken before
 * auto_layout saw a stack of pools sitting on top of each other. Stacking
 * downward keeps the intermediate state legible; auto_layout still replaces
 * these coordinates.
 */
function defaultPoolPosition(context: ProcessContext): { x: number; y: number } {
  let left: number | undefined;
  let bottom: number | undefined;
  for (const candidate of context.elements.values()) {
    if (candidate.kind !== 'participant') continue;
    const { x, y } = candidate.position;
    const height = candidate.size?.height ?? 0;
    left = left === undefined ? x : Math.min(left, x);
    bottom = bottom === undefined ? y + height : Math.max(bottom, y + height);
  }
  if (left === undefined || bottom === undefined) return { ...DEFAULT_POOL_ORIGIN };
  return { x: left, y: bottom + POOL_STACK_GAP };
}

/** The diagram a create/open call displaced, reported so it is never silent. */
type ReplacedDiagram = { name: string; filename?: string };

function replacedDiagramText(replaced: ReplacedDiagram | undefined): string {
  if (!replaced) return '';
  return `\n(replaced and closed the previously active diagram "${replaced.name}"`
    + `${replaced.filename ? ` in ${replaced.filename}` : ''})`;
}

function activeFilename(context: ProcessContext): string {
  if (!context.filename) {
    throw new Error(`Diagram ${context.id} has no active filename`);
  }
  return context.filename;
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function summarizeGeometryDiagnostics(diagnostics: GeometryDiagnostic[]) {
  const byCode: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1;
    else warnings += 1;
    byCode[diagnostic.code] = (byCode[diagnostic.code] ?? 0) + 1;
  }
  return { total: diagnostics.length, errors, warnings, byCode };
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

function elementGeometryQueryFields(
  document: BpmnDocument,
  elementId: string
): Pick<ElementQueryView, 'shapeId' | 'bounds' | 'labelBounds'> {
  const shape = Array.from(document.diagram.shapes.values()).find(
    candidate => candidate.elementId === elementId
  );
  if (!shape) return {};
  return {
    shapeId: shape.id,
    bounds: { ...shape.bounds },
    ...(shape.labelBounds ? { labelBounds: { ...shape.labelBounds } } : {})
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

function connectionQueryView(
  context: ProcessContext,
  connection: BpmnDocumentConnection,
  edge: BpmnEdgeModel | undefined
): ConnectionQueryView {
  const source = context.elements.get(connection.source);
  const defaultOwnerId = connection.type === 'bpmn:SequenceFlow'
    && source?.kind === 'flowNode'
    && source.defaultFlow === connection.id
    ? source.id
    : undefined;
  const waypoints = (edge?.waypoints ?? connection.waypoints).map(point => ({ ...point }));
  const labelBounds = edge?.labelBounds ? { ...edge.labelBounds } : undefined;
  const geometryRevision = edge
    ? connectionGeometryRevision(connection.id, edge)
    : connectionGeometryRevision(connection.id, {
      id: null,
      waypoints,
      labelBounds
    });

  return {
    id: connection.id,
    type: connection.type,
    ownerId: connection.ownerId,
    scopeId: connection.scopeId,
    sourceId: connection.source,
    targetId: connection.target,
    label: connection.label,
    condition: connection.condition ? { ...connection.condition } : undefined,
    isDefault: defaultOwnerId !== undefined,
    defaultOwnerId,
    associationDirection: connection.associationDirection,
    waypoints,
    edgeId: edge?.id,
    labelBounds,
    geometryRevision,
    semanticRevision: connectionSemanticState(context.document, connection).semanticRevision
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

function assertNever(value: never): never {
  throw new Error(`Unhandled validated tool request: ${String(value)}`);
}
