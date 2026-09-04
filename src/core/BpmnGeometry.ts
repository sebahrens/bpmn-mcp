import BpmnModdle from 'bpmn-moddle';

export type GeometryDiagnosticCode =
  | 'INVALID_XML'
  | 'MISSING_DI'
  | 'MISSING_SHAPE'
  | 'MISSING_EDGE'
  | 'NON_FINITE_GEOMETRY'
  | 'INVALID_BOUNDS'
  | 'INSUFFICIENT_WAYPOINTS'
  | 'ENDPOINT_GAP'
  | 'SHAPE_OVERLAP'
  | 'LABEL_OVERLAP'
  | 'EDGE_SHAPE_COLLISION'
  | 'EDGE_EDGE_CROSSING'
  | 'CONTAINMENT_FAILURE'
  | 'MINIMUM_CLEARANCE'
  | 'NON_ORTHOGONAL_ROUTE'
  | 'UNKNOWN_ELEMENT_ID'
  | 'UNKNOWN_CONNECTION_ID'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'DIAGNOSTICS_TRUNCATED';

export type GeometryDiagnosticSeverity = 'error' | 'warning';

export interface GeometryDiagnostic {
  code: GeometryDiagnosticCode;
  severity: GeometryDiagnosticSeverity;
  message: string;
  ids: string[];
}

export interface GeometryPoint {
  x: number;
  y: number;
}

export interface GeometryBounds extends GeometryPoint {
  width: number;
  height: number;
}

export interface GeometryLabel {
  id: string;
  ownerId: string;
  planeId: string;
  bounds: GeometryBounds;
}

export interface GeometryShape {
  id: string;
  diId: string;
  type: string;
  planeId: string;
  bounds: GeometryBounds;
  label?: GeometryLabel;
  parentId?: string;
  attachedToId?: string;
  isExpanded?: boolean;
}

export interface GeometryEdge {
  id: string;
  diId: string;
  type: string;
  planeId: string;
  sourceId?: string;
  targetId?: string;
  waypoints: GeometryPoint[];
  label?: GeometryLabel;
}

export interface BpmnGeometry {
  shapes: GeometryShape[];
  edges: GeometryEdge[];
  labels: GeometryLabel[];
}

export interface GeometryValidationOptions {
  clearance?: number;
  tolerance?: number;
  requireOrthogonal?: boolean;
  elementIds?: string[];
  connectionIds?: string[];
  /** Internal production guard; MCP callers cannot override it. */
  maxShapes?: number;
  /** Internal production guard; MCP callers cannot override it. */
  maxEdges?: number;
  /** Internal production guard; MCP callers cannot override it. */
  maxDiagnostics?: number;
}

export interface GeometryDiagnosticSummary {
  total: number;
  errors: number;
  warnings: number;
  byCode: Partial<Record<GeometryDiagnosticCode, number>>;
}

export interface GeometryValidationReport {
  valid: boolean;
  diagnostics: GeometryDiagnostic[];
  summary: GeometryDiagnosticSummary;
  geometry?: BpmnGeometry;
  normalized?: NormalizedGeometry;
}

export interface NormalizedGeometry {
  shapes: Array<{
    id: string;
    type: string;
    planeId: string;
    bounds: GeometryBounds;
    parentId?: string;
    attachedToId?: string;
    label?: GeometryBounds;
  }>;
  edges: Array<{
    id: string;
    type: string;
    planeId: string;
    sourceId?: string;
    targetId?: string;
    waypoints: GeometryPoint[];
    label?: GeometryBounds;
  }>;
}

interface SemanticElement {
  id: string;
  type: string;
  kind: 'shape' | 'edge' | 'container';
  sourceId?: string;
  targetId?: string;
  parentId?: string;
  attachedToId?: string;
  ownerProcessId?: string;
}

/**
 * Semantic elements that BPMN never renders on a plane. A bpmn:DataObject is
 * the non-visual backing definition of a bpmn:DataObjectReference; only the
 * reference carries a BPMNShape, so requiring DI for the definition would
 * report every diagram that stores data as geometry-invalid.
 */
const NON_VISUAL_ELEMENT_TYPES = new Set([
  'bpmn:DataObject',
  'bpmn:DataStore',
  'bpmn:Property'
]);

interface SemanticIndex {
  elements: Map<string, SemanticElement>;
  participantByProcess: Map<string, string>;
  laneByFlowNode: Map<string, string>;
}

const DEFAULT_CLEARANCE = 5;
const DEFAULT_TOLERANCE = 1;
const CONTAINER_TYPES = new Set(['bpmn:Participant', 'bpmn:Lane', 'bpmn:SubProcess']);
const EDGE_CROSSABLE_CONTAINER_TYPES = new Set(['bpmn:Participant', 'bpmn:Lane']);

class BoundedGeometryDiagnostics extends Array<GeometryDiagnostic> {
  omitted = 0;
  private readonly selectedIds: Set<string>;

  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  constructor(
    private readonly limit = Number.POSITIVE_INFINITY,
    selectedIds: Iterable<string> = []
  ) {
    super();
    this.selectedIds = new Set(selectedIds);
  }

  override push(...items: GeometryDiagnostic[]): number {
    for (const item of items) {
      if (this.length < this.limit) {
        super.push(item);
        continue;
      }
      const isSelected = this.selectedIds.size > 0
        && item.ids.some(id => this.selectedIds.has(id));
      const replaceIndex = isSelected
        ? this.findIndex(existing =>
          existing.ids.length > 0
          && !existing.ids.some(id => this.selectedIds.has(id)))
        : -1;
      if (replaceIndex >= 0) this[replaceIndex] = item;
      this.omitted += 1;
    }
    return this.length;
  }

  finish(): void {
    if (this.omitted === 0) return;
    Array.prototype.push.call(this, diagnostic(
      'DIAGNOSTICS_TRUNCATED',
      `${this.omitted} additional geometry diagnostics were omitted by the resource limit`,
      [],
      'warning'
    ));
  }
}

