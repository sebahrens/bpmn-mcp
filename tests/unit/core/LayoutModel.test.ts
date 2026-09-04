import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MermaidAST } from '../../../src/converters/ASTTypes.js';
import {
  createProcessContext
} from '../../../src/core/BpmnDocument.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { SimpleBpmnGenerator } from '../../../src/core/SimpleBpmnGenerator.js';
import { BpmnDocumentLayoutAdapter } from '../../../src/core/layout/adapters/BpmnDocumentLayoutAdapter.js';
import { MermaidAstLayoutAdapter } from '../../../src/core/layout/adapters/MermaidAstLayoutAdapter.js';
import {
  calculateLayoutBounds,
  normalizeLayoutModel,
  refreshLayoutGeometry,
  setLayoutEdgeWaypoints,
  validateLayoutModel
} from '../../../src/core/layout/LayoutModel.js';
import type {
  LayoutEdgeSegment,
  LayoutModel as CanonicalLayoutModel
} from '../../../src/core/layout/LayoutModel.js';

const mermaidAst = (): MermaidAST => ({
  type: 'flowchart',
  direction: 'LR',
  nodes: [
    { id: 'task', type: 'process', label: 'Review request' },
    { id: 'end', type: 'end', label: 'End' },
    { id: 'start', type: 'start', label: 'Start' }
  ],
  edges: [
    { id: 'flow-b', source: 'task', target: 'end', type: 'directed' },
    { id: 'flow-a', source: 'start', target: 'task', type: 'labeled', label: 'submit' }
  ],
  subgraphs: [
    { id: 'pool', title: 'Operations', nodes: ['task', 'end', 'start'] }
  ]
});


/**
 * Structural invariants of the canonical layout model (mcp-bpmn-5e7.10).
 *
 * validateLayoutModel guards every auto_layout result, but only five of its
 * codes were ever produced by a test. Each row below takes a model that
 * validates completely clean, changes exactly one field, and asserts both the
 * code that must appear and the object it must name. The clean baseline is
 * re-asserted for every row, so a rule that fires on a valid model fails here
 * just as loudly as one that stops firing on an invalid one.
 */
