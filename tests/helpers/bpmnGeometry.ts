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
  | 'CONTAINMENT_FAILURE';

export interface GeometryDiagnostic {
  code: GeometryDiagnosticCode;
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
}

export interface GeometryValidationReport {
  valid: boolean;
  diagnostics: GeometryDiagnostic[];
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

interface SemanticIndex {
  elements: Map<string, SemanticElement>;
  participantByProcess: Map<string, string>;
  laneByFlowNode: Map<string, string>;
}

const DEFAULT_CLEARANCE = 5;
const DEFAULT_TOLERANCE = 1;
const CONTAINER_TYPES = new Set(['bpmn:Participant', 'bpmn:Lane', 'bpmn:SubProcess']);
const EDGE_CROSSABLE_CONTAINER_TYPES = new Set(['bpmn:Participant', 'bpmn:Lane']);

export async function validateBpmnGeometry(
  xml: string,
  options: GeometryValidationOptions = {}
): Promise<GeometryValidationReport> {
  const diagnostics: GeometryDiagnostic[] = [];
  let definitions: any;

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
    return { valid: false, diagnostics };
  }

  const diagrams = definitions.diagrams || [];
  if (diagrams.length === 0 || diagrams.every((diagram: any) => !diagram.plane)) {
    diagnostics.push(diagnostic('MISSING_DI', 'BPMN document does not contain a DI plane', []));
    return { valid: false, diagnostics };
  }

  const semantic = buildSemanticIndex(definitions);
  const geometry = extractGeometry(diagrams, semantic);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const clearance = options.clearance ?? DEFAULT_CLEARANCE;

  validateCompleteness(semantic, geometry, diagnostics);
  validateFiniteGeometry(geometry, diagnostics);
  validateEndpoints(geometry, diagnostics, tolerance);
  validateContainment(geometry, diagnostics, tolerance);
  validateShapeAndLabelOverlaps(geometry, diagnostics, clearance, tolerance);
  validateEdgeShapeCollisions(geometry, diagnostics, clearance, tolerance);

  diagnostics.sort((left, right) =>
    left.code.localeCompare(right.code)
      || left.ids.join('\0').localeCompare(right.ids.join('\0'))
      || left.message.localeCompare(right.message)
  );

  return {
    valid: diagnostics.length === 0,
    diagnostics,
    geometry,
    normalized: normalizeGeometry(geometry, tolerance)
  };
}

export function normalizeGeometry(
  geometry: BpmnGeometry,
  tolerance = DEFAULT_TOLERANCE
): NormalizedGeometry {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error('Geometry normalization tolerance must be a positive finite number');
  }

  const coordinates = [
    ...geometry.shapes.flatMap(shape => [shape.bounds.x, shape.bounds.y]),
    ...geometry.edges.flatMap(edge => edge.waypoints.flatMap(point => [point.x, point.y])),
    ...geometry.labels.flatMap(label => [label.bounds.x, label.bounds.y])
  ].filter(Number.isFinite);
  const origin = coordinates.length === 0
    ? { x: 0, y: 0 }
    : {
        x: Math.min(
          ...geometry.shapes.map(shape => shape.bounds.x),
          ...geometry.edges.flatMap(edge => edge.waypoints.map(point => point.x)),
          ...geometry.labels.map(label => label.bounds.x)
        ),
        y: Math.min(
          ...geometry.shapes.map(shape => shape.bounds.y),
          ...geometry.edges.flatMap(edge => edge.waypoints.map(point => point.y)),
          ...geometry.labels.map(label => label.bounds.y)
        )
      };
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
  if (report.valid) return 'valid geometry';
  return report.diagnostics
    .map(item => `${item.code}${item.ids.length ? ` [${item.ids.join(', ')}]` : ''}: ${item.message}`)
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
  for (let leftIndex = 0; leftIndex < geometry.shapes.length; leftIndex++) {
    const left = geometry.shapes[leftIndex];
    if (!finiteBounds(left.bounds)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.shapes.length; rightIndex++) {
      const right = geometry.shapes[rightIndex];
      if (left.planeId !== right.planeId || !finiteBounds(right.bounds) || legalShapeOverlap(left, right)) continue;
      const appliedClearance = CONTAINER_TYPES.has(left.type) || CONTAINER_TYPES.has(right.type) ? 0 : clearance;
      if (rectanglesCollide(left.bounds, right.bounds, appliedClearance, tolerance)) {
        diagnostics.push(diagnostic(
          'SHAPE_OVERLAP',
          `${left.id} overlaps ${right.id} with ${appliedClearance}px clearance`,
          [left.id, right.id].sort()
        ));
      }
    }
  }

  for (const label of geometry.labels) {
    if (!finiteBounds(label.bounds)) continue;
    for (const shape of geometry.shapes) {
      if (label.planeId !== shape.planeId || label.ownerId === shape.id || !finiteBounds(shape.bounds)) continue;
      if (rectanglesCollide(label.bounds, shape.bounds, clearance, tolerance)) {
        diagnostics.push(diagnostic(
          'LABEL_OVERLAP',
          `Label ${label.id} for ${label.ownerId} overlaps shape ${shape.id}`,
          [label.ownerId, shape.id]
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
        if (segmentIntersectsBounds(start, end, expandBounds(shape.bounds, clearance - tolerance))) {
          diagnostics.push(diagnostic(
            'EDGE_SHAPE_COLLISION',
            `Edge ${edge.id} segment ${segmentIndex} crosses ${shape.id}`,
            [edge.id, shape.id]
          ));
        }
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

function legalShapeOverlap(left: GeometryShape, right: GeometryShape): boolean {
  return left.parentId === right.id
    || right.parentId === left.id
    || left.attachedToId === right.id
    || right.attachedToId === left.id
    || (left.type === 'bpmn:Participant' && right.type === 'bpmn:Lane')
    || (right.type === 'bpmn:Participant' && left.type === 'bpmn:Lane');
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
  ids: string[]
): GeometryDiagnostic {
  return { code, message, ids };
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
