import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import { tools } from '../../src/server/tools.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

type ToolContract = {
  owner: 'engine' | 'handler' | 'converter-and-engine';
  caseId: string;
};

// This inventory is deliberately exhaustive. Adding or removing an advertised
// tool requires an explicit ownership decision and a corresponding contract.
const TOOL_CONTRACTS: Record<string, ToolContract> = {
  new_bpmn: { owner: 'engine', caseId: 'C1' },
  new_from_mermaid: { owner: 'converter-and-engine', caseId: 'C7' },
  // Converter-only: the preview never reaches the engine or the file system.
  preview_mermaid: { owner: 'handler', caseId: 'C7' },
  open_bpmn: { owner: 'engine', caseId: 'C5' },
  open_mermaid_file: { owner: 'converter-and-engine', caseId: 'C7' },
  save: { owner: 'handler', caseId: 'C6' },
  save_as: { owner: 'handler', caseId: 'C6' },
  close: { owner: 'handler', caseId: 'C6' },
  current: { owner: 'handler', caseId: 'C6' },
  add_event: { owner: 'engine', caseId: 'C2' },
  add_activity: { owner: 'engine', caseId: 'C2' },
  add_gateway: { owner: 'engine', caseId: 'C6' },
  add_data_object: { owner: 'engine', caseId: 'C6' },
  add_text_annotation: { owner: 'engine', caseId: 'C2' },
  connect: { owner: 'engine', caseId: 'C2' },
  add_association: { owner: 'engine', caseId: 'C2' },
  add_pool: { owner: 'engine', caseId: 'C8' },
  add_lane: { owner: 'engine', caseId: 'G1' },
  list_elements: { owner: 'handler', caseId: 'C6' },
  get_element: { owner: 'handler', caseId: 'C6' },
  list_connections: { owner: 'handler', caseId: 'C6' },
  get_connection: { owner: 'handler', caseId: 'C6' },
  update_element: { owner: 'engine', caseId: 'C4' },
  update_connection: { owner: 'engine', caseId: 'C4' },
  update_element_geometry: { owner: 'engine', caseId: 'C4' },
  update_connection_geometry: { owner: 'engine', caseId: 'C4' },
  apply_geometry_patch: { owner: 'engine', caseId: 'C4' },
  route_connection: { owner: 'engine', caseId: 'C4' },
  delete_element: { owner: 'engine', caseId: 'C4' },
  export: { owner: 'engine', caseId: 'C2/G2' },
  save_svg: { owner: 'handler', caseId: 'G2' },
  save_png: { owner: 'handler', caseId: 'G2' },
  validate: { owner: 'handler', caseId: 'C6/G5' },
  analyze_geometry: { owner: 'handler', caseId: 'C6' },
  auto_layout: { owner: 'engine', caseId: 'C4/C6/G4' },
  build_process: { owner: 'engine', caseId: 'C1/C2' },
  list_diagrams: { owner: 'engine', caseId: 'C5' },
  delete_diagram_file: { owner: 'engine', caseId: 'C5' },
  get_diagrams_path: { owner: 'engine', caseId: 'C5' },
  get_workspace: { owner: 'handler', caseId: 'C6' },
  select_workspace: { owner: 'handler', caseId: 'C6' }
};

const fixtureDirectory = join(process.cwd(), 'tests', 'fixtures', 'engine-contract');

function textOf(result: Awaited<ReturnType<BpmnRequestHandler['handleRequest']>>): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}

function elementById(definitions: any, id: string): any {
  const visit = (container: any): any => {
    for (const element of [...(container.flowElements || []), ...(container.artifacts || [])]) {
      if (element.id === id) return element;
      const nested = visit(element);
      if (nested) return nested;
    }
    return undefined;
  };

  for (const root of definitions.rootElements || []) {
    if (root.id === id) return root;
    for (const participant of root.participants || []) {
      if (participant.id === id) return participant;
    }
    for (const messageFlow of root.messageFlows || []) {
      if (messageFlow.id === id) return messageFlow;
    }
    const nested = visit(root);
    if (nested) return nested;
  }
  return undefined;
}