describe('layout model validation codes', () => {
  const collaborationLayout = (): CanonicalLayoutModel => {
    const context = createProcessContext('Collaboration_1', 'Partners', 'collaboration');
    context.document.processes.set('Buyer_Process', { id: 'Buyer_Process', isExecutable: true });
    context.document.processes.set('Seller_Process', { id: 'Seller_Process', isExecutable: true });
    context.elements.set('Buyer', {
      kind: 'participant', id: 'Buyer', type: 'bpmn:Participant', ownerId: context.id,
      scopeId: context.id, processRef: 'Buyer_Process', position: { x: 20, y: 20 },
      size: { width: 500, height: 180 }, properties: {}
    });
    context.elements.set('Seller', {
      kind: 'participant', id: 'Seller', type: 'bpmn:Participant', ownerId: context.id,
      scopeId: context.id, processRef: 'Seller_Process', position: { x: 20, y: 240 },
      size: { width: 500, height: 180 }, properties: {}
    });
    context.elements.set('Send', {
      kind: 'flowNode', id: 'Send', type: 'bpmn:SendTask', ownerId: 'Buyer_Process',
      scopeId: 'Buyer_Process', position: { x: 100, y: 70 },
      size: { width: 100, height: 80 }, properties: {}
    });
    context.elements.set('Receive', {
      kind: 'flowNode', id: 'Receive', type: 'bpmn:ReceiveTask', ownerId: 'Seller_Process',
      scopeId: 'Seller_Process', position: { x: 300, y: 290 },
      size: { width: 100, height: 80 }, properties: {}
    });
    return BpmnDocumentLayoutAdapter.fromContext(context);
  };

  const flowchartLayout = (): CanonicalLayoutModel =>
    MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());

  /** The same flowchart with flow-a split into two continuous virtual segments. */
  const splitEdgeLayout = (): CanonicalLayoutModel => {
    const model = flowchartLayout();
    const edge = model.edges.get('flow-a')!;
    const middle = { x: 180, y: 180 };
    const last = edge.waypoints[edge.waypoints.length - 1];
    edge.waypoints = [edge.waypoints[0], middle, last];
    edge.segments = [
      {
        id: 'flow-a:segment:0',
        semanticEdgeId: 'flow-a',
        order: 0,
        source: { ...edge.source },
        target: { nodeId: 'virtual:flow-a:0' },
        waypoints: [edge.waypoints[0], middle],
        virtual: true
      },
      {
        id: 'flow-a:segment:1',
        semanticEdgeId: 'flow-a',
        order: 1,
        source: { nodeId: 'virtual:flow-a:0' },
        target: { ...edge.target },
        waypoints: [middle, last],
        virtual: true
      }
    ] satisfies LayoutEdgeSegment[];
    return model;
  };

  const rekey = <T>(map: Map<string, T>, from: string, to: string): void => {
    const value = map.get(from)!;
    map.delete(from);
    map.set(to, value);
  };

  it('pins the map iteration order the duplicate-detection rows depend on', () => {
    const model = flowchartLayout();

    expect([...model.nodes.keys()]).toEqual(['end', 'start', 'task']);
    expect([...model.edges.keys()]).toEqual(['flow-a', 'flow-b']);
    expect([...model.containers.keys()]).toEqual(['mermaid:root', 'pool']);
    expect([...model.labels.keys()]).toEqual([
      'node:end:label',
      'node:start:label',
      'node:task:label',
      'container:pool:label',
      'edge:flow-a:label'
    ]);
  });

  interface LayoutErrorCase {
    code: string;
    /** Objects the code must name, in the order validateLayoutModel reports them. */
    elementIds: Array<string | undefined>;
    base?: () => CanonicalLayoutModel;
    mutate: (model: CanonicalLayoutModel) => void;
  }

  const cases: LayoutErrorCase[] = [
    {
      code: 'invalid-diagram-bounds',
      elementIds: [undefined],
      mutate: model => { model.bounds.width = Number.NaN; }
    },
    {
      code: 'stale-diagram-bounds',
      elementIds: [undefined],
      mutate: model => { model.bounds.x += 1; }
    },
    {
      code: 'node-map-key-mismatch',
      elementIds: ['start'],
      mutate: model => rekey(model.nodes, 'start', 'start:renamed')
    },
    {
      code: 'invalid-node-bounds',
      elementIds: ['task'],
      mutate: model => { model.nodes.get('task')!.bounds.width = 0; }
    },
    {
      code: 'duplicate-semantic-node-id',
      elementIds: ['task'],
      mutate: model => { model.nodes.get('task')!.semanticId = 'start'; }
    },
    {
      code: 'missing-node-container',
      elementIds: ['start'],
      mutate: model => { model.nodes.get('start')!.containerId = 'container:absent'; }
    },
    {
      code: 'nonreciprocal-node-container',
      elementIds: ['start'],
      mutate: model => { model.containers.get('pool')!.nodeIds = ['end', 'task']; }
    },
    {
      code: 'missing-node-ownership',
      elementIds: ['start'],
      mutate: model => { model.nodes.get('start')!.ownerId = 'scope:absent'; }
    },
    {
      code: 'invalid-node-port-set',
      elementIds: ['task'],
      mutate: model => {
        const node = model.nodes.get('task')!;
        node.ports = node.ports.filter(port => port.role !== 'incoming');
      }
    },
    {
      code: 'invalid-node-port',
      elementIds: ['start'],
      mutate: model => {
        const port = model.nodes.get('start')!.ports.find(item => item.role === 'incoming')!;
        port.position = { x: port.position.x + 5, y: port.position.y };
      }
    },
    {
      code: 'edge-map-key-mismatch',
      elementIds: ['flow-b'],
      mutate: model => rekey(model.edges, 'flow-b', 'flow-b:renamed')
    },
    {
      code: 'duplicate-semantic-edge-id',
      elementIds: ['flow-b'],
      mutate: model => { model.edges.get('flow-b')!.semanticId = 'flow-a'; }
    },
    {
      code: 'missing-edge-ownership',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.scopeId = 'scope:absent'; }
    },
    {
      code: 'missing-edge-source',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.source.nodeId = 'node:absent'; }
    },
    {
      code: 'missing-edge-target',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.target.nodeId = 'node:absent'; }
    },
    {
      code: 'invalid-edge-waypoints',
      elementIds: ['flow-a'],
      mutate: model => {
        const edge = model.edges.get('flow-a')!;
        edge.waypoints[1] = { x: Number.POSITIVE_INFINITY, y: edge.waypoints[1].y };
      }
    },
    {
      code: 'missing-endpoint-port',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.source.portId = 'start:port:absent'; }
    },
    {
      code: 'undocked-edge-route',
      elementIds: ['flow-a'],
      mutate: model => {
        // flow-a leaves start through its outgoing port; a port that no longer
        // throws cannot be the source end of a route.
        model.nodes.get('start')!.ports.find(port => port.role === 'outgoing')!.role = 'incoming';
      }
    },
    {
      code: 'missing-edge-segments',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.segments = []; }
    },
    {
      code: 'duplicate-segment-id',
      elementIds: ['flow-b'],
      mutate: model => { model.edges.get('flow-b')!.segments[0].id = 'flow-a:segment:0'; }
    },
    {
      code: 'segment-semantic-edge-mismatch',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.segments[0].semanticEdgeId = 'flow-b'; }
    },
    {
      code: 'segment-order-gap',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.segments[0].order = 1; }
    },
    {
      code: 'invalid-segment-waypoints',
      elementIds: ['flow-a'],
      mutate: model => {
        const segment = model.edges.get('flow-a')!.segments[0];
        segment.waypoints = [segment.waypoints[0]];
      }
    },
    {
      code: 'segment-endpoint-mismatch',
      elementIds: ['flow-a'],
      mutate: model => { model.edges.get('flow-a')!.segments[0].source = { nodeId: 'end' }; }
    },
    {
      code: 'segment-waypoint-mismatch',
      elementIds: ['flow-a'],
      mutate: model => {
        const segment = model.edges.get('flow-a')!.segments[0];
        segment.waypoints[0] = { x: segment.waypoints[0].x + 3, y: segment.waypoints[0].y };
      }
    },
    {
      code: 'disconnected-edge-segments',
      elementIds: ['flow-a'],
      base: splitEdgeLayout,
      mutate: model => {
        const segments = model.edges.get('flow-a')!.segments;
        segments[1].waypoints[0] = {
          x: segments[1].waypoints[0].x + 1,
          y: segments[1].waypoints[0].y
        };
      }
    },
    {
      code: 'container-map-key-mismatch',
      elementIds: ['pool'],
      mutate: model => rekey(model.containers, 'pool', 'pool:renamed')
    },
    {
      code: 'duplicate-semantic-container-id',
      elementIds: ['pool'],
      mutate: model => { model.containers.get('pool')!.semanticId = 'mermaid:root'; }
    },
    {
      code: 'invalid-container-bounds',
      elementIds: ['pool'],
      mutate: model => { model.containers.get('pool')!.bounds.height = Number.NaN; }
    },
    {
      code: 'missing-container-parent',
      elementIds: ['pool'],
      mutate: model => { model.containers.get('pool')!.parentId = 'container:absent'; }
    },
    {
      code: 'nonreciprocal-container-parent',
      elementIds: ['pool'],
      mutate: model => { model.containers.get('mermaid:root')!.childContainerIds = []; }
    },
    {
      code: 'duplicate-container-member',
      elementIds: ['pool'],
      mutate: model => { model.containers.get('pool')!.nodeIds.push('start'); }
    },
    {
      code: 'missing-container-node',
      elementIds: ['pool'],
      mutate: model => { model.containers.get('pool')!.nodeIds.push('node:absent'); }
    },
    {
      code: 'nonreciprocal-container-node',
      elementIds: ['pool'],
      mutate: model => { model.nodes.get('start')!.containerId = 'mermaid:root'; }
    },
    {
      code: 'missing-child-container',
      elementIds: ['mermaid:root'],
      mutate: model => {
        model.containers.get('mermaid:root')!.childContainerIds.push('container:absent');
      }
    },
    {
      code: 'nonreciprocal-child-container',
      elementIds: ['mermaid:root'],
      mutate: model => { model.containers.get('pool')!.parentId = undefined; }
    },
    {
      code: 'container-cycle',
      elementIds: ['mermaid:root', 'pool'],
      mutate: model => { model.containers.get('mermaid:root')!.parentId = 'pool'; }
    },
    {
      code: 'container-node-bounds-mismatch',
      elementIds: ['Buyer'],
      base: collaborationLayout,
      mutate: model => { model.containers.get('Buyer')!.bounds.x += 1; }
    },
    {
      code: 'label-map-key-mismatch',
      elementIds: ['edge:flow-a:label'],
      mutate: model => rekey(model.labels, 'edge:flow-a:label', 'edge:flow-a:label:renamed')
    },
    {
      code: 'invalid-layout-label',
      elementIds: ['node:start:label'],
      mutate: model => { model.labels.get('node:start:label')!.ownerId = 'node:absent'; }
    },
    {
      code: 'invalid-layout-label',
      elementIds: ['edge:flow-a:label'],
      mutate: model => { model.labels.get('edge:flow-a:label')!.ownerId = 'edge:absent'; }
    },
    {
      code: 'invalid-layout-label',
      elementIds: ['container:pool:label'],
      mutate: model => {
        model.labels.get('container:pool:label')!.bounds.width = Number.NaN;
      }
    }
  ];

  it.each(cases)(
    'reports $code on $elementIds after a single-field mutation',
    ({ code, elementIds, base = flowchartLayout, mutate }) => {
      expect(validateLayoutModel(base())).toEqual({ valid: true, errors: [] });

      const model = base();
      mutate(model);
      const result = validateLayoutModel(model);

      expect(result.valid).toBe(false);
      expect(result.errors.filter(error => error.code === code).map(error => error.elementId))
        .toEqual(elementIds);
      expect(result.errors.every(error => typeof error.message === 'string' && error.message))
        .toBe(true);
    }
  );

  it('covers every code validateLayoutModel can emit', async () => {
    const source = await fs.readFile(
      join(process.cwd(), 'src', 'core', 'layout', 'LayoutModel.ts'),
      'utf8'
    );
    const emitted = new Set(
      Array.from(source.matchAll(/\bcode: '([a-z-]+)'/gu), match => match[1])
    );

    expect(emitted.size).toBeGreaterThan(0);
    expect([...emitted].sort()).toEqual([...new Set(cases.map(item => item.code))].sort());
  });
});