export async function validateBpmnGeometry(
  xml: string,
  options: GeometryValidationOptions = {}
): Promise<GeometryValidationReport> {
  const diagnostics = new BoundedGeometryDiagnostics(options.maxDiagnostics, [
    ...(options.elementIds ?? []),
    ...(options.connectionIds ?? [])
  ]);
  let definitions: any;

  validateOptions(options);

  try {
    const parsed = await new BpmnModdle().fromXML(xml);
    definitions = parsed.rootElement;
    if (definitions?.$type !== 'bpmn:Definitions') {
      throw new Error(`Expected bpmn:Definitions, received ${definitions?.$type || 'unknown root'}`);
    }
  } catch (error) {
    diagnostics.push(diagnostic(
      'INVALID_XML',
      `Invalid BPMN XML: ${error instanceof Error ? error.message : String(error)}`,
      []
    ));
    return reportFor(undefined, diagnostics, options);
  }

  const diagrams = definitions.diagrams || [];
  if (diagrams.length === 0 || diagrams.every((diagram: any) => !diagram.plane)) {
    diagnostics.push(diagnostic('MISSING_DI', 'BPMN document does not contain a DI plane', []));
    return reportFor(undefined, diagnostics, options);
  }

  const semantic = buildSemanticIndex(definitions);
  const geometry = extractGeometry(diagrams, semantic);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const clearance = options.clearance ?? DEFAULT_CLEARANCE;

  validateSelection(semantic, options, diagnostics);
  if ((options.maxShapes !== undefined && geometry.shapes.length > options.maxShapes)
    || (options.maxEdges !== undefined && geometry.edges.length > options.maxEdges)) {
    diagnostics.push(diagnostic(
      'RESOURCE_LIMIT_EXCEEDED',
      `Geometry analysis supports at most ${options.maxShapes ?? 'unlimited'} shapes and ${options.maxEdges ?? 'unlimited'} edges; received ${geometry.shapes.length} shapes and ${geometry.edges.length} edges`,
      []
    ));
    return reportFor(undefined, diagnostics, options, tolerance);
  }
  if (options.maxShapes !== undefined && options.maxEdges !== undefined) {
    const segmentCount = geometry.edges.reduce(
      (count, edge) => count + Math.max(0, edge.waypoints.length - 1),
      0
    );
    const estimatedChecks = geometry.shapes.length ** 2
      + geometry.labels.length ** 2
      + geometry.labels.length * geometry.shapes.length
      + geometry.shapes.length * segmentCount
      + segmentCount ** 2;
    const maxChecks = 4 * options.maxShapes * options.maxEdges;
    if (estimatedChecks > maxChecks) {
      diagnostics.push(diagnostic(
        'RESOURCE_LIMIT_EXCEEDED',
        `Geometry analysis requires approximately ${estimatedChecks} collision checks; limit ${maxChecks}`,
        []
      ));
      return reportFor(undefined, diagnostics, options, tolerance);
    }
  }

  validateCompleteness(semantic, geometry, diagnostics);
  validateFiniteGeometry(geometry, diagnostics);
  validateEndpoints(geometry, diagnostics, tolerance);
  validateContainment(geometry, diagnostics, tolerance);
  validateShapeAndLabelOverlaps(geometry, diagnostics, clearance, tolerance);
  validateEdgeShapeCollisions(geometry, diagnostics, clearance, tolerance);
  validateEdgeEdgeCrossings(geometry, diagnostics, clearance, tolerance);
  if (options.requireOrthogonal) {
    validateOrthogonalRoutes(geometry, diagnostics, tolerance);
  }

  return reportFor(geometry, diagnostics, options, tolerance);
}