describe('live engine contract', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;
  const moddle = new BpmnModdle();

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-engine-contract-'));
    IdGenerator.reset();
    diagramContext.clear();
    engine = new SimpleBpmnEngine(directory);
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('C0 assigns every advertised tool to an engine contract or handler-only responsibility', () => {
    expect(Object.keys(TOOL_CONTRACTS).sort()).toEqual(tools.map(tool => tool.name).sort());
  });

  it('C1 creates typed process and collaboration roots', async () => {
    const process = await engine.createProcess('Order & Review <priority>', 'process');
    const processDefinitions = (await moddle.fromXML(await engine.exportXml(process.id))).rootElement;
    const processRoot = elementById(processDefinitions, process.id);

    expect(processRoot.$type).toBe('bpmn:Process');
    expect(processRoot.name).toBe('Order & Review <priority>');
    expect(processDefinitions.diagrams[0].plane.bpmnElement).toBe(processRoot);

    const collaboration = await engine.createProcess('Buyer "and" Seller', 'collaboration');
    const collaborationDefinitions = (
      await moddle.fromXML(await engine.exportXml(collaboration.id))
    ).rootElement;
    const collaborationRoot = elementById(collaborationDefinitions, collaboration.id);

    expect(collaborationRoot.$type).toBe('bpmn:Collaboration');
    expect(collaborationRoot.name).toBe('Buyer "and" Seller');
    expect(collaborationDefinitions.diagrams[0].plane.bpmnElement).toBe(collaborationRoot);
  });

  it('C2 preserves semantic types, refs, special characters, labels, and DI on export', async () => {
    const context = await engine.createProcess('Typed process');
    const start = await engine.createElement(context.id, {
      id: 'Start_Contract',
      type: 'bpmn:StartEvent',
      name: 'Start & wait',
      position: { x: 80, y: 120 }
    });
    const task = await engine.createElement(context.id, {
      id: 'Task_Contract',
      type: 'bpmn:UserTask',
      name: 'Review <request> "now"',
      position: { x: 220, y: 100 }
    });
    const flow = await engine.connect(
      context.id,
      start.id,
      task.id,
      'approved & ready <next>'
    );
    const annotation = await engine.createElement(context.id, {
      id: 'Annotation_Contract',
      type: 'bpmn:TextAnnotation',
      properties: { text: 'Explain decision' },
      position: { x: 400, y: 220 }
    });
    const association = await engine.addAssociation(context.id, annotation.id, task.id, 'One');

    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const root = elementById(definitions, context.id);
    const parsedStart = elementById(definitions, start.id);
    const parsedTask = elementById(definitions, task.id);
    const parsedFlow = elementById(definitions, flow.id);
    const parsedAssociation = elementById(definitions, association.id);
    const plane = definitions.diagrams[0].plane;
    const startShape = plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNShape' && item.bpmnElement === parsedStart
    );
    const parsedEdge = plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNEdge' && item.bpmnElement === parsedFlow
    );
    const associationEdge = plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNEdge' && item.bpmnElement === parsedAssociation
    );

    expect(root.$type).toBe('bpmn:Process');
    expect(parsedStart.$type).toBe('bpmn:StartEvent');
    expect(parsedStart.name).toBe('Start & wait');
    expect(parsedTask.$type).toBe('bpmn:UserTask');
    expect(parsedTask.name).toBe('Review <request> "now"');
    expect(parsedFlow.$type).toBe('bpmn:SequenceFlow');
    expect(parsedFlow.name).toBe('approved & ready <next>');
    expect(parsedFlow.sourceRef).toBe(parsedStart);
    expect(parsedFlow.targetRef).toBe(parsedTask);
    expect(startShape.bounds).toMatchObject({ x: 80, y: 120, width: 36, height: 36 });
    expect(parsedEdge.waypoint).toHaveLength(2);
    expect(parsedAssociation).toMatchObject({
      $type: 'bpmn:Association',
      associationDirection: 'One'
    });
    expect(parsedAssociation.sourceRef.id).toBe(annotation.id);
    expect(parsedAssociation.targetRef).toBe(parsedTask);
    expect(associationEdge.waypoint).toHaveLength(2);
  });

  it('C2 honors compact export without changing BPMN semantics', async () => {
    const context = await engine.createProcess('Formatting contract');
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      name: 'Start'
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Review'
    });
    const flow = await engine.connect(context.id, start.id, task.id, 'continue');

    const formatted = await engine.exportXml(context.id);
    const compact = await engine.exportXml(context.id, false);
    const formattedDefinitions = (await moddle.fromXML(formatted)).rootElement;
    const compactDefinitions = (await moddle.fromXML(compact)).rootElement;
    const compactFlow = elementById(compactDefinitions, flow.id);

    expect((formatted.match(/\n/g) || []).length).toBeGreaterThan(1);
    expect(compact.match(/\n/g) || []).toHaveLength(1);
    expect(elementById(compactDefinitions, context.id).$type).toBe(
      elementById(formattedDefinitions, context.id).$type
    );
    expect(compactFlow.name).toBe('continue');
    expect(compactFlow.sourceRef.id).toBe(start.id);
    expect(compactFlow.targetRef.id).toBe(task.id);
  });

  it('C3 imports hierarchy, labels, and DI from the extension-bearing fixture', async () => {
    const xml = await fs.readFile(
      join(fixtureDirectory, 'hierarchy-extensions-labels-di.bpmn'),
      'utf8'
    );
    const context = await engine.importXml(xml);

    expect(context.elements.get('SubProcess_ContractFixture')).toMatchObject({
      type: 'bpmn:SubProcess',
      ownerId: 'Process_ContractFixture',
      scopeId: 'Process_ContractFixture'
    });
    expect(context.elements.get('Task_Nested')).toMatchObject({
      type: 'bpmn:Task',
      ownerId: 'Process_ContractFixture',
      scopeId: 'SubProcess_ContractFixture',
      position: { x: 280, y: 130 }
    });

    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const start = elementById(definitions, 'Start_ContractFixture');
    const subprocess = elementById(definitions, 'SubProcess_ContractFixture');
    const flow = elementById(definitions, 'Flow_ToSubProcess');
    const edge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNEdge' && item.bpmnElement === flow
    );

    expect(subprocess.$type).toBe('bpmn:SubProcess');
    expect(elementById(definitions, 'Task_Nested').$type).toBe('bpmn:Task');
    expect(flow.name).toBe('enter & inspect');
    expect(flow.sourceRef).toBe(start);
    expect(flow.targetRef).toBe(subprocess);
    expect(edge.waypoint.map((point: any) => ({ x: point.x, y: point.y }))).toEqual([
      { x: 116, y: 160 },
      { x: 180, y: 160 }
    ]);
  });

  it('C4 updates and deletes model state, then lays out the remaining graph', async () => {
    const context = await engine.createProcess('Mutation contract');
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      name: 'Start',
      position: { x: 500, y: 500 }
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Before',
      position: { x: 700, y: 500 }
    });
    const end = await engine.createElement(context.id, {
      type: 'bpmn:EndEvent',
      name: 'End',
      position: { x: 900, y: 500 }
    });
    await engine.connect(context.id, start.id, task.id, 'to task');
    await engine.connect(context.id, task.id, end.id, 'to end');

    await engine.updateElement(context.id, task.id, { name: 'After & checked' });
    expect(context.elements.get(task.id)?.name).toBe('After & checked');
    expect(await engine.deleteElement(context.id, task.id))
      .toMatchObject({ removedConnectionCount: 2, removedElementIds: [task.id] });
    expect(context.connections.size).toBe(0);

    await engine.connect(context.id, start.id, end.id, 'direct');
    await engine.applyAutoLayout(context.id);
    expect(context.elements.get(start.id)?.position.x).toBeLessThan(
      context.elements.get(end.id)!.position.x
    );

    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    expect(elementById(definitions, task.id)).toBeUndefined();
    expect(elementById(definitions, end.id).$type).toBe('bpmn:EndEvent');
  });

  it('C5 persists, lists, reloads, and deletes BPMN files inside the configured directory', async () => {
    const context = await engine.createProcess('Persistence contract');
    const diagrams = await engine.listDiagrams();
    const saved = diagrams.find(diagram => diagram.processId === context.id);

    expect(saved).toBeDefined();
    expect(engine.getDiagramsPath()).toBe(directory);

    engine.clear();
    const loaded = await engine.loadDiagram(saved!.filename);
    expect(loaded.id).toBe(context.id);
    expect(loaded.name).toBe('Persistence contract');

    await engine.deleteDiagram(saved!.filename);
    expect((await engine.listDiagrams()).some(diagram => diagram.filename === saved!.filename)).toBe(false);
  });

  it('C6 exposes mutation, query, validation, layout, export, and context behavior through handlers', async () => {
    const handler = new BpmnRequestHandler(engine);
    await handler.handleRequest('new_bpmn', { name: 'Handler contract' });
    await handler.handleRequest('add_event', { eventType: 'start', name: 'Start' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Work' });
    await handler.handleRequest('add_gateway', { gatewayType: 'exclusive', name: 'Decision' });
    await handler.handleRequest('add_data_object', { name: 'Handler data' });
    await handler.handleRequest('add_event', { eventType: 'end', name: 'End' });
    await handler.handleRequest('connect', { sourceId: 'StartEvent_1', targetId: 'Task_1' });
    await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'ExclusiveGateway_1' });
    await handler.handleRequest('connect', { sourceId: 'ExclusiveGateway_1', targetId: 'EndEvent_1' });

    const listed = JSON.parse(textOf(await handler.handleRequest('list_elements', {})));
    expect(listed.elements.map((element: any) => element.type)).toEqual([
      'bpmn:DataObjectReference',
      'bpmn:EndEvent',
      'bpmn:ExclusiveGateway',
      'bpmn:StartEvent',
      'bpmn:Task'
    ]);
    const connections = JSON.parse(textOf(await handler.handleRequest('list_connections', {})));
    expect(connections.connections).toHaveLength(3);
    expect(JSON.parse(textOf(await handler.handleRequest('get_connection', {
      connectionId: connections.connections[0].id
    })))).toMatchObject(connections.connections[0]);

    await handler.handleRequest('update_element', {
      elementId: 'Task_1',
      name: 'Updated work'
    });
    expect(JSON.parse(textOf(await handler.handleRequest('get_element', {
      elementId: 'Task_1'
    }))).name).toBe('Updated work');

    const validation = JSON.parse(textOf(await handler.handleRequest('validate', { level: 'full' })));
    expect(validation.valid).toBe(true);
    expect((await handler.handleRequest('auto_layout', { algorithm: 'horizontal' })).isError).toBeUndefined();

    const exported = textOf(await handler.handleRequest('export', { format: 'xml' }));
    expect((await moddle.fromXML(exported)).rootElement.$type).toBe('bpmn:Definitions');

    expect(textOf(await handler.handleRequest('current', {}))).toContain('Handler contract');
    expect(textOf(await handler.handleRequest('delete_element', { elementId: 'Task_1' }))).toContain(
      'associated connections'
    );
    expect(textOf(await handler.handleRequest('close', {}))).toContain('Closed diagram');
    expect(textOf(await handler.handleRequest('current', {}))).toBe('No current diagram');
  });

  it('C7 converts Mermaid text and files before importing through the live engine', async () => {
    const handler = new BpmnRequestHandler(engine);
    const mermaid = 'graph TD\n  Start((Start)) --> Finish((End))';
    const created = await handler.handleRequest('new_from_mermaid', {
      name: 'Inline Mermaid',
      mermaidCode: mermaid
    });
    expect(created.isError).toBeUndefined();

    await fs.writeFile(join(directory, 'contract.mmd'), mermaid, 'utf8');
    const opened = await handler.handleRequest('open_mermaid_file', { filename: 'contract.mmd' });
    expect(opened.isError).toBeUndefined();
    expect(textOf(opened)).toContain('2 nodes, 1 flows');
  });

  it('C8 creates white-box and black-box pool refs with typed collaboration DI', async () => {
    const handler = new BpmnRequestHandler(engine);
    await handler.handleRequest('new_bpmn', { name: 'Pool contract', type: 'collaboration' });
    await handler.handleRequest('add_pool', { name: 'Buyer & requester' });
    await handler.handleRequest('add_pool', { name: 'External seller', blackBox: true });

    const context = diagramContext.getCurrent();
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const collaboration = elementById(definitions, context.id);
    const buyer = collaboration.participants.find((participant: any) => participant.name === 'Buyer & requester');
    const seller = collaboration.participants.find((participant: any) => participant.name === 'External seller');
    const buyerShape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNShape' && item.bpmnElement === buyer
    );

    expect(buyer.$type).toBe('bpmn:Participant');
    expect(buyer.processRef.$type).toBe('bpmn:Process');
    expect(seller.processRef).toBeUndefined();
    expect(buyerShape.bpmnElement).toBe(buyer);
  });

  it('rejects malformed BPMN XML instead of installing partial state', async () => {
    const xml = await fs.readFile(join(fixtureDirectory, 'malformed.bpmn'), 'utf8');
    await expect(engine.importXml(xml)).rejects.toThrow('Failed to parse BPMN XML');
  });

  it('G6 lists exact BPMN metadata from versioned and legacy generated filenames', async () => {
    const context = await engine.createProcess('Customer intake_review');
    const generatedFilename = context.filename!;

    expect(context.id).toBe('Process_1');
    expect(generatedFilename).toMatch(/^mcp-bpmn-v1_[A-Za-z0-9_-]+\.bpmn$/);
    await expect(engine.listDiagrams()).resolves.toContainEqual({
      filename: generatedFilename,
      path: join(directory, generatedFilename),
      processId: 'Process_1',
      name: 'Customer intake_review'
    });

    const legacyFilename = 'Process_1_Customer_intake_review.bpmn';
    await fs.writeFile(
      join(directory, legacyFilename),
      await fs.readFile(join(directory, generatedFilename), 'utf8'),
      'utf8'
    );
    await fs.unlink(join(directory, generatedFilename));
    engine.clear();
    await expect(engine.listDiagrams()).resolves.toContainEqual({
      filename: legacyFilename,
      path: join(directory, legacyFilename),
      processId: 'Process_1',
      name: 'Customer intake_review'
    });

    await fs.writeFile(join(directory, 'legacy-unreadable.bpmn'), 'not BPMN XML', 'utf8');
    await expect(engine.listDiagrams()).resolves.toContainEqual({
      filename: 'legacy-unreadable.bpmn',
      path: join(directory, 'legacy-unreadable.bpmn'),
      processId: 'legacy-unreadable',
      name: 'legacy-unreadable'
    });

    const longName = `Long name_${'x'.repeat(300)}`;
    const longNameContext = await engine.createProcess(longName);
    expect(Buffer.byteLength(longNameContext.filename!, 'utf8')).toBeLessThanOrEqual(255);
    await expect(engine.listDiagrams()).resolves.toContainEqual({
      filename: longNameContext.filename,
      path: join(directory, longNameContext.filename!),
      processId: longNameContext.id,
      name: longName
    });
  });

  it('G1 add_lane creates BPMN Lane/LaneSet semantics through the handler', async () => {
    const handler = new BpmnRequestHandler(engine);
    await handler.handleRequest('new_bpmn', {
      name: 'Lane contract',
      type: 'collaboration'
    });
    await handler.handleRequest('add_pool', { name: 'Operations' });
    await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Review',
      ownerId: 'Participant_1_Process'
    });

    const result = await handler.handleRequest('add_lane', {
      poolId: 'Participant_1',
      name: 'Reviewers',
      flowNodeIds: ['Task_1']
    });
    expect(result.isError).toBeUndefined();

    const definitions = (
      await moddle.fromXML(textOf(await handler.handleRequest('export', { format: 'xml' })))
    ).rootElement;
    const process = elementById(definitions, 'Participant_1_Process');
    const lane = process.laneSets[0].lanes[0];
    const laneShape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNShape' && item.bpmnElement === lane
    );

    expect(process.laneSets).toHaveLength(1);
    expect(process.laneSets[0]).toMatchObject({ $type: 'bpmn:LaneSet' });
    expect(lane).toMatchObject({ $type: 'bpmn:Lane', id: 'Lane_1', name: 'Reviewers' });
    expect(lane.flowNodeRef.map((node: any) => node.id)).toEqual(['Task_1']);
    expect(laneShape).toBeDefined();
  });

  it('G3 preserves imported extensionElements through mutation and export', async () => {
    const xml = await fs.readFile(
      join(fixtureDirectory, 'hierarchy-extensions-labels-di.bpmn'),
      'utf8'
    );
    const context = await engine.importXml(xml);
    await engine.updateElement(context.id, 'Task_Nested', { name: 'Mutated nested task' });

    const parsed = await moddle.fromXML(await engine.exportXml(context.id));
    expect(parsed.elementsById.Process_ContractFixture.extensionElements.values[0])
      .toMatchObject({ $type: 'contract:metadata', key: 'must-round-trip' });
    expect(parsed.elementsById.Task_Nested).toMatchObject({ name: 'Mutated nested task' });
    expect(parsed.elementsById.Task_Nested.extensionElements.values[0])
      .toMatchObject({ $type: 'contract:metadata', key: 'nested-extension' });
  });

  it('G4 advertises only executable auto-layout algorithms', async () => {
    const autoLayoutTool = tools.find(tool => tool.name === 'auto_layout');
    const algorithms = (autoLayoutTool?.inputSchema as {
      properties?: { algorithm?: { enum?: string[] } };
    }).properties?.algorithm?.enum;
    expect(algorithms).toEqual(['horizontal']);

    const handler = new BpmnRequestHandler(engine);
    await handler.handleRequest('new_bpmn', { name: 'Layout contract' });
    await handler.handleRequest('add_event', { eventType: 'start' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Work' });
    await handler.handleRequest('add_event', { eventType: 'end' });
    await handler.handleRequest('connect', {
      sourceId: 'StartEvent_1',
      targetId: 'Task_1'
    });
    await handler.handleRequest('connect', {
      sourceId: 'Task_1',
      targetId: 'EndEvent_1'
    });

    for (const algorithm of algorithms ?? []) {
      const result = await handler.handleRequest('auto_layout', { algorithm });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ algorithm, changed: true });
      expect(textOf(result)).toContain('Applied left-to-right auto-layout');
    }

    // Both reading directions are advertised and each commits a real layout
    // when it differs from what is already on the diagram.
    for (const direction of ['top-to-bottom', 'left-to-right', 'top-to-bottom'] as const) {
      const result = await handler.handleRequest('auto_layout', { direction });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ direction, changed: true });
    }

    // Re-running the same direction is a no-op that neither commits nor bumps
    // the revision (mcp-bpmn-3g8.13).
    const repeated = await handler.handleRequest('auto_layout', { direction: 'top-to-bottom' });
    expect(repeated.structuredContent).toMatchObject({ changed: false });
    expect((repeated.structuredContent as { beforeRevision: string; afterRevision: string })
      .beforeRevision)
      .toBe((repeated.structuredContent as { afterRevision: string }).afterRevision);

    const unsupportedDirection = await handler.handleRequest('auto_layout', {
      direction: 'diagonal'
    });
    expect(unsupportedDirection.isError).toBe(true);

    const unsupported = await handler.handleRequest('auto_layout', { algorithm: 'vertical' });
    expect(unsupported.isError).toBe(true);
    expect(textOf(unsupported)).toContain('algorithm: Invalid enum value');
    expect(textOf(unsupported)).not.toContain('Only horizontal layout algorithm');
  });

  it('G5 applies validation levels and serializes sequence-flow conditions', async () => {
    const handler = new BpmnRequestHandler(engine);
    await handler.handleRequest('new_bpmn', { name: 'Validation contract' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Decision' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Approved' });
    const condition = '${approved = true && amount < 100}';
    await handler.handleRequest('connect', {
      sourceId: 'Task_1',
      targetId: 'Task_2',
      condition,
      conditionLanguage: 'FEEL'
    });

    const syntax = JSON.parse(textOf(await handler.handleRequest('validate', {
      level: 'syntax'
    })));
    const semantic = JSON.parse(textOf(await handler.handleRequest('validate', {
      level: 'semantic'
    })));
    const full = JSON.parse(textOf(await handler.handleRequest('validate', { level: 'full' })));

    expect(syntax).toMatchObject({ level: 'syntax', issues: [] });
    expect(semantic.level).toBe('semantic');
    expect(semantic.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BPMN_PROFILE_MISSING_START_EVENT' })
    ]));
    expect(full.level).toBe('full');
    expect(full.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BPMN_PROFILE_MISSING_START_EVENT' }),
      expect.objectContaining({ code: 'BPMN_PROFILE_MISSING_END_EVENT' })
    ]));

    const exported = textOf(await handler.handleRequest('export', { format: 'xml' }));
    const parsed = await moddle.fromXML(exported);
    const flow = Object.values(parsed.elementsById).find(
      (element: any) => element.$type === 'bpmn:SequenceFlow'
    ) as any;
    expect(flow.conditionExpression).toMatchObject({
      $type: 'bpmn:FormalExpression',
      body: condition,
      language: 'FEEL'
    });
  });
});