describe('canonical layout model', () => {
  it('calculates bounds for more elements than can be passed as function arguments', () => {
    const layout = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    const node = layout.nodes.get('task')!;
    const label = layout.labels.get('node:task:label')!;
    const container = layout.containers.get('pool')!;
    node.bounds = { x: 10, y: 20, width: 30, height: 40 };
    label.bounds = { ...node.bounds };
    container.bounds = { ...node.bounds };
    const repeatedMap = <T>(prefix: string, value: T): Map<string, T> => new Map(
      Array.from({ length: 50_000 }, (_, index) => [`${prefix}-${index}`, value])
    );
    layout.nodes = repeatedMap('node', node);
    layout.labels = repeatedMap('label', label);
    layout.containers = repeatedMap('container', container);
    layout.edges.clear();

    expect(calculateLayoutBounds(layout)).toEqual({
      x: -10,
      y: 0,
      width: 70,
      height: 80
    });
  });

  it('adapts Mermaid nodes, edges, labels, containers, ports and warnings deterministically', () => {
    const first = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    const second = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    const normalized = normalizeLayoutModel(first);

    expect(normalized).toEqual(normalizeLayoutModel(second));
    expect(normalized.direction).toBe('left-to-right');
    expect(normalized.nodes.map(node => node.id)).toEqual(['end', 'start', 'task']);
    expect(normalized.nodes.every(node => node.ports.length === 2)).toBe(true);
    expect(normalized.edges.map(edge => edge.id)).toEqual(['flow-a', 'flow-b']);
    expect(normalized.edges[0]).toMatchObject({
      semanticId: 'flow-a',
      source: { nodeId: 'start' },
      target: { nodeId: 'task' }
    });
    expect(normalized.edges[0].segments).toEqual([
      expect.objectContaining({ semanticEdgeId: 'flow-a', order: 0, virtual: false })
    ]);
    expect(normalized.labels.map(label => label.id)).toEqual([
      'container:pool:label',
      'edge:flow-a:label',
      'node:end:label',
      'node:start:label',
      'node:task:label'
    ]);
    expect(normalized.containers.map(container => container.id)).toEqual(['mermaid:root', 'pool']);
    expect(normalized.bounds.width).toBeGreaterThan(0);
    expect(normalized.warnings).toEqual([]);
    expect(validateLayoutModel(first)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(normalized)).not.toContain('xml');
  });

  it('returns identical normalized layout and BPMN IDs for repeated stable Mermaid input', async () => {
    const reordered = mermaidAst();
    reordered.nodes.reverse();
    reordered.edges.reverse();
    const firstLayout = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    const secondLayout = MermaidAstLayoutAdapter.toLayoutModel(reordered);
    expect(normalizeLayoutModel(firstLayout)).toEqual(normalizeLayoutModel(secondLayout));

    const generator = new SimpleBpmnGenerator();
    firstLayout.warnings.push({ code: 'test-warning', message: 'Layout warning' });
    secondLayout.warnings.push({ code: 'test-warning', message: 'Layout warning' });
    const first = await generator.generateBpmn(mermaidAst(), 'Stable process', firstLayout);
    const second = await generator.generateBpmn(reordered, 'Stable process', secondLayout);
    expect(second.xml).toBe(first.xml);
    expect(first.warnings).toEqual(['Layout warning']);
  });

  it.each([
    ['LR', 'left-to-right', 'right'],
    ['RL', 'right-to-left', 'left'],
    ['TD', 'top-to-bottom', 'bottom'],
    ['BT', 'bottom-to-top', 'top']
  ] as const)('adapts and docks %s geometry consistently', (mermaidDirection, direction, outputSide) => {
    const ast = mermaidAst();
    ast.direction = mermaidDirection;
    const layout = MermaidAstLayoutAdapter.toLayoutModel(ast);
    const start = layout.nodes.get('start')!;

    expect(layout.direction).toBe(direction);
    expect(start.ports.find(port => port.role === 'outgoing')).toMatchObject({ side: outputSide });
    expect(validateLayoutModel(layout)).toEqual({ valid: true, errors: [] });
  });

  it('uses stable tie-breaking for cycles and gateway branches', () => {
    const ast: MermaidAST = {
      type: 'flowchart',
      direction: 'LR',
      nodes: [
        { id: 'gateway', type: 'decision', label: 'Choose' },
        { id: 'alpha', type: 'process', label: 'Alpha' },
        { id: 'beta', type: 'process', label: 'Beta' }
      ],
      edges: [
        { id: 'z-cycle', source: 'beta', target: 'gateway', type: 'directed' },
        { id: 'b-branch', source: 'gateway', target: 'beta', type: 'directed' },
        { id: 'a-branch', source: 'gateway', target: 'alpha', type: 'directed' },
        { id: 'a-cycle', source: 'alpha', target: 'gateway', type: 'directed' }
      ],
      subgraphs: []
    };
    const reordered: MermaidAST = {
      ...ast,
      nodes: [...ast.nodes].reverse(),
      edges: [...ast.edges].reverse()
    };

    expect(normalizeLayoutModel(MermaidAstLayoutAdapter.toLayoutModel(ast)))
      .toEqual(normalizeLayoutModel(MermaidAstLayoutAdapter.toLayoutModel(reordered)));
  });

  it('includes nested child geometry and rejects unknown container members', () => {
    const nested = mermaidAst();
    nested.subgraphs = [{
      id: 'parent',
      title: 'Parent',
      nodes: [],
      subgraphs: [{ id: 'child', title: 'Child', nodes: ['start', 'task', 'end'] }]
    }];
    const layout = MermaidAstLayoutAdapter.toLayoutModel(nested);
    expect(layout.containers.get('parent')!.bounds.width).toBeGreaterThan(0);
    expect(layout.containers.get('parent')!.childContainerIds).toEqual(['child']);
    expect(validateLayoutModel(layout).valid).toBe(true);

    nested.subgraphs[0].nodes.push('missing');
    expect(() => MermaidAstLayoutAdapter.toLayoutModel(nested)).toThrow('references unknown node missing');
  });

  it('round-trips BPMN semantic IDs, ownership and connectivity while applying geometry', () => {
    const context = createProcessContext('Process_1', 'Round trip', 'process');
    context.elements.set('Start_1', {
      kind: 'flowNode',
      id: 'Start_1',
      type: 'bpmn:StartEvent',
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      position: { x: 20, y: 40 },
      size: { width: 36, height: 36 },
      properties: {}
    });
    context.elements.set('Task_1', {
      kind: 'flowNode',
      id: 'Task_1',
      type: 'bpmn:Task',
      name: 'Review',
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      position: { x: 160, y: 20 },
      size: { width: 100, height: 80 },
      properties: {}
    });
    context.connections.set('Flow_1', {
      id: 'Flow_1',
      type: 'bpmn:SequenceFlow',
      source: 'Start_1',
      target: 'Task_1',
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      label: 'continue',
      waypoints: [{ x: 56, y: 58 }, { x: 160, y: 60 }],
      properties: {}
    });

    const layout = BpmnDocumentLayoutAdapter.fromContext(context);
    layout.nodes.get('Task_1')!.bounds = { x: 240, y: 80, width: 120, height: 90 };
    refreshLayoutGeometry(layout);
    setLayoutEdgeWaypoints(layout.edges.get('Flow_1')!, [
      { x: 56, y: 58 },
      { x: 140, y: 58 },
      { x: 240, y: 125 }
    ]);
    refreshLayoutGeometry(layout);
    BpmnDocumentLayoutAdapter.applyToContext(layout, context);
    const roundTripped = BpmnDocumentLayoutAdapter.fromDocument(context.document);

    expect(context.elements.get('Task_1')).toMatchObject({
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      position: { x: 240, y: 80 },
      size: { width: 120, height: 90 }
    });
    expect(context.connections.get('Flow_1')).toMatchObject({
      source: 'Start_1',
      target: 'Task_1',
      waypoints: layout.edges.get('Flow_1')!.waypoints
    });
    expect(roundTripped.nodes.get('Task_1')).toMatchObject({
      semanticId: 'Task_1',
      ownerId: 'Process_1',
      scopeId: 'Process_1'
    });
    expect(roundTripped.edges.get('Flow_1')).toMatchObject({
      semanticId: 'Flow_1',
      source: { nodeId: 'Start_1' },
      target: { nodeId: 'Task_1' }
    });
    expect(roundTripped.edges.get('Flow_1')!.segments.every(
      segment => segment.semanticEdgeId === 'Flow_1'
    )).toBe(true);
    expect(validateLayoutModel(roundTripped).valid).toBe(true);
  });

  it('adapts collaboration containers and message-flow ownership without losing hierarchy', () => {
    const context = createProcessContext('Collaboration_1', 'Partners', 'collaboration');
    context.document.processes.set('Buyer_Process', { id: 'Buyer_Process', isExecutable: true });
    context.document.processes.set('Seller_Process', { id: 'Seller_Process', isExecutable: true });
    context.elements.set('Buyer', {
      kind: 'participant', id: 'Buyer', type: 'bpmn:Participant', ownerId: context.id, scopeId: context.id,
      processRef: 'Buyer_Process', position: { x: 20, y: 20 }, size: { width: 500, height: 180 }, properties: {}
    });
    context.elements.set('Seller', {
      kind: 'participant', id: 'Seller', type: 'bpmn:Participant', ownerId: context.id, scopeId: context.id,
      processRef: 'Seller_Process', position: { x: 20, y: 240 }, size: { width: 500, height: 180 }, properties: {}
    });
    context.elements.set('Send', {
      kind: 'flowNode', id: 'Send', type: 'bpmn:SendTask', ownerId: 'Buyer_Process', scopeId: 'Buyer_Process',
      position: { x: 100, y: 70 }, size: { width: 100, height: 80 }, properties: {}
    });
    context.elements.set('Receive', {
      kind: 'flowNode', id: 'Receive', type: 'bpmn:ReceiveTask', ownerId: 'Seller_Process', scopeId: 'Seller_Process',
      position: { x: 300, y: 290 }, size: { width: 100, height: 80 }, properties: {}
    });
    context.connections.set('Message_1', {
      id: 'Message_1', type: 'bpmn:MessageFlow', source: 'Send', target: 'Receive', ownerId: context.id,
      scopeId: context.id, waypoints: [{ x: 200, y: 110 }, { x: 300, y: 330 }], properties: {}
    });

    const layout = BpmnDocumentLayoutAdapter.fromContext(context);
    expect(layout.nodes.get('Send')!.containerId).toBe('Buyer');
    expect(layout.containers.get('Buyer_Process')).toMatchObject({ parentId: 'Buyer' });
    expect(layout.edges.get('Message_1')).toMatchObject({ ownerId: context.id, scopeId: context.id });
    expect(validateLayoutModel(layout)).toEqual({ valid: true, errors: [] });
    expect(() => BpmnDocumentLayoutAdapter.applyToContext(layout, context)).not.toThrow();
  });

  it('adapts and persists the mutable SimpleBpmnEngine path through the typed model', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-model-'));
    try {
      const engine = new SimpleBpmnEngine(directory);
      const context = await engine.createProcess('Mutable layout');
      const start = await engine.createElement(context.id, { id: 'Start_fixed', type: 'bpmn:StartEvent' });
      const task = await engine.createElement(context.id, { id: 'Task_fixed', type: 'bpmn:Task' });
      const connection = await engine.connect(context.id, start.id, task.id, 'continue');
      const layout = engine.getLayoutModel(context.id);

      layout.nodes.get(task.id)!.bounds = { x: 320, y: 140, width: 130, height: 90 };
      refreshLayoutGeometry(layout);
      setLayoutEdgeWaypoints(layout.edges.get(connection.id)!, [
        { x: 136, y: 218 },
        { x: 220, y: 218 },
        { x: 320, y: 185 }
      ]);
      refreshLayoutGeometry(layout);
      await engine.applyLayoutModel(context.id, layout);

      expect(engine.getProcess(context.id).elements.get(task.id)).toMatchObject({
        position: { x: 320, y: 140 },
        size: { width: 130, height: 90 }
      });
      expect(engine.getProcess(context.id).connections.get(connection.id)?.waypoints)
        .toEqual(layout.edges.get(connection.id)!.waypoints);
      expect(context.document.diagram.edges.get(`${connection.id}_di`)?.waypoints)
        .toEqual(layout.edges.get(connection.id)!.waypoints);
      const persisted = await fs.readFile(join(directory, context.filename!), 'utf8');
      expect(persisted).toContain('x="320" y="140" width="130" height="90"');
      expect(persisted).toContain('<di:waypoint x="220" y="218" />');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves one semantic edge identity across ordered virtual routing segments', () => {
    const layout = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    const edge = layout.edges.get('flow-a')!;
    const middle = { x: 180, y: 180 };
    edge.waypoints = [edge.waypoints[0], middle, edge.waypoints[edge.waypoints.length - 1]];
    edge.segments = [
      {
        id: 'flow-a:segment:0',
        semanticEdgeId: 'flow-a',
        order: 0,
        source: { ...edge.source },
        target: { nodeId: 'virtual:flow-a:0' },
        waypoints: [edge.waypoints[0], middle],
        virtual: true
      },
      {
        id: 'flow-a:segment:1',
        semanticEdgeId: 'flow-a',
        order: 1,
        source: { nodeId: 'virtual:flow-a:0' },
        target: { ...edge.target },
        waypoints: [middle, edge.waypoints[edge.waypoints.length - 1]],
        virtual: true
      }
    ];

    expect(validateLayoutModel(layout)).toEqual({ valid: true, errors: [] });
    expect(normalizeLayoutModel(layout).edges.find(item => item.id === edge.id)?.segments
      .map(segment => segment.semanticEdgeId)).toEqual(['flow-a', 'flow-a']);

    edge.segments[1].waypoints[0] = { x: middle.x + 1, y: middle.y };
    expect(validateLayoutModel(layout).errors.map(error => error.code))
      .toContain('disconnected-edge-segments');
  });

  it('rejects undocked routes, incomplete ports, stale bounds and nonreciprocal containment', () => {
    const undocked = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    const edge = undocked.edges.get('flow-a')!;
    setLayoutEdgeWaypoints(edge, [
      { x: edge.waypoints[0].x + 1, y: edge.waypoints[0].y },
      edge.waypoints[edge.waypoints.length - 1]
    ]);
    refreshLayoutGeometry(undocked);
    expect(validateLayoutModel(undocked).errors.map(error => error.code)).toContain('undocked-edge-route');

    const missingPort = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    missingPort.nodes.get('task')!.ports = missingPort.nodes.get('task')!.ports
      .filter(port => port.role !== 'incoming');
    expect(validateLayoutModel(missingPort).errors.map(error => error.code)).toContain('invalid-node-port-set');

    const staleBounds = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    staleBounds.bounds.x += 1;
    expect(validateLayoutModel(staleBounds).errors.map(error => error.code)).toContain('stale-diagram-bounds');

    const containment = MermaidAstLayoutAdapter.toLayoutModel(mermaidAst());
    containment.containers.get('pool')!.nodeIds = ['start', 'task'];
    expect(validateLayoutModel(containment).errors.map(error => error.code))
      .toContain('nonreciprocal-node-container');
  });

  it('rejects an explicit Mermaid layout that changes edge connectivity', async () => {
    const ast = mermaidAst();
    const layout = MermaidAstLayoutAdapter.toLayoutModel(ast);
    const edge = layout.edges.get('flow-a')!;
    edge.target = { nodeId: 'end', portId: 'end:port:in' };
    const sourcePort = layout.nodes.get('start')!.ports.find(port => port.role === 'outgoing')!;
    const targetPort = layout.nodes.get('end')!.ports.find(port => port.role === 'incoming')!;
    setLayoutEdgeWaypoints(edge, [sourcePort.position, targetPort.position]);
    refreshLayoutGeometry(layout);

    await expect(new SimpleBpmnGenerator().generateBpmn(ast, 'Contradictory route', layout))
      .rejects.toThrow('does not preserve Mermaid edge flow-a');
  });

  it('rejects non-finite geometry and semantic metadata drift before mutation', () => {
    const context = createProcessContext('Process_1', 'Preflight', 'process');
    context.elements.set('Task_1', {
      kind: 'flowNode',
      id: 'Task_1',
      type: 'bpmn:Task',
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      position: { x: 10, y: 20 },
      size: { width: 100, height: 80 },
      properties: {}
    });
    const invalidGeometry = BpmnDocumentLayoutAdapter.fromContext(context);
    invalidGeometry.nodes.get('Task_1')!.bounds.x = Number.NaN;
    expect(() => BpmnDocumentLayoutAdapter.applyToContext(invalidGeometry, context))
      .toThrow('invalid bounds');
    expect(context.elements.get('Task_1')!.position).toEqual({ x: 10, y: 20 });

    const semanticDrift = BpmnDocumentLayoutAdapter.fromContext(context);
    semanticDrift.nodes.get('Task_1')!.semanticType = 'bpmn:ServiceTask';
    expect(() => BpmnDocumentLayoutAdapter.applyToContext(semanticDrift, context))
      .toThrow('changes BPMN semantic metadata');
    expect(context.elements.get('Task_1')!.type).toBe('bpmn:Task');
  });

  it('rejects a layout that changes BPMN semantic connectivity', () => {
    const context = createProcessContext('Process_1', 'Connectivity', 'process');
    for (const id of ['A', 'B', 'C']) {
      context.elements.set(id, {
        kind: 'flowNode',
        id,
        type: 'bpmn:Task',
        ownerId: 'Process_1',
        scopeId: 'Process_1',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 80 },
        properties: {}
      });
    }
    context.connections.set('Flow_1', {
      id: 'Flow_1',
      type: 'bpmn:SequenceFlow',
      source: 'A',
      target: 'B',
      ownerId: 'Process_1',
      scopeId: 'Process_1',
      waypoints: [{ x: 100, y: 40 }, { x: 150, y: 40 }],
      properties: {}
    });
    const layout = BpmnDocumentLayoutAdapter.fromContext(context);
    layout.nodes.get('A')!.bounds.x = 400;
    refreshLayoutGeometry(layout);
    layout.edges.get('Flow_1')!.target.nodeId = 'C';
    layout.edges.get('Flow_1')!.target.portId = 'C:port:in';
    setLayoutEdgeWaypoints(layout.edges.get('Flow_1')!, [
      { x: 500, y: 40 },
      { x: 0, y: 40 }
    ]);
    refreshLayoutGeometry(layout);

    expect(() => BpmnDocumentLayoutAdapter.applyToContext(layout, context))
      .toThrow('changes semantic connectivity');
    expect(context.connections.get('Flow_1')!.target).toBe('B');
    expect(context.elements.get('A')!.position.x).toBe(0);
  });

  it('restores in-memory geometry when layout persistence fails', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-rollback-'));
    const directory = join(root, 'diagrams');
    try {
      const engine = new SimpleBpmnEngine(directory);
      const context = await engine.createProcess('Rollback');
      const task = await engine.createElement(context.id, { id: 'Task_fixed', type: 'bpmn:Task' });
      const originalX = task.position.x;
      const layout = engine.getLayoutModel(context.id);
      layout.nodes.get(task.id)!.bounds.x = 999;
      refreshLayoutGeometry(layout);
      await fs.rm(directory, { recursive: true, force: true });
      await fs.writeFile(directory, 'blocks directory recreation', 'utf8');

      await expect(engine.applyLayoutModel(context.id, layout)).rejects.toThrow();
      expect(context.elements.get(task.id)!.position.x).toBe(originalX);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