function validateOptions(options: GeometryValidationOptions): void {
  const clearance = options.clearance ?? DEFAULT_CLEARANCE;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(clearance) || clearance < 0) {
    throw new Error('Geometry clearance must be a non-negative finite number');
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error('Geometry tolerance must be a positive finite number');
  }
  for (const [name, value] of [
    ['maxShapes', options.maxShapes],
    ['maxEdges', options.maxEdges],
    ['maxDiagnostics', options.maxDiagnostics]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Geometry ${name} must be a positive safe integer`);
    }
  }
}

function validateSelection(
  semantic: SemanticIndex,
  options: GeometryValidationOptions,
  diagnostics: GeometryDiagnostic[]
): void {
  for (const id of new Set(options.elementIds ?? [])) {
    const element = semantic.elements.get(id);
    if (!element || element.kind === 'edge') {
      diagnostics.push(diagnostic(
        'UNKNOWN_ELEMENT_ID',
        `Selected element ${id} does not identify a BPMN shape or container`,
        [id]
      ));
    }
  }
  for (const id of new Set(options.connectionIds ?? [])) {
    const element = semantic.elements.get(id);
    if (!element || element.kind !== 'edge') {
      diagnostics.push(diagnostic(
        'UNKNOWN_CONNECTION_ID',
        `Selected connection ${id} does not identify a BPMN edge`,
        [id]
      ));
    }
  }
}

function reportFor(
  geometry: BpmnGeometry | undefined,
  diagnostics: GeometryDiagnostic[],
  options: GeometryValidationOptions,
  tolerance = options.tolerance ?? DEFAULT_TOLERANCE
): GeometryValidationReport {
  if (diagnostics instanceof BoundedGeometryDiagnostics) diagnostics.finish();
  const orderedDiagnostics = Array.from(diagnostics).sort((left, right) =>
    compareStableText(left.code, right.code)
      || compareStableText(left.ids.join('\0'), right.ids.join('\0'))
      || compareStableText(left.message, right.message)
  );

  const selectedIds = new Set([
    ...(options.elementIds ?? []),
    ...(options.connectionIds ?? [])
  ]);
  const scopedDiagnostics = selectedIds.size === 0
    ? orderedDiagnostics
    : orderedDiagnostics.filter(
      item => item.ids.length === 0 || item.ids.some(id => selectedIds.has(id))
    );
  const relatedIds = new Set(selectedIds);
  for (const item of scopedDiagnostics) {
    for (const id of item.ids) relatedIds.add(id);
  }
  if (geometry) {
    for (const edge of geometry.edges) {
      if (!relatedIds.has(edge.id)) continue;
      if (edge.sourceId) relatedIds.add(edge.sourceId);
      if (edge.targetId) relatedIds.add(edge.targetId);
    }
    for (const shape of geometry.shapes) {
      if (!relatedIds.has(shape.id)) continue;
      if (shape.parentId) relatedIds.add(shape.parentId);
      if (shape.attachedToId) relatedIds.add(shape.attachedToId);
    }
  }
  const scopedGeometry = geometry === undefined
    ? undefined
    : selectedIds.size === 0
      ? geometry
      : {
        shapes: geometry.shapes.filter(shape => relatedIds.has(shape.id)),
        edges: geometry.edges.filter(edge => relatedIds.has(edge.id)),
        labels: geometry.labels.filter(label => relatedIds.has(label.ownerId))
      };
  const summary = summarizeDiagnostics(scopedDiagnostics);

  return {
    valid: summary.errors === 0,
    diagnostics: scopedDiagnostics,
    summary,
    ...(scopedGeometry ? { geometry: scopedGeometry } : {}),
    ...(scopedGeometry && geometryCanNormalize(scopedGeometry)
      ? { normalized: normalizeGeometry(scopedGeometry, tolerance) }
      : {})
  };
}

function summarizeDiagnostics(diagnostics: GeometryDiagnostic[]): GeometryDiagnosticSummary {
  const byCode: Partial<Record<GeometryDiagnosticCode, number>> = {};
  let errors = 0;
  for (const item of diagnostics) {
    if (item.severity === 'error') errors += 1;
    byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  }
  return {
    total: diagnostics.length,
    errors,
    warnings: diagnostics.length - errors,
    byCode
  };
}

function geometryCanNormalize(geometry: BpmnGeometry): boolean {
  return geometry.shapes.every(shape => finiteBounds(shape.bounds))
    && geometry.edges.every(edge => edge.waypoints.every(finitePoint))
    && geometry.labels.every(label => finiteBounds(label.bounds));
}

export function normalizeGeometry(
  geometry: BpmnGeometry,
  tolerance = DEFAULT_TOLERANCE
): NormalizedGeometry {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error('Geometry normalization tolerance must be a positive finite number');
  }

  let hasFiniteCoordinate = false;
  let minimumX = Infinity;
  let minimumY = Infinity;
  const includeOriginPoint = (point: GeometryPoint): void => {
    hasFiniteCoordinate ||= Number.isFinite(point.x) || Number.isFinite(point.y);
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
  };
  for (const shape of geometry.shapes) includeOriginPoint(shape.bounds);
  for (const edge of geometry.edges) {
    for (const waypoint of edge.waypoints) includeOriginPoint(waypoint);
  }
  for (const label of geometry.labels) includeOriginPoint(label.bounds);

  const origin = !hasFiniteCoordinate
    ? { x: 0, y: 0 }
    : { x: minimumX, y: minimumY };
  const quantize = (value: number): number => {
    const rounded = Math.round(value / tolerance) * tolerance;
    return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(12));
  };
  const point = (value: GeometryPoint): GeometryPoint => ({
    x: quantize(value.x - origin.x),
    y: quantize(value.y - origin.y)
  });
  const bounds = (value: GeometryBounds): GeometryBounds => ({
    ...point(value),
    width: quantize(value.width),
    height: quantize(value.height)
  });

  return {
    shapes: geometry.shapes
      .map(shape => ({
        id: shape.id,
        type: shape.type,
        planeId: shape.planeId,
        bounds: bounds(shape.bounds),
        ...(shape.parentId ? { parentId: shape.parentId } : {}),
        ...(shape.attachedToId ? { attachedToId: shape.attachedToId } : {}),
        ...(shape.label ? { label: bounds(shape.label.bounds) } : {})
      }))
      .sort(byId),
    edges: geometry.edges
      .map(edge => ({
        id: edge.id,
        type: edge.type,
        planeId: edge.planeId,
        ...(edge.sourceId ? { sourceId: edge.sourceId } : {}),
        ...(edge.targetId ? { targetId: edge.targetId } : {}),
        waypoints: edge.waypoints.map(point),
        ...(edge.label ? { label: bounds(edge.label.bounds) } : {})
      }))
      .sort(byId)
  };
}

export function formatGeometryDiagnostics(report: GeometryValidationReport): string {
  if (report.diagnostics.length === 0) return 'valid geometry';
  return report.diagnostics
    .map(item => `${item.severity.toUpperCase()} ${item.code}${item.ids.length ? ` [${item.ids.join(', ')}]` : ''}: ${item.message}`)
    .join('\n');
}

function buildSemanticIndex(definitions: any): SemanticIndex {
  const index: SemanticIndex = {
    elements: new Map(),
    participantByProcess: new Map(),
    laneByFlowNode: new Map()
  };

  for (const root of definitions.rootElements || []) {
    if (root.$type === 'bpmn:Collaboration') {
      for (const participant of root.participants || []) {
        addSemantic(index, participant, 'container');
        if (participant.processRef?.id) {
          index.participantByProcess.set(participant.processRef.id, participant.id);
        }
      }
      for (const messageFlow of root.messageFlows || []) {
        addSemantic(index, messageFlow, 'edge');
      }
      for (const artifact of root.artifacts || []) {
        addSemantic(index, artifact, artifact.$type === 'bpmn:Association' ? 'edge' : 'shape');
      }
    }
  }

  for (const root of definitions.rootElements || []) {
    if (root.$type === 'bpmn:Process') {
      visitFlowContainer(root, root.id, undefined, index);
    }
  }

  for (const [flowNodeId, laneId] of index.laneByFlowNode) {
    const element = index.elements.get(flowNodeId);
    if (element) element.parentId = laneId;
  }
  for (const element of index.elements.values()) {
    if (!element.parentId && element.ownerProcessId) {
      element.parentId = index.participantByProcess.get(element.ownerProcessId);
    }
  }
  return index;
}

function visitFlowContainer(
  container: any,
  ownerProcessId: string,
  parentId: string | undefined,
  index: SemanticIndex
): void {
  for (const laneSet of container.laneSets || []) {
    visitLaneSet(laneSet, ownerProcessId, parentId, index);
  }
  for (const element of container.flowElements || []) {
    if (!element.id) continue;
    const isEdge = ['bpmn:SequenceFlow', 'bpmn:Association'].includes(element.$type);
    addSemantic(index, element, isEdge ? 'edge' : element.$type === 'bpmn:SubProcess' ? 'container' : 'shape', {
      parentId,
      ownerProcessId
    });
    if (element.$type === 'bpmn:SubProcess') {
      visitFlowContainer(element, ownerProcessId, element.id, index);
    }
  }
  for (const artifact of container.artifacts || []) {
    addSemantic(index, artifact, artifact.$type === 'bpmn:Association' ? 'edge' : 'shape', {
      parentId,
      ownerProcessId
    });
  }
}

function visitLaneSet(
  laneSet: any,
  ownerProcessId: string,
  parentId: string | undefined,
  index: SemanticIndex
): void {
  for (const lane of laneSet.lanes || []) {
    addSemantic(index, lane, 'container', { parentId, ownerProcessId });
    for (const flowNode of lane.flowNodeRef || []) {
      if (flowNode?.id) index.laneByFlowNode.set(flowNode.id, lane.id);
    }
    for (const childLaneSet of lane.childLaneSet ? [lane.childLaneSet] : []) {
      visitLaneSet(childLaneSet, ownerProcessId, lane.id, index);
    }
  }
}

function addSemantic(
  index: SemanticIndex,
  element: any,
  kind: SemanticElement['kind'],
  extra: Partial<SemanticElement> = {}
): void {
  if (!element?.id) return;
  index.elements.set(element.id, {
    id: element.id,
    type: element.$type,
    kind,
    sourceId: element.sourceRef?.id,
    targetId: element.targetRef?.id,
    attachedToId: element.attachedToRef?.id,
    ...extra
  });
}

function extractGeometry(diagrams: any[], semantic: SemanticIndex): BpmnGeometry {
  const shapes: GeometryShape[] = [];
  const edges: GeometryEdge[] = [];
  const labels: GeometryLabel[] = [];

  for (const diagram of diagrams) {
    const plane = diagram.plane;
    if (!plane) continue;
    const planeId = plane.id || diagram.id || 'anonymous-plane';
    for (const item of plane.planeElement || []) {
      const elementId = item.bpmnElement?.id;
      if (!elementId) continue;
      const model = semantic.elements.get(elementId);
      if (item.$type === 'bpmndi:BPMNShape') {
        const label = extractLabel(item.label, elementId, planeId);
        if (label) labels.push(label);
        shapes.push({
          id: elementId,
          diId: item.id || `${elementId}_di`,
          type: model?.type || item.bpmnElement?.$type || 'unknown',
          planeId,
          bounds: readBounds(item.bounds),
          ...(label ? { label } : {}),
          ...(model?.parentId ? { parentId: model.parentId } : {}),
          ...(model?.attachedToId ? { attachedToId: model.attachedToId } : {}),
          ...(typeof item.isExpanded === 'boolean' ? { isExpanded: item.isExpanded } : {})
        });
      } else if (item.$type === 'bpmndi:BPMNEdge') {
        const label = extractLabel(item.label, elementId, planeId);
        if (label) labels.push(label);
        edges.push({
          id: elementId,
          diId: item.id || `${elementId}_di`,
          type: model?.type || item.bpmnElement?.$type || 'unknown',
          planeId,
          sourceId: model?.sourceId,
          targetId: model?.targetId,
          waypoints: (item.waypoint || []).map(readPoint),
          ...(label ? { label } : {})
        });
      }
    }
  }
  return { shapes, edges, labels };
}

function extractLabel(label: any, ownerId: string, planeId: string): GeometryLabel | undefined {
  if (!label?.bounds) return undefined;
  return {
    id: label.id || `${ownerId}_label`,
    ownerId,
    planeId,
    bounds: readBounds(label.bounds)
  };
}

function validateCompleteness(
  semantic: SemanticIndex,
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[]
): void {
  const shapeIds = new Set(geometry.shapes.map(shape => shape.id));
  const edgeIds = new Set(geometry.edges.map(edge => edge.id));
  for (const element of semantic.elements.values()) {
    if (NON_VISUAL_ELEMENT_TYPES.has(element.type)) continue;
    if ((element.kind === 'shape' || element.kind === 'container') && !shapeIds.has(element.id)) {
      diagnostics.push(diagnostic('MISSING_SHAPE', `Missing BPMNShape for ${element.type} ${element.id}`, [element.id]));
    } else if (element.kind === 'edge' && !edgeIds.has(element.id)) {
      diagnostics.push(diagnostic('MISSING_EDGE', `Missing BPMNEdge for ${element.type} ${element.id}`, [element.id]));
    }
  }
}

function validateFiniteGeometry(geometry: BpmnGeometry, diagnostics: GeometryDiagnostic[]): void {
  for (const shape of geometry.shapes) {
    validateBounds(shape.bounds, shape.id, diagnostics);
  }
  for (const label of geometry.labels) {
    validateBounds(label.bounds, label.id, diagnostics);
  }
  for (const edge of geometry.edges) {
    if (edge.waypoints.length < 2) {
      diagnostics.push(diagnostic(
        'INSUFFICIENT_WAYPOINTS',
        `Edge ${edge.id} has ${edge.waypoints.length} waypoint(s); at least two are required`,
        [edge.id]
      ));
    }
    edge.waypoints.forEach((point, index) => {
      if (![point.x, point.y].every(Number.isFinite)) {
        diagnostics.push(diagnostic(
          'NON_FINITE_GEOMETRY',
          `Edge ${edge.id} waypoint ${index} contains a non-finite coordinate`,
          [edge.id]
        ));
      }
    });
  }
}

function validateBounds(
  bounds: GeometryBounds,
  id: string,
  diagnostics: GeometryDiagnostic[]
): void {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    diagnostics.push(diagnostic('NON_FINITE_GEOMETRY', `${id} contains non-finite bounds`, [id]));
  } else if (bounds.width <= 0 || bounds.height <= 0) {
    diagnostics.push(diagnostic('INVALID_BOUNDS', `${id} must have positive width and height`, [id]));
  }
}

function validateEndpoints(
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[],
  tolerance: number
): void {
  const shapes = uniqueShapesById(geometry.shapes);
  for (const edge of geometry.edges) {
    if (edge.waypoints.length < 2) continue;
    const endpoints: Array<[string | undefined, GeometryPoint, 'source' | 'target']> = [
      [edge.sourceId, edge.waypoints[0], 'source'],
      [edge.targetId, edge.waypoints[edge.waypoints.length - 1], 'target']
    ];
    for (const [shapeId, point, end] of endpoints) {
      const shape = shapeId ? shapes.get(shapeId) : undefined;
      if (!shape || !finitePoint(point) || !finiteBounds(shape.bounds)) continue;
      const gap = distanceToRectangleBoundary(point, shape.bounds);
      if (gap > tolerance) {
        diagnostics.push(diagnostic(
          'ENDPOINT_GAP',
          `Edge ${edge.id} ${end} is ${formatNumber(gap)}px from ${shape.id} (tolerance ${tolerance}px)`,
          [edge.id, shape.id]
        ));
      }
    }
  }
}

function validateContainment(
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[],
  tolerance: number
): void {
  const shapes = uniqueShapesById(geometry.shapes);
  for (const child of geometry.shapes) {
    if (!finiteBounds(child.bounds)) continue;
    if (child.attachedToId) {
      const host = shapes.get(child.attachedToId);
      if (host && host.planeId === child.planeId && !boundaryAttachesToHost(child.bounds, host.bounds, tolerance)) {
        diagnostics.push(diagnostic(
          'CONTAINMENT_FAILURE',
          `Boundary event ${child.id} is not attached to the boundary of ${host.id}`,
          [child.id, host.id]
        ));
      }
      continue;
    }
    if (!child.parentId) continue;
    const parent = shapes.get(child.parentId);
    if (!parent || parent.planeId !== child.planeId) continue;
    if (parent.type === 'bpmn:SubProcess' && parent.isExpanded !== true) continue;
    if (!containsBounds(parent.bounds, child.bounds, tolerance)) {
      diagnostics.push(diagnostic(
        'CONTAINMENT_FAILURE',
        `${child.id} is not contained by ${parent.id}`,
        [child.id, parent.id]
      ));
    }
  }
}

function validateShapeAndLabelOverlaps(
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[],
  clearance: number,
  tolerance: number
): void {
  const shapesById = uniqueShapesById(geometry.shapes);
  const shapeAncestors = containerAncestorIndex(shapesById);
  const labelContainerAncestors = labelAncestorIndex(geometry, shapeAncestors);
  for (let leftIndex = 0; leftIndex < geometry.shapes.length; leftIndex++) {
    const left = geometry.shapes[leftIndex];
    if (!finiteBounds(left.bounds)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.shapes.length; rightIndex++) {
      const right = geometry.shapes[rightIndex];
      if (left.planeId !== right.planeId
        || !finiteBounds(right.bounds)
        || legalShapeOverlap(left, right, shapeAncestors)) continue;
      const appliedClearance = CONTAINER_TYPES.has(left.type) || CONTAINER_TYPES.has(right.type) ? 0 : clearance;
      if (rectanglesCollide(left.bounds, right.bounds, 0, 0)) {
        diagnostics.push(diagnostic(
          'SHAPE_OVERLAP',
          `${left.id} overlaps ${right.id}`,
          [left.id, right.id].sort()
        ));
      } else if (appliedClearance > 0
        && rectanglesCollide(left.bounds, right.bounds, appliedClearance, tolerance)) {
        diagnostics.push(diagnostic(
          'MINIMUM_CLEARANCE',
          `${left.id} and ${right.id} are ${formatNumber(rectangleDistance(left.bounds, right.bounds))}px apart; ${appliedClearance}px clearance is required`,
          [left.id, right.id].sort(),
          'warning'
        ));
      }
    }
  }

  for (let leftIndex = 0; leftIndex < geometry.labels.length; leftIndex++) {
    const left = geometry.labels[leftIndex];
    if (!finiteBounds(left.bounds)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.labels.length; rightIndex++) {
      const right = geometry.labels[rightIndex];
      if (left.planeId !== right.planeId || !finiteBounds(right.bounds)) continue;
      if (rectanglesCollide(left.bounds, right.bounds, 0, 0)) {
        diagnostics.push(diagnostic(
          'LABEL_OVERLAP',
          `Label ${left.id} for ${left.ownerId} overlaps label ${right.id} for ${right.ownerId}`,
          [left.ownerId, right.ownerId].sort()
        ));
      } else if (clearance > 0 && rectanglesCollide(left.bounds, right.bounds, clearance, tolerance)) {
        diagnostics.push(diagnostic(
          'MINIMUM_CLEARANCE',
          `Labels for ${left.ownerId} and ${right.ownerId} do not meet ${clearance}px clearance`,
          [left.ownerId, right.ownerId].sort(),
          'warning'
        ));
      }
    }
  }

  for (const label of geometry.labels) {
    if (!finiteBounds(label.bounds)) continue;
    const ancestors = labelContainerAncestors.get(label.id) ?? new Set<string>();
    for (const shape of geometry.shapes) {
      if (label.planeId !== shape.planeId
        || label.ownerId === shape.id
        || ancestors.has(shape.id)
        || !finiteBounds(shape.bounds)) continue;
      if (rectanglesCollide(label.bounds, shape.bounds, 0, 0)) {
        diagnostics.push(diagnostic(
          'LABEL_OVERLAP',
          `Label ${label.id} for ${label.ownerId} overlaps shape ${shape.id}`,
          [label.ownerId, shape.id]
        ));
      } else if (clearance > 0
        && rectanglesCollide(label.bounds, shape.bounds, clearance, tolerance)) {
        diagnostics.push(diagnostic(
          'MINIMUM_CLEARANCE',
          `Label ${label.id} for ${label.ownerId} does not meet ${clearance}px clearance from ${shape.id}`,
          [label.ownerId, shape.id],
          'warning'
        ));
      }
    }
  }
}

function validateEdgeShapeCollisions(
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[],
  clearance: number,
  tolerance: number
): void {
  const shapesById = uniqueShapesById(geometry.shapes);
  for (const edge of geometry.edges) {
    for (let segmentIndex = 0; segmentIndex < edge.waypoints.length - 1; segmentIndex++) {
      const start = edge.waypoints[segmentIndex];
      const end = edge.waypoints[segmentIndex + 1];
      if (!finitePoint(start) || !finitePoint(end)) continue;
      for (const shape of geometry.shapes) {
        if (shape.planeId !== edge.planeId
          || !finiteBounds(shape.bounds)
          || EDGE_CROSSABLE_CONTAINER_TYPES.has(shape.type)
          || isEndpointAncestor(shape.id, edge, shapesById)) continue;
        const legalSource = shape.id === edge.sourceId
          && segmentIndex === 0
          && leavesRectangle(start, end, shape.bounds, tolerance);
        const legalTarget = shape.id === edge.targetId
          && segmentIndex === edge.waypoints.length - 2
          && leavesRectangle(end, start, shape.bounds, tolerance);
        if (legalSource || legalTarget) continue;
        if (segmentIntersectsBounds(start, end, shape.bounds)) {
          diagnostics.push(diagnostic(
            'EDGE_SHAPE_COLLISION',
            `Edge ${edge.id} segment ${segmentIndex} crosses ${shape.id}`,
            [edge.id, shape.id]
          ));
        } else if (clearance > tolerance
          && segmentIntersectsBounds(start, end, expandBounds(shape.bounds, clearance - tolerance))) {
          diagnostics.push(diagnostic(
            'MINIMUM_CLEARANCE',
            `Edge ${edge.id} segment ${segmentIndex} does not meet ${clearance}px clearance from ${shape.id}`,
            [edge.id, shape.id],
            'warning'
          ));
        }
      }
    }
  }
}

function validateEdgeEdgeCrossings(
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[],
  clearance: number,
  tolerance: number
): void {
  for (let leftIndex = 0; leftIndex < geometry.edges.length; leftIndex++) {
    const left = geometry.edges[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.edges.length; rightIndex++) {
      const right = geometry.edges[rightIndex];
      if (left.planeId !== right.planeId) continue;

      let crossing: [number, number] | undefined;
      for (let leftSegment = 0; leftSegment < left.waypoints.length - 1 && !crossing; leftSegment++) {
        const leftStart = left.waypoints[leftSegment];
        const leftEnd = left.waypoints[leftSegment + 1];
        if (!finitePoint(leftStart) || !finitePoint(leftEnd)) continue;
        for (let rightSegment = 0; rightSegment < right.waypoints.length - 1; rightSegment++) {
          const rightStart = right.waypoints[rightSegment];
          const rightEnd = right.waypoints[rightSegment + 1];
          if (!finitePoint(rightStart) || !finitePoint(rightEnd)) continue;
          if (segmentsProperlyCross(leftStart, leftEnd, rightStart, rightEnd)) {
            crossing = [leftSegment, rightSegment];
            break;
          }
        }
      }

      if (crossing) {
        diagnostics.push(diagnostic(
          'EDGE_EDGE_CROSSING',
          `Edge ${left.id} segment ${crossing[0]} crosses edge ${right.id} segment ${crossing[1]}`,
          [left.id, right.id].sort()
        ));
        continue;
      }

      const overlap = collinearEdgeOverlap(left, right, tolerance);
      if (overlap) {
        diagnostics.push(diagnostic(
          'EDGE_EDGE_CROSSING',
          `Edge ${left.id} segment ${overlap[0]} runs along edge ${right.id} segment ${overlap[1]} for ${formatNumber(overlap[2])}px`,
          [left.id, right.id].sort()
        ));
        continue;
      }

      let closeSegments: [number, number, number] | undefined;
      for (let leftSegment = 0;
        leftSegment < left.waypoints.length - 1 && !closeSegments;
        leftSegment += 1) {
        const leftStart = left.waypoints[leftSegment];
        const leftEnd = left.waypoints[leftSegment + 1];
        if (!finitePoint(leftStart) || !finitePoint(leftEnd)) continue;
        for (let rightSegment = 0;
          rightSegment < right.waypoints.length - 1;
          rightSegment += 1) {
          const rightStart = right.waypoints[rightSegment];
          const rightEnd = right.waypoints[rightSegment + 1];
          if (!finitePoint(rightStart) || !finitePoint(rightEnd)
            || segmentsShareSemanticDock(
              left,
              leftSegment,
              right,
              rightSegment,
              tolerance
            )) continue;
          const gap = segmentDistance(leftStart, leftEnd, rightStart, rightEnd);
          if (gap < Math.max(0, clearance - tolerance)) {
            closeSegments = [leftSegment, rightSegment, gap];
            break;
          }
        }
      }
      if (closeSegments) {
        diagnostics.push(diagnostic(
          'MINIMUM_CLEARANCE',
          `Edge ${left.id} segment ${closeSegments[0]} and edge ${right.id} segment ${closeSegments[1]} are ${formatNumber(closeSegments[2])}px apart; ${clearance}px clearance is required`,
          [left.id, right.id].sort(),
          'warning'
        ));
      }
    }
  }
}

/**
 * Two connectors that run along each other are as unreadable as two that
 * cross, and `segmentsProperlyCross` deliberately ignores parallel segments.
 * Report the longest collinear overlap that is not the legal shared dock of
 * two connectors of the same kind (for example two flows out of one gateway).
 */
function collinearEdgeOverlap(
  left: GeometryEdge,
  right: GeometryEdge,
  tolerance: number
): [number, number, number] | undefined {
  for (let leftSegment = 0; leftSegment < left.waypoints.length - 1; leftSegment += 1) {
    const leftStart = left.waypoints[leftSegment];
    const leftEnd = left.waypoints[leftSegment + 1];
    if (!finitePoint(leftStart) || !finitePoint(leftEnd)) continue;
    for (let rightSegment = 0; rightSegment < right.waypoints.length - 1; rightSegment += 1) {
      const rightStart = right.waypoints[rightSegment];
      const rightEnd = right.waypoints[rightSegment + 1];
      if (!finitePoint(rightStart) || !finitePoint(rightEnd)
        || segmentsShareSemanticDock(left, leftSegment, right, rightSegment, tolerance)) continue;
      const overlap = collinearOverlapLength(
        leftStart,
        leftEnd,
        rightStart,
        rightEnd,
        tolerance
      );
      if (overlap > tolerance) return [leftSegment, rightSegment, overlap];
    }
  }
  return undefined;
}

function collinearOverlapLength(
  leftStart: GeometryPoint,
  leftEnd: GeometryPoint,
  rightStart: GeometryPoint,
  rightEnd: GeometryPoint,
  tolerance: number
): number {
  const deltaX = leftEnd.x - leftStart.x;
  const deltaY = leftEnd.y - leftStart.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length <= tolerance) return 0;
  const unitX = deltaX / length;
  const unitY = deltaY / length;
  const offset = (point: GeometryPoint): number =>
    Math.abs(unitX * (point.y - leftStart.y) - unitY * (point.x - leftStart.x));
  if (offset(rightStart) > tolerance || offset(rightEnd) > tolerance) return 0;
  const project = (point: GeometryPoint): number =>
    unitX * (point.x - leftStart.x) + unitY * (point.y - leftStart.y);
  const low = Math.min(project(rightStart), project(rightEnd));
  const high = Math.max(project(rightStart), project(rightEnd));
  return Math.max(0, Math.min(length, high) - Math.max(0, low));
}

/**
 * Connectors of the same kind may legally leave or enter one element at the
 * same point. A message flow that docks where a sequence flow already docks is
 * a layout defect, so the exemption is limited to same-kind connectors.
 */
function segmentsShareSemanticDock(
  left: GeometryEdge,
  leftSegment: number,
  right: GeometryEdge,
  rightSegment: number,
  tolerance: number
): boolean {
  if (left.type !== right.type) return false;
  const leftDocks = edgeSegmentDocks(left, leftSegment);
  const rightDocks = edgeSegmentDocks(right, rightSegment);
  return leftDocks.some(leftDock => rightDocks.some(rightDock =>
    leftDock.elementId === rightDock.elementId
    && Math.hypot(leftDock.point.x - rightDock.point.x, leftDock.point.y - rightDock.point.y)
      <= tolerance
  ));
}

function edgeSegmentDocks(
  edge: GeometryEdge,
  segmentIndex: number
): Array<{ elementId: string; point: GeometryPoint }> {
  const docks: Array<{ elementId: string; point: GeometryPoint }> = [];
  if (segmentIndex === 0 && edge.sourceId && edge.waypoints[0]) {
    docks.push({ elementId: edge.sourceId, point: edge.waypoints[0] });
  }
  if (segmentIndex === edge.waypoints.length - 2 && edge.targetId) {
    const point = edge.waypoints[edge.waypoints.length - 1];
    if (point) docks.push({ elementId: edge.targetId, point });
  }
  return docks;
}

function validateOrthogonalRoutes(
  geometry: BpmnGeometry,
  diagnostics: GeometryDiagnostic[],
  tolerance: number
): void {
  for (const edge of geometry.edges) {
    for (let segmentIndex = 0; segmentIndex < edge.waypoints.length - 1; segmentIndex += 1) {
      const start = edge.waypoints[segmentIndex];
      const end = edge.waypoints[segmentIndex + 1];
      if (!finitePoint(start) || !finitePoint(end)) continue;
      const deltaX = Math.abs(end.x - start.x);
      const deltaY = Math.abs(end.y - start.y);
      if (deltaX > tolerance && deltaY > tolerance) {
        diagnostics.push(diagnostic(
          'NON_ORTHOGONAL_ROUTE',
          `Edge ${edge.id} segment ${segmentIndex} is diagonal by ${formatNumber(deltaX)}px horizontally and ${formatNumber(deltaY)}px vertically`,
          [edge.id],
          'warning'
        ));
      }
    }
  }
}

function isEndpointAncestor(
  possibleAncestorId: string,
  edge: GeometryEdge,
  shapes: Map<string, GeometryShape>
): boolean {
  return [edge.sourceId, edge.targetId].some(endpointId => {
    let current = endpointId ? shapes.get(endpointId) : undefined;
    while (current?.parentId) {
      if (current.parentId === possibleAncestorId) return true;
      current = shapes.get(current.parentId);
    }
    return false;
  });
}

/**
 * A shape may always sit inside one of its own containers. Ancestry is resolved
 * by walking parentId (node -> lane -> participant, node -> expanded subprocess
 * -> participant) rather than by guessing from BPMN types, so a grandparent
 * pool never collides with a lane-parented node while a foreign pool still does.
 */
function legalShapeOverlap(
  left: GeometryShape,
  right: GeometryShape,
  ancestors: Map<string, Set<string>>
): boolean {
  return left.attachedToId === right.id
    || right.attachedToId === left.id
    || ancestors.get(left.id)?.has(right.id) === true
    || ancestors.get(right.id)?.has(left.id) === true;
}

/** Container ancestors of every shape, keyed by shape ID. */
function containerAncestorIndex(
  shapes: Map<string, GeometryShape>
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const shape of shapes.values()) {
    const ancestors = new Set<string>();
    let current: GeometryShape | undefined = shape;
    while (current?.parentId && !ancestors.has(current.parentId)) {
      ancestors.add(current.parentId);
      current = shapes.get(current.parentId);
    }
    index.set(shape.id, ancestors);
  }
  return index;
}

/**
 * Container ancestors of every label owner. A shape label inherits the owning
 * shape's containers; an edge label inherits the containers of both endpoints,
 * so an in-pool sequence-flow label never collides with the pool, lane, or
 * expanded subprocess it is drawn inside.
 */
function labelAncestorIndex(
  geometry: BpmnGeometry,
  shapeAncestors: Map<string, Set<string>>
): Map<string, Set<string>> {
  const edgesById = new Map(geometry.edges.map(edge => [edge.id, edge]));
  const index = new Map<string, Set<string>>();
  for (const label of geometry.labels) {
    const owned = shapeAncestors.get(label.ownerId);
    if (owned) {
      index.set(label.id, owned);
      continue;
    }
    const edge = edgesById.get(label.ownerId);
    index.set(label.id, new Set([
      ...(edge?.sourceId ? shapeAncestors.get(edge.sourceId) ?? [] : []),
      ...(edge?.targetId ? shapeAncestors.get(edge.targetId) ?? [] : [])
    ]));
  }
  return index;
}

function uniqueShapesById(shapes: GeometryShape[]): Map<string, GeometryShape> {
  const result = new Map<string, GeometryShape>();
  for (const shape of shapes) {
    if (!result.has(shape.id)) result.set(shape.id, shape);
  }
  return result;
}

function rectanglesCollide(
  left: GeometryBounds,
  right: GeometryBounds,
  clearance: number,
  tolerance: number
): boolean {
  const effective = Math.max(0, clearance - tolerance);
  return left.x - effective < right.x + right.width
    && left.x + left.width + effective > right.x
    && left.y - effective < right.y + right.height
    && left.y + left.height + effective > right.y;
}

function rectangleDistance(left: GeometryBounds, right: GeometryBounds): number {
  const horizontal = Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0
  );
  const vertical = Math.max(
    left.y - (right.y + right.height),
    right.y - (left.y + left.height),
    0
  );
  return Math.hypot(horizontal, vertical);
}

function containsBounds(parent: GeometryBounds, child: GeometryBounds, tolerance: number): boolean {
  return child.x >= parent.x - tolerance
    && child.y >= parent.y - tolerance
    && child.x + child.width <= parent.x + parent.width + tolerance
    && child.y + child.height <= parent.y + parent.height + tolerance;
}

function boundaryAttachesToHost(event: GeometryBounds, host: GeometryBounds, tolerance: number): boolean {
  const center = { x: event.x + event.width / 2, y: event.y + event.height / 2 };
  return distanceToRectangleBoundary(center, host) <= Math.max(event.width, event.height) / 2 + tolerance
    && rectanglesCollide(event, host, 0, tolerance);
}

function distanceToRectangleBoundary(point: GeometryPoint, bounds: GeometryBounds): number {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const insideX = point.x >= bounds.x && point.x <= right;
  const insideY = point.y >= bounds.y && point.y <= bottom;
  if (insideX && insideY) {
    return Math.min(point.x - bounds.x, right - point.x, point.y - bounds.y, bottom - point.y);
  }
  const closestX = Math.max(bounds.x, Math.min(point.x, right));
  const closestY = Math.max(bounds.y, Math.min(point.y, bottom));
  return Math.hypot(point.x - closestX, point.y - closestY);
}

function leavesRectangle(
  endpoint: GeometryPoint,
  next: GeometryPoint,
  bounds: GeometryBounds,
  tolerance: number
): boolean {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const onLeft = Math.abs(endpoint.x - bounds.x) <= tolerance;
  const onRight = Math.abs(endpoint.x - right) <= tolerance;
  const onTop = Math.abs(endpoint.y - bounds.y) <= tolerance;
  const onBottom = Math.abs(endpoint.y - bottom) <= tolerance;
  return (onLeft && next.x <= endpoint.x + tolerance)
    || (onRight && next.x >= endpoint.x - tolerance)
    || (onTop && next.y <= endpoint.y + tolerance)
    || (onBottom && next.y >= endpoint.y - tolerance);
}

function segmentIntersectsBounds(start: GeometryPoint, end: GeometryPoint, bounds: GeometryBounds): boolean {
  let minimum = 0;
  let maximum = 1;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const checks: Array<[number, number]> = [
    [-deltaX, start.x - bounds.x],
    [deltaX, bounds.x + bounds.width - start.x],
    [-deltaY, start.y - bounds.y],
    [deltaY, bounds.y + bounds.height - start.y]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function segmentsProperlyCross(
  leftStart: GeometryPoint,
  leftEnd: GeometryPoint,
  rightStart: GeometryPoint,
  rightEnd: GeometryPoint
): boolean {
  const leftToRightStart = crossProduct(leftStart, leftEnd, rightStart);
  const leftToRightEnd = crossProduct(leftStart, leftEnd, rightEnd);
  const rightToLeftStart = crossProduct(rightStart, rightEnd, leftStart);
  const rightToLeftEnd = crossProduct(rightStart, rightEnd, leftEnd);
  return leftToRightStart * leftToRightEnd < 0
    && rightToLeftStart * rightToLeftEnd < 0;
}

function segmentDistance(
  leftStart: GeometryPoint,
  leftEnd: GeometryPoint,
  rightStart: GeometryPoint,
  rightEnd: GeometryPoint
): number {
  return Math.min(
    pointToSegmentDistance(leftStart, rightStart, rightEnd),
    pointToSegmentDistance(leftEnd, rightStart, rightEnd),
    pointToSegmentDistance(rightStart, leftStart, leftEnd),
    pointToSegmentDistance(rightEnd, leftStart, leftEnd)
  );
}

function pointToSegmentDistance(
  point: GeometryPoint,
  start: GeometryPoint,
  end: GeometryPoint
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const squaredLength = deltaX ** 2 + deltaY ** 2;
  if (squaredLength === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / squaredLength
  ));
  return Math.hypot(
    point.x - (start.x + projection * deltaX),
    point.y - (start.y + projection * deltaY)
  );
}

function crossProduct(start: GeometryPoint, end: GeometryPoint, point: GeometryPoint): number {
  return (end.x - start.x) * (point.y - start.y)
    - (end.y - start.y) * (point.x - start.x);
}

function expandBounds(bounds: GeometryBounds, amount: number): GeometryBounds {
  const safeAmount = Math.max(0, amount);
  return {
    x: bounds.x - safeAmount,
    y: bounds.y - safeAmount,
    width: bounds.width + safeAmount * 2,
    height: bounds.height + safeAmount * 2
  };
}

function readBounds(value: any): GeometryBounds {
  return {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height)
  };
}

function readPoint(value: any): GeometryPoint {
  return { x: Number(value?.x), y: Number(value?.y) };
}

function finiteBounds(bounds: GeometryBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0
    && bounds.height > 0;
}

function finitePoint(point: GeometryPoint): boolean {
  return [point.x, point.y].every(Number.isFinite);
}

function diagnostic(
  code: GeometryDiagnosticCode,
  message: string,
  ids: string[],
  severity: GeometryDiagnosticSeverity = 'error'
): GeometryDiagnostic {
  return { code, severity, message, ids };
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function byId(left: { id: string }, right: { id: string }): number {
  return compareStableText(left.id, right.id);
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
