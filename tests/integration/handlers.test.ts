import type { BpmnRequestHandler } from '../../src/server/handlers.js';
import type { FileManager } from '../../src/utils/FileManager.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdGenerator } from '../../src/utils/IdGenerator.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import BpmnModdle from 'bpmn-moddle';
import {
  createTempDiagramsSandbox,
  snapshotDefaultDiagramsDirectory,
  type TempHandlerSandbox
} from '../helpers/tempDiagrams.js';

async function normalizedSemanticXml(xml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(xml);
  parsed.rootElement.diagrams = [];
  return (await moddle.toXML(parsed.rootElement, { format: true })).xml;
}

describe('BpmnRequestHandler Integration Tests', () => {
  let handler: BpmnRequestHandler;
  let sandbox: TempHandlerSandbox | undefined;
  let defaultDiagramsSnapshot: string;

  beforeAll(async () => {
    defaultDiagramsSnapshot = await snapshotDefaultDiagramsDirectory();
  });

  beforeEach(async () => {
    IdGenerator.reset();
    diagramContext.clear();
    sandbox = await createTempDiagramsSandbox('handlers');
    handler = sandbox.handler;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    diagramContext.clear();
    await sandbox?.cleanup();
    sandbox = undefined;
  });

  afterAll(async () => {
    expect(await snapshotDefaultDiagramsDirectory()).toBe(defaultDiagramsSnapshot);
  });

  describe('Creation operations', () => {
    it('should report that no diagram is active initially', async () => {
      const result = await handler.handleRequest('current', {});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('No current diagram');
      expect(diagramContext.hasCurrent()).toBe(false);
    });

    it('should create a process successfully', async () => {
      const result = await handler.handleRequest('new_bpmn', {
        name: 'Test Process'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(
        'Created new process diagram "Test Process"\nExtension profile: portable'
      );
      expect(diagramContext.getCurrentInfo()).toMatchObject({
        name: 'Test Process',
        type: 'process'
      });
      expect(diagramContext.getCurrent().xml).toContain('<bpmn:process');
    });

    it('should create a collaboration', async () => {
      const result = await handler.handleRequest('new_bpmn', {
        name: 'Test Collaboration',
        type: 'collaboration'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        'Created new collaboration diagram "Test Collaboration"\nExtension profile: portable'
      );
      expect(diagramContext.getCurrentInfo()).toMatchObject({
        name: 'Test Collaboration',
        type: 'collaboration'
      });
      expect(diagramContext.getCurrent().xml).toContain('<bpmn:collaboration');
    });

    it('should create a diagram from Mermaid and activate the converted state', async () => {
      const result = await handler.handleRequest('new_from_mermaid', {
        name: 'Mermaid Test',
        mermaidCode: 'graph TD\n  A[Start] --> B[End]'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(
        'Created new BPMN diagram "Mermaid Test" from Mermaid'
      );
      expect(result.content[0].text).toContain('2 nodes, 1 flows');
      expect(diagramContext.getCurrentInfo()?.name).toBe('Mermaid Test');
      expect(diagramContext.getCurrent().elements.size).toBe(2);
      expect(diagramContext.getCurrent().connections.size).toBe(1);
      expect(diagramContext.getCurrent().xml).toContain('<bpmn:sequenceFlow');
    });

    it.each([
      ['empty input', '', 'Invalid arguments for tool "new_from_mermaid"'],
      ['comments-only input', '%% no diagram here', 'Failed to parse Mermaid diagram'],
      ['wholly unrecognized input', 'nonsense', 'Failed to parse Mermaid diagram']
    ])('should reject %s without replacing the active diagram or writing a file', async (
      _name,
      mermaidCode,
      expectedError
    ) => {
      await handler.handleRequest('new_bpmn', { name: 'Keep active' });
      const activeContext = diagramContext.getCurrent();
      const activeInfo = diagramContext.getCurrentInfo();
      const filenamesBefore = await readdir(sandbox!.directory);
      const contentsBefore = await Promise.all(filenamesBefore.map(
        filename => readFile(join(sandbox!.directory, filename), 'utf8')
      ));

      const result = await handler.handleRequest('new_from_mermaid', {
        name: 'Rejected Mermaid',
        mermaidCode
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(expectedError);
      expect(diagramContext.getCurrent()).toBe(activeContext);
      expect(diagramContext.getCurrentInfo()).toEqual(activeInfo);
      const filenamesAfter = await readdir(sandbox!.directory);
      expect(filenamesAfter).toEqual(filenamesBefore);
      await expect(Promise.all(filenamesAfter.map(
        filename => readFile(join(sandbox!.directory, filename), 'utf8')
      ))).resolves.toEqual(contentsBefore);
    });

    it('should reject an invalid Mermaid file without replacing active state or creating output', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Keep file active' });
      const activeContext = diagramContext.getCurrent();
      const sourceFilename = sandbox!.uniqueFilename('invalid-mermaid').replace(/\.bpmn$/, '.mmd');
      await writeFile(join(sandbox!.directory, sourceFilename), '%% comments only', 'utf8');
      const filenamesBefore = await readdir(sandbox!.directory);
      const contentsBefore = await Promise.all(filenamesBefore.map(
        filename => readFile(join(sandbox!.directory, filename), 'utf8')
      ));

      const result = await handler.handleRequest('open_mermaid_file', { filename: sourceFilename });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to parse Mermaid diagram');
      expect(diagramContext.getCurrent()).toBe(activeContext);
      const filenamesAfter = await readdir(sandbox!.directory);
      expect(filenamesAfter).toEqual(filenamesBefore);
      await expect(Promise.all(filenamesAfter.map(
        filename => readFile(join(sandbox!.directory, filename), 'utf8')
      ))).resolves.toEqual(contentsBefore);
    });

    describe('opening files', () => {
      it('should open a valid BPMN file and restore its persisted state', async () => {
        await handler.handleRequest('new_bpmn', { name: 'Open BPMN source' });
        await handler.handleRequest('add_activity', { activityType: 'task', name: 'Persisted task' });
        const source = diagramContext.getCurrent();
        const filename = source.filename;
        if (!filename) throw new Error('Expected a generated BPMN filename');
        const persistedXml = await readFile(join(sandbox!.directory, filename), 'utf8');
        await handler.handleRequest('close', {});

        const result = await handler.handleRequest('open_bpmn', { filename });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain(`Opened BPMN diagram "Open BPMN source" from ${filename}`);
        expect(diagramContext.getCurrentInfo()).toMatchObject({
          name: 'Open BPMN source',
          filename,
          elementCount: 1
        });
        expect(diagramContext.getCurrent().elements.get('Task_1')?.name).toBe('Persisted task');
        await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(persistedXml);
      });

      it('should reject a missing BPMN file without activating a diagram', async () => {
        const filename = sandbox!.uniqueFilename('missing-open');

        const result = await handler.handleRequest('open_bpmn', { filename });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('File not found');
        expect(diagramContext.hasCurrent()).toBe(false);
        expect(await readdir(sandbox!.directory)).toEqual([]);
      });

      it('should reject a BPMN traversal path without reading or activating it', async () => {
        const result = await handler.handleRequest('open_bpmn', { filename: '../outside.bpmn' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid filename');
        expect(diagramContext.hasCurrent()).toBe(false);
        expect(await readdir(sandbox!.directory)).toEqual([]);
      });

      it('should open a valid Mermaid file and persist the converted BPMN state', async () => {
        const filename = sandbox!.uniqueFilename('valid-mermaid').replace(/\.bpmn$/, '.mmd');
        await writeFile(
          join(sandbox!.directory, filename),
          'flowchart TD\n  A[Start] --> B[Finish]',
          'utf8'
        );

        const result = await handler.handleRequest('open_mermaid_file', { filename });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain(`Opened and converted Mermaid file "${filename}"`);
        expect(diagramContext.getCurrentInfo()).toMatchObject({
          name: filename.replace(/\.mmd$/, ''),
          elementCount: 2,
          connectionCount: 1
        });
        const activeFilename = diagramContext.getCurrent().filename;
        if (!activeFilename) throw new Error('Expected converted BPMN filename');
        expect(await readdir(sandbox!.directory)).toEqual(
          expect.arrayContaining([filename, activeFilename])
        );
        await expect(readFile(join(sandbox!.directory, activeFilename), 'utf8'))
          .resolves.toBe(diagramContext.getCurrent().xml);
      });

      it('should reject a missing Mermaid file without activating a diagram', async () => {
        const filename = sandbox!.uniqueFilename('missing-mermaid').replace(/\.bpmn$/, '.mmd');

        const result = await handler.handleRequest('open_mermaid_file', { filename });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('File not found');
        expect(diagramContext.hasCurrent()).toBe(false);
        expect(await readdir(sandbox!.directory)).toEqual([]);
      });

      it('should reject a Mermaid traversal path without reading or activating it', async () => {
        const result = await handler.handleRequest('open_mermaid_file', {
          filename: '../outside.mmd'
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid filename');
        expect(diagramContext.hasCurrent()).toBe(false);
        expect(await readdir(sandbox!.directory)).toEqual([]);
      });
    });
  });

  describe('Element and connection operations', () => {
  describe('pools and lanes', () => {
    it('should add a white-box pool to a collaboration and persist its process', async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Pool collaboration',
        type: 'collaboration'
      });

      const result = await handler.handleRequest('add_pool', {
        name: 'Operations',
        position: { x: 40, y: 60 },
        size: { width: 700, height: 300 }
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added pool "Operations" with ID: Participant_1');
      expect(diagramContext.getCurrent().elements.get('Participant_1')).toMatchObject({
        kind: 'participant',
        name: 'Operations',
        processRef: 'Participant_1_Process',
        position: { x: 40, y: 60 },
        size: { width: 700, height: 300 }
      });
      expect(diagramContext.getCurrent().document.processes.has('Participant_1_Process')).toBe(true);
      const filename = diagramContext.getCurrent().filename!;
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(diagramContext.getCurrent().xml);
    });

    it('should reject adding a pool to a process without changing state or disk', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Not a collaboration' });
      const context = diagramContext.getCurrent();
      const beforeXml = context.xml;
      const filename = context.filename!;

      const result = await handler.handleRequest('add_pool', { name: 'Rejected pool' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Pools exist only in collaborations');
      expect(context.elements.size).toBe(0);
      expect(context.xml).toBe(beforeXml);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(beforeXml);
    });

    it('should add a lane to a white-box pool and persist its assigned flow node', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Lane collaboration', type: 'collaboration' });
      await handler.handleRequest('add_pool', { name: 'Company' });
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Assigned task',
        ownerId: 'Participant_1_Process'
      });

      const result = await handler.handleRequest('add_lane', {
        poolId: 'Participant_1',
        name: 'Operations',
        flowNodeIds: ['Task_1']
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        'Added lane "Operations" with ID: Lane_1; assigned 1 flow node(s)'
      );
      expect(diagramContext.getCurrent().document.lanes.get('Lane_1')).toMatchObject({
        name: 'Operations',
        processId: 'Participant_1_Process',
        flowNodeRefs: ['Task_1']
      });
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.Lane_1.flowNodeRef.map((node: { id: string }) => node.id))
        .toEqual(['Task_1']);
      const filename = diagramContext.getCurrent().filename!;
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(diagramContext.getCurrent().xml);
    });
  });

  describe('add_event', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Event Test Process'
      });
    });

    it('should add a start event', async () => {
      const result = await handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Start Event'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added start event "Start Event" with ID: StartEvent_1');
      expect(diagramContext.getCurrent().elements.get('StartEvent_1')).toMatchObject({
        type: 'bpmn:StartEvent',
        name: 'Start Event'
      });
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.StartEvent_1).toMatchObject({
        $type: 'bpmn:StartEvent',
        name: 'Start Event'
      });
    });

    it('should add an end event', async () => {
      const result = await handler.handleRequest('add_event', {
        eventType: 'end',
        name: 'End Event'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added end event "End Event" with ID: EndEvent_1');
      expect(diagramContext.getCurrent().elements.get('EndEvent_1')).toMatchObject({
        type: 'bpmn:EndEvent',
        name: 'End Event'
      });
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.EndEvent_1).toMatchObject({
        $type: 'bpmn:EndEvent',
        name: 'End Event'
      });
    });

    it('should pass event payloads to schema-aware XML and reject missing required payload', async () => {
      const added = await handler.handleRequest('add_event', {
        eventType: 'intermediate-catch',
        name: 'Wait ten minutes',
        eventDefinition: 'timer',
        eventDefinitionPayload: {
          timer: { type: 'timeDuration', expression: 'PT10M' }
        }
      });
      expect(added.isError).toBeUndefined();

      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.IntermediateCatchEvent_1.eventDefinitions[0].timeDuration.body)
        .toBe('PT10M');
      const details = await handler.handleRequest('get_element', {
        elementId: 'IntermediateCatchEvent_1'
      });
      expect(JSON.parse(details.content[0].text as string).properties).toMatchObject({
        eventDefinition: 'timer',
        eventDefinitionPayload: {
          definitionId: expect.any(String),
          timer: { type: 'timeDuration', expression: 'PT10M' }
        }
      });

      const rejected = await handler.handleRequest('add_event', {
        eventType: 'intermediate-catch',
        eventDefinition: 'conditional'
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain(
        'Conditional event definition requires eventDefinitionPayload.condition'
      );
      expect(diagramContext.getCurrent().elements.size).toBe(1);
    });

    it('should create an attached boundary event with explicit interruption semantics', async () => {
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Monitored work',
        position: { x: 240, y: 180 }
      });
      const added = await handler.handleRequest('add_event', {
        eventType: 'boundary',
        name: 'Escalate',
        eventDefinition: 'escalation',
        eventDefinitionPayload: { reference: { name: 'Needs review' } },
        attachTo: 'Task_1',
        cancelActivity: false
      });

      expect(added.isError).toBeUndefined();
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      const task = parsed.elementsById.Task_1;
      const boundary = parsed.elementsById.BoundaryEvent_1;
      expect(boundary.attachedToRef).toBe(task);
      expect(boundary.cancelActivity).toBe(false);
      const taskBounds = parsed.elementsById.Task_1_di.bounds;
      const boundaryBounds = parsed.elementsById.BoundaryEvent_1_di.bounds;
      expect(boundaryBounds.y + boundaryBounds.height / 2)
        .toBe(taskBounds.y + taskBounds.height);
    });

    it('should error when no context', async () => {
      diagramContext.clear();
      const result = await handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Start'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No diagram is currently open');
      expect(result.structuredContent).toMatchObject({ code: 'no_current_diagram' });
    });
  });

  describe('add_activity', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Activity Test Process',
        extensionProfile: 'camunda7'
      });
    });

    it('should add a task', async () => {
      const result = await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Simple Task'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added task "Simple Task" with ID: Task_1');
      expect(diagramContext.getCurrent().elements.get('Task_1')).toMatchObject({
        type: 'bpmn:Task',
        name: 'Simple Task'
      });
    });

    it('should add a user task with properties', async () => {
      const result = await handler.handleRequest('add_activity', {
        activityType: 'userTask',
        name: 'Review Document',
        properties: {
          assignee: 'john.doe',
          candidateGroups: ['reviewers']
        }
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added userTask "Review Document" with ID: UserTask_1');
      expect(diagramContext.getCurrent().elements.get('UserTask_1')).toMatchObject({
        type: 'bpmn:UserTask',
        name: 'Review Document',
        properties: {
          assignee: 'john.doe',
          candidateGroups: ['reviewers']
        }
      });
    });

    it('should expose a call activity callable reference and reject an invalid QName', async () => {
      const added = await handler.handleRequest('add_activity', {
        activityType: 'callActivity',
        name: 'Invoke shipping',
        properties: { calledElement: 'ShippingProcess' }
      });

      expect(added.isError).toBeUndefined();
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.CallActivity_1).toMatchObject({
        $type: 'bpmn:CallActivity',
        name: 'Invoke shipping',
        calledElement: 'ShippingProcess'
      });
      expect(parsed.elementsById.CallActivity_1_di.bpmnElement)
        .toBe(parsed.elementsById.CallActivity_1);

      const rejected = await handler.handleRequest('add_activity', {
        activityType: 'callActivity',
        name: 'Rejected call',
        properties: { calledElement: 'not a QName' }
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('calledElement must be a valid BPMN QName');
      expect(diagramContext.getCurrent().elements.size).toBe(1);
    });
  });

  describe('add_gateway', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Gateway Test Process'
      });
    });

    it('should add an exclusive gateway', async () => {
      const result = await handler.handleRequest('add_gateway', {
        gatewayType: 'exclusive',
        name: 'Decision Point'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added exclusive gateway "Decision Point" with ID: ExclusiveGateway_1');
      expect(diagramContext.getCurrent().elements.get('ExclusiveGateway_1')).toMatchObject({
        type: 'bpmn:ExclusiveGateway',
        name: 'Decision Point'
      });
    });

    it('should add a parallel gateway', async () => {
      const result = await handler.handleRequest('add_gateway', {
        gatewayType: 'parallel',
        name: 'Fork'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Added parallel gateway "Fork" with ID: ParallelGateway_1');
      expect(diagramContext.getCurrent().elements.get('ParallelGateway_1')).toMatchObject({
        type: 'bpmn:ParallelGateway',
        name: 'Fork'
      });
    });

    it('should serialize a complex gateway with linked DI', async () => {
      const result = await handler.handleRequest('add_gateway', {
        gatewayType: 'complex',
        name: 'Complex merge'
      });

      expect(result.isError).toBeUndefined();
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.ComplexGateway_1.$type).toBe('bpmn:ComplexGateway');
      expect(parsed.elementsById.ComplexGateway_1_di.bpmnElement)
        .toBe(parsed.elementsById.ComplexGateway_1);
      expect(parsed.elementsById.ComplexGateway_1_di.bounds)
        .toMatchObject({ width: 50, height: 50 });
    });
  });

  describe('add_data_object', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', { name: 'Data object process' });
    });

    it('should create a resolved backing object and visible reference with DI', async () => {
      const result = await handler.handleRequest('add_data_object', {
        name: 'Order records',
        position: { x: 220, y: 140 },
        isCollection: true
      });
      const context = diagramContext.getCurrent();
      const parsed = await new BpmnModdle().fromXML(context.xml!);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        'Added data object "Order records" with reference ID: DataObjectReference_1 and backing ID: DataObject_1'
      );
      expect(parsed.elementsById.DataObject_1).toMatchObject({
        $type: 'bpmn:DataObject',
        name: 'Order records',
        isCollection: true
      });
      expect(parsed.elementsById.DataObjectReference_1).toMatchObject({
        $type: 'bpmn:DataObjectReference',
        dataObjectRef: parsed.elementsById.DataObject_1
      });
      expect(parsed.elementsById.DataObjectReference_1_di).toMatchObject({
        $type: 'bpmndi:BPMNShape',
        bpmnElement: parsed.elementsById.DataObjectReference_1,
        bounds: expect.objectContaining({ x: 220, y: 140, width: 36, height: 50 })
      });
    });

    it('should reject an unknown itemSubjectRef without publishing a partial pair', async () => {
      const context = diagramContext.getCurrent();
      const beforeXml = context.xml;

      const result = await handler.handleRequest('add_data_object', {
        name: 'Rejected data',
        itemSubjectRef: 'ItemDefinition_Missing'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'Invalid data object itemSubjectRef: ItemDefinition_Missing'
      );
      expect(context.elements.size).toBe(0);
      expect(context.document.dataObjects.size).toBe(0);
      expect(context.xml).toBe(beforeXml);
    });
  });

  describe('add_text_annotation', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', { name: 'Annotation process' });
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Review request',
        position: { x: 450, y: 180 }
      });
    });

    it('should preserve formatted multiline text and create separate annotation and association DI', async () => {
      const text = '  Explain <decision> & rationale\nKeep "exact" whitespace  ';
      const result = await handler.handleRequest('add_text_annotation', {
        text,
        textFormat: 'text/markdown',
        position: { x: 120, y: 80 },
        size: { width: 260, height: 100 },
        associatedElementId: 'Task_1'
      });
      const context = diagramContext.getCurrent();
      const parsed = await new BpmnModdle().fromXML(context.xml!);
      const annotation = parsed.elementsById.TextAnnotation_1;
      const association = parsed.elementsById.Association_1;

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        'Added text annotation TextAnnotation_1 with association Association_1 to Task_1'
      );
      expect(annotation).toMatchObject({
        $type: 'bpmn:TextAnnotation',
        text,
        textFormat: 'text/markdown'
      });
      expect(parsed.elementsById.TextAnnotation_1_di).toMatchObject({
        bpmnElement: annotation,
        bounds: expect.objectContaining({ x: 120, y: 80, width: 260, height: 100 })
      });
      expect(association).toMatchObject({
        $type: 'bpmn:Association',
        sourceRef: annotation,
        targetRef: parsed.elementsById.Task_1,
        associationDirection: 'None'
      });
      expect(parsed.elementsById.Association_1_di.bpmnElement).toBe(association);
    });

    it('should preserve endpoints when deleting the association and cascade when deleting the annotation', async () => {
      await handler.handleRequest('add_text_annotation', {
        text: 'Delete policy',
        associatedElementId: 'Task_1'
      });

      const deletedAssociation = await handler.handleRequest('delete_element', {
        elementId: 'Association_1'
      });
      expect(deletedAssociation.content[0].text).toBe('Deleted association Association_1');
      expect(diagramContext.getCurrent().elements.has('TextAnnotation_1')).toBe(true);
      expect(diagramContext.getCurrent().elements.has('Task_1')).toBe(true);

      await handler.handleRequest('add_association', {
        sourceId: 'TextAnnotation_1',
        targetId: 'Task_1'
      });
      const deletedAnnotation = await handler.handleRequest('delete_element', {
        elementId: 'TextAnnotation_1'
      });
      expect(deletedAnnotation.content[0].text).toBe(
        'Deleted element TextAnnotation_1 and 1 associated connection'
      );
      expect(diagramContext.getCurrent().elements.has('TextAnnotation_1')).toBe(false);
      expect(diagramContext.getCurrent().elements.has('Task_1')).toBe(true);
      expect(diagramContext.getCurrent().connections.size).toBe(0);
    });

    it('should reject a missing association target without creating an annotation', async () => {
      const context = diagramContext.getCurrent();
      const xmlBefore = context.xml;
      const result = await handler.handleRequest('add_text_annotation', {
        text: 'Must stay absent',
        associatedElementId: 'Task_Missing'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Associated element Task_Missing not found');
      expect(Array.from(context.elements.values()).filter(
        element => element.type === 'bpmn:TextAnnotation'
      )).toHaveLength(0);
      expect(context.connections.size).toBe(0);
      expect(context.xml).toBe(xmlBefore);
    });
  });

  describe('connect', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Connection Test Process'
      });

      // Add elements to connect
      await handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Start'
      });

      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Task'
      });
    });

    it('should connect two elements', async () => {
      const result = await handler.handleRequest('connect', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Connected StartEvent_1 to Task_1');
      expect(Array.from(diagramContext.getCurrent().connections.values())).toEqual([
        expect.objectContaining({
          type: 'bpmn:SequenceFlow',
          source: 'StartEvent_1',
          target: 'Task_1'
        })
      ]);
    });

    it('should connect with label', async () => {
      const result = await handler.handleRequest('connect', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1',
        label: 'Start Flow'
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Connected StartEvent_1 to Task_1 with label "Start Flow"');
      expect(Array.from(diagramContext.getCurrent().connections.values())).toEqual([
        expect.objectContaining({
          source: 'StartEvent_1',
          target: 'Task_1',
          label: 'Start Flow'
        })
      ]);
    });

    it('should pass condition metadata to XML and expose it through element details', async () => {
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Second Task'
      });
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Fallback Task'
      });
      const condition = '${amount < 100 && city === "Zürich & Bern"}';
      const result = await handler.handleRequest('connect', {
        sourceId: 'Task_1',
        targetId: 'Task_2',
        label: 'Conditional label',
        condition,
        conditionLanguage: 'FEEL',
        conditionType: 'bpmn:FormalExpression'
      });

      expect(result.isError).toBeUndefined();
      const defaultResult = await handler.handleRequest('connect', {
        sourceId: 'Task_1',
        targetId: 'Task_3',
        label: 'Otherwise',
        isDefault: true
      });
      expect(defaultResult.isError).toBeUndefined();
      const context = diagramContext.getCurrent();
      const flow = Array.from(context.connections.values()).find(
        connection => connection.source === 'Task_1' && connection.target === 'Task_2'
      );
      const defaultFlow = Array.from(context.connections.values()).find(
        connection => connection.source === 'Task_1' && connection.target === 'Task_3'
      );
      if (!flow || !defaultFlow) throw new Error('Expected conditional and default flows');
      const parsed = await new BpmnModdle().fromXML(context.xml!);
      expect(parsed.elementsById[flow.id].conditionExpression).toMatchObject({
        $type: 'bpmn:FormalExpression',
        body: condition,
        language: 'FEEL'
      });
      expect(parsed.elementsById[defaultFlow.id].conditionExpression).toBeUndefined();
      expect(parsed.elementsById.Task_1.default).toBe(parsed.elementsById[defaultFlow.id]);

      const details = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      const detailBody = JSON.parse(details.content[0].text as string);
      expect(detailBody.defaultFlow).toBe(defaultFlow.id);
      expect(detailBody.outgoing).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: flow.id,
          label: 'Conditional label',
          condition: {
            body: condition,
            language: 'FEEL',
            type: 'bpmn:FormalExpression'
          },
          isDefault: false
        }),
        expect.objectContaining({
          id: defaultFlow.id,
          isDefault: true
        })
      ]));

      const clear = await handler.handleRequest('update_element', {
        elementId: 'Task_1',
        defaultFlow: null
      });
      expect(clear.isError).toBeUndefined();
      const afterClear = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(afterClear.elementsById.Task_1.default).toBeUndefined();
    });

    it('should query complete semantic and DI views for every connection type', async () => {
      const filename = 'connection-queries.bpmn';
      const fixture = await readFile(join(
        process.cwd(), 'tests/fixtures/import-roundtrip/full-semantics-di.bpmn'
      ), 'utf8');
      const withDefault = fixture.replace(
        '<bpmn:subProcess id="SubProcess_Preserved" name="Nested work">',
        '<bpmn:subProcess id="SubProcess_Preserved" name="Nested work" default="Flow_To_End">'
      );
      await writeFile(join(sandbox!.directory, filename), withDefault, 'utf8');
      await handler.handleRequest('open_bpmn', { filename });

      const sequencePage = await handler.handleRequest('list_connections', {
        connectionType: 'bpmn:SequenceFlow',
        ownerId: 'Process_RoundTrip',
        scopeId: 'Process_RoundTrip',
        limit: 2,
        offset: 2
      });
      expect(JSON.parse(sequencePage.content[0].text as string)).toMatchObject({
        count: 4,
        returnedCount: 2,
        offset: 2,
        limit: 2,
        hasMore: false,
        connections: [
          { id: 'Flow_Task_Gateway', type: 'bpmn:SequenceFlow' },
          { id: 'Flow_To_End', type: 'bpmn:SequenceFlow' }
        ],
        revision: expect.any(String)
      });

      const conditional = await handler.handleRequest('get_connection', {
        connectionId: 'Flow_Approved'
      });
      const conditionalView = JSON.parse(conditional.content[0].text as string);
      expect(conditionalView).toEqual({
        id: 'Flow_Approved',
        type: 'bpmn:SequenceFlow',
        ownerId: 'Process_RoundTrip',
        scopeId: 'Process_RoundTrip',
        sourceId: 'Gateway_Decision',
        targetId: 'SubProcess_Preserved',
        label: 'approved',
        condition: {
          body: '${approved = true}',
          type: 'bpmn:FormalExpression'
        },
        isDefault: false,
        waypoints: [{ x: 430, y: 208 }, { x: 490, y: 208 }],
        edgeId: 'Flow_Approved_CustomDI',
        labelBounds: { x: 444, y: 186, width: 62, height: 14 },
        geometryRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        semanticRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        revision: expect.any(String)
      });

      const defaultFlow = await handler.handleRequest('get_connection', {
        connectionId: 'Flow_To_End'
      });
      expect(JSON.parse(defaultFlow.content[0].text as string)).toMatchObject({
        isDefault: true,
        defaultOwnerId: 'SubProcess_Preserved'
      });

      const message = await handler.handleRequest('list_connections', {
        connectionType: 'bpmn:MessageFlow',
        sourceId: 'Task_Unrelated',
        targetId: 'Participant_External'
      });
      expect(JSON.parse(message.content[0].text as string)).toMatchObject({
        count: 1,
        connections: [{
          id: 'MessageFlow_Notice',
          type: 'bpmn:MessageFlow',
          ownerId: 'Collaboration_RoundTrip',
          scopeId: 'Collaboration_RoundTrip',
          sourceId: 'Task_Unrelated',
          targetId: 'Participant_External',
          label: 'notice',
          edgeId: 'MessageFlow_Notice_CustomDI'
        }]
      });

      const createdAssociation = await handler.handleRequest('add_association', {
        sourceId: 'DataObjectReference_Request',
        targetId: 'Task_Unrelated',
        associationDirection: 'Both'
      });
      const associationId = (createdAssociation.structuredContent as any).associationId as string;
      const association = await handler.handleRequest('get_connection', {
        connectionId: associationId
      });
      expect(JSON.parse(association.content[0].text as string)).toMatchObject({
        id: associationId,
        type: 'bpmn:Association',
        associationDirection: 'Both',
        sourceId: 'DataObjectReference_Request',
        targetId: 'Task_Unrelated',
        edgeId: `${associationId}_di`
      });

      const edge = diagramContext.getCurrent().document.diagram.edges
        .get('Flow_Approved_CustomDI')!;
      const revisionBeforeGeometryEdit = diagramContext.getCurrent().revision;
      edge.waypoints[1] = { x: 491, y: 208 };
      const changed = await handler.handleRequest('get_connection', {
        connectionId: 'Flow_Approved'
      });
      expect((changed.structuredContent as any).geometryRevision)
        .not.toBe(conditionalView.geometryRevision);
      expect((changed.structuredContent as any).revision).toBe(revisionBeforeGeometryEdit);
    });

    it('should reject getting an unknown connection without changing query state or disk', async () => {
      const context = diagramContext.getCurrent();
      const beforeXml = context.xml;
      const beforeRevision = context.revision;
      const beforeFile = await readFile(join(sandbox!.directory, context.filename!), 'utf8');

      const result = await handler.handleRequest('get_connection', {
        connectionId: 'Flow_Missing'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: Connection Flow_Missing not found');
      expect(context.xml).toBe(beforeXml);
      expect(context.revision).toBe(beforeRevision);
      await expect(readFile(join(sandbox!.directory, context.filename!), 'utf8'))
        .resolves.toBe(beforeFile);
    });

    it('should update connection semantics without DI but reject endpoint rewiring', async () => {
      const filename = 'semantic-without-di.bpmn';
      const fixture = await readFile(join(
        process.cwd(), 'tests/fixtures/layout/sequential.bpmn'
      ), 'utf8');
      await writeFile(join(sandbox!.directory, filename), fixture, 'utf8');
      await handler.handleRequest('open_bpmn', { filename });

      const before = (await handler.handleRequest('get_connection', {
        connectionId: 'Flow_Sequential_2'
      })).structuredContent as any;
      const updated = await handler.handleRequest('update_connection', {
        connectionId: 'Flow_Sequential_2',
        label: 'Reviewed path',
        expectedSemanticRevision: before.semanticRevision
      });

      expect(updated.isError).toBeUndefined();
      expect(updated.structuredContent).toMatchObject({
        after: { label: 'Reviewed path' },
        diagnostics: [expect.objectContaining({ code: 'MISSING_DI' })],
        introducedDiagnostics: []
      });
      const context = diagramContext.getCurrent();
      const beforeRejectedXml = context.xml;
      const beforeRejectedRevision = context.revision;
      const beforeRejectedDisk = await readFile(join(sandbox!.directory, filename), 'utf8');

      const rejected = await handler.handleRequest('update_connection', {
        connectionId: 'Flow_Sequential_2',
        targetId: 'End_Sequential',
        endpointPolicy: 'snap-to-boundary',
        expectedSemanticRevision: (updated.structuredContent as any).after.semanticRevision
      });

      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain(
        'requires rendered edge and endpoint BPMNShapes for rewiring'
      );
      expect(context.connections.get('Flow_Sequential_2')).toMatchObject({
        source: 'Task_Review',
        target: 'Task_Archive',
        label: 'Reviewed path'
      });
      expect(context.xml).toBe(beforeRejectedXml);
      expect(context.revision).toBe(beforeRejectedRevision);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(beforeRejectedDisk);
    });

    it('should update sequence-flow semantics atomically, guard stale state, snap rewired endpoints, and reopen', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Semantic connection update' });
      const sourceResult = await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Source', position: { x: 100, y: 100 }
      });
      const firstTargetResult = await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'First target', position: { x: 400, y: 100 }
      });
      const secondTargetResult = await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Second target', position: { x: 400, y: 300 }
      });
      const sourceId = (sourceResult.structuredContent as any).elementId as string;
      const firstTargetId = (firstTargetResult.structuredContent as any).elementId as string;
      const secondTargetId = (secondTargetResult.structuredContent as any).elementId as string;
      const connected = await handler.handleRequest('connect', {
        sourceId, targetId: firstTargetId, label: 'Before',
        condition: '${approved}', conditionLanguage: 'FEEL'
      });
      const connectionId = (connected.structuredContent as any).connectionId as string;
      const context = diagramContext.getCurrent();
      const filename = context.filename!;
      const original = (await handler.handleRequest('get_connection', {
        connectionId
      })).structuredContent as any;
      const edge = Array.from(context.document.diagram.edges.values()).find(
        candidate => candidate.connectionId === connectionId
      )!;
      const untouchedEdge = structuredClone(edge);

      const semantic = await handler.handleRequest('update_connection', {
        connectionId,
        label: 'After',
        condition: { body: '${revised}', language: null },
        expectedSemanticRevision: original.semanticRevision
      });
      expect(semantic.isError).toBeUndefined();
      expect(semantic.structuredContent).toMatchObject({
        connectionId,
        before: {
          connectionId,
          label: 'Before',
          condition: { body: '${approved}', language: 'FEEL' },
          semanticRevision: original.semanticRevision
        },
        after: {
          connectionId,
          label: 'After',
          condition: { body: '${revised}' },
          semanticRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        },
        diagnostics: expect.any(Array),
        introducedDiagnostics: [],
        collisionPolicy: 'reject-new',
        filename,
        beforeRevision: original.revision,
        afterRevision: expect.any(String)
      });
      expect(edge).toEqual(untouchedEdge);

      const afterSemantic = (semantic.structuredContent as any).after;
      const memoryBeforeDocumentStale = structuredClone(context.connections.get(connectionId));
      const xmlBeforeDocumentStale = context.xml;
      const revisionBeforeDocumentStale = context.revision;
      const diskBeforeDocumentStale = await readFile(join(sandbox!.directory, filename), 'utf8');
      const documentStale = await handler.handleRequest('update_connection', {
        connectionId,
        label: 'Stale document edit',
        expectedRevision: original.revision
      });
      expect(documentStale).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'revision_conflict',
          conflict: true,
          reason: 'revision_mismatch',
          expectedRevision: original.revision,
          actualRevision: revisionBeforeDocumentStale
        }
      });
      expect(context.connections.get(connectionId)).toEqual(memoryBeforeDocumentStale);
      expect(context.xml).toBe(xmlBeforeDocumentStale);
      expect(context.revision).toBe(revisionBeforeDocumentStale);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(diskBeforeDocumentStale);

      const diskBeforeRejected = await readFile(join(sandbox!.directory, filename), 'utf8');
      const revisionBeforeRejected = context.revision;
      const stale = await handler.handleRequest('update_connection', {
        connectionId,
        label: 'Stale',
        expectedSemanticRevision: original.semanticRevision
      });
      expect(stale).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'semantic_conflict',
          connectionId,
          expectedSemanticRevision: original.semanticRevision,
          actualSemanticRevision: afterSemantic.semanticRevision
        }
      });
      expect(context.revision).toBe(revisionBeforeRejected);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(diskBeforeRejected);

      const rewired = await handler.handleRequest('update_connection', {
        connectionId,
        targetId: secondTargetId,
        endpointPolicy: 'snap-to-boundary',
        collisionPolicy: 'allow',
        expectedSemanticRevision: afterSemantic.semanticRevision
      });
      expect(rewired.isError).toBeUndefined();
      expect((rewired.structuredContent as any).after).toMatchObject({
        connectionId,
        sourceId,
        targetId: secondTargetId,
        label: 'After',
        condition: { body: '${revised}' }
      });
      const rewiredEdge = Array.from(context.document.diagram.edges.values()).find(
        candidate => candidate.connectionId === connectionId
      )!;
      expect(rewiredEdge.waypoints[0]).toEqual(expect.objectContaining({ x: 200 }));
      expect(rewiredEdge.waypoints.at(-1)).toEqual(expect.objectContaining({ y: 300 }));

      const defaulted = await handler.handleRequest('update_connection', {
        connectionId,
        condition: null,
        isDefault: true,
        expectedRevision: context.revision
      });
      expect(defaulted.isError).toBeUndefined();
      expect((defaulted.structuredContent as any).after).toMatchObject({
        connectionId,
        isDefault: true,
        defaultOwnerId: sourceId
      });
      expect((defaulted.structuredContent as any).after.condition).toBeUndefined();

      const beforeUnsupported = context.xml;
      const unsupported = await handler.handleRequest('update_connection', {
        connectionId,
        associationDirection: 'Both',
        expectedRevision: context.revision
      });
      expect(unsupported.isError).toBe(true);
      expect(unsupported.content[0].text).toContain(
        'associationDirection can only be set for associations'
      );
      expect(context.xml).toBe(beforeUnsupported);

      await handler.handleRequest('open_bpmn', { filename });
      const reopened = (await handler.handleRequest('get_connection', {
        connectionId
      })).structuredContent as any;
      expect(reopened).toMatchObject({
        id: connectionId,
        sourceId,
        targetId: secondTargetId,
        label: 'After',
        isDefault: true,
        defaultOwnerId: sourceId
      });
      expect(reopened.condition).toBeUndefined();
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById[connectionId].sourceRef.id).toBe(sourceId);
      expect(parsed.elementsById[connectionId].targetRef.id).toBe(secondTargetId);
      expect(parsed.elementsById[connectionId].conditionExpression).toBeUndefined();
      expect(parsed.elementsById[sourceId].default.id).toBe(connectionId);
    });

    it('should reconcile explicit incoming and outgoing references when rewiring both endpoints', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Explicit connection references' });
      const ids: string[] = [];
      for (const [name, position] of [
        ['Old source', { x: 100, y: 100 }],
        ['Old target', { x: 350, y: 100 }],
        ['New source', { x: 100, y: 300 }],
        ['New target', { x: 350, y: 300 }]
      ] as const) {
        const created = await handler.handleRequest('add_activity', {
          activityType: 'task', name, position
        });
        ids.push((created.structuredContent as any).elementId as string);
      }
      const [oldSourceId, oldTargetId, newSourceId, newTargetId] = ids;
      const connected = await handler.handleRequest('connect', {
        sourceId: oldSourceId,
        targetId: oldTargetId
      });
      const connectionId = (connected.structuredContent as any).connectionId as string;
      const filename = diagramContext.getCurrent().filename!;
      const parsedSeed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      const semanticFlow = parsedSeed.elementsById[connectionId];
      parsedSeed.elementsById[oldSourceId].outgoing = [semanticFlow];
      parsedSeed.elementsById[oldTargetId].incoming = [semanticFlow];
      const explicitXml = (await new BpmnModdle().toXML(parsedSeed.rootElement, {
        format: true
      })).xml;
      await handler.handleRequest('close', {});
      await writeFile(join(sandbox!.directory, filename), explicitXml, 'utf8');
      await handler.handleRequest('open_bpmn', { filename });

      const before = (await handler.handleRequest('get_connection', {
        connectionId
      })).structuredContent as any;
      const rewired = await handler.handleRequest('update_connection', {
        connectionId,
        sourceId: newSourceId,
        targetId: newTargetId,
        endpointPolicy: 'snap-to-boundary',
        collisionPolicy: 'allow',
        expectedSemanticRevision: before.semanticRevision
      });
      expect(rewired.isError).toBeUndefined();

      await handler.handleRequest('close', {});
      await handler.handleRequest('open_bpmn', { filename });
      const reopened = (await handler.handleRequest('get_connection', {
        connectionId
      })).structuredContent as any;
      expect(reopened).toMatchObject({ sourceId: newSourceId, targetId: newTargetId });
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect((parsed.elementsById[oldSourceId].outgoing || []).map((item: any) => item.id))
        .not.toContain(connectionId);
      expect((parsed.elementsById[oldTargetId].incoming || []).map((item: any) => item.id))
        .not.toContain(connectionId);
      expect((parsed.elementsById[newSourceId].outgoing || []).map((item: any) => item.id))
        .toContain(connectionId);
      expect((parsed.elementsById[newTargetId].incoming || []).map((item: any) => item.id))
        .toContain(connectionId);
    });

    it('should update message-flow and association semantics and reject invalid endpoint scopes', async () => {
      const filename = 'connection-semantic-types.bpmn';
      const fixture = await readFile(join(
        process.cwd(), 'tests/fixtures/import-roundtrip/full-semantics-di.bpmn'
      ), 'utf8');
      await writeFile(join(sandbox!.directory, filename), fixture, 'utf8');
      await handler.handleRequest('open_bpmn', { filename });

      const messageBefore = (await handler.handleRequest('get_connection', {
        connectionId: 'MessageFlow_Notice'
      })).structuredContent as any;
      const message = await handler.handleRequest('update_connection', {
        connectionId: 'MessageFlow_Notice',
        sourceId: 'Participant_Internal',
        label: 'Rewired notice',
        endpointPolicy: 'snap-to-boundary',
        collisionPolicy: 'allow',
        expectedSemanticRevision: messageBefore.semanticRevision
      });
      expect(message.isError).toBeUndefined();
      expect((message.structuredContent as any).after).toMatchObject({
        type: 'bpmn:MessageFlow',
        sourceId: 'Participant_Internal',
        targetId: 'Participant_External',
        label: 'Rewired notice'
      });

      const associationCreated = await handler.handleRequest('add_association', {
        sourceId: 'DataObjectReference_Request',
        targetId: 'Task_Unrelated'
      });
      const associationId = (associationCreated.structuredContent as any).associationId as string;
      const associationBefore = (await handler.handleRequest('get_connection', {
        connectionId: associationId
      })).structuredContent as any;
      // bpmn:Association has no name attribute, so a label used to be accepted
      // and reported back before being dropped on save (mcp-bpmn-a3j.15). It is
      // now refused, and the direction update on its own still applies.
      const labelled = await handler.handleRequest('update_connection', {
        connectionId: associationId,
        label: 'Supporting data',
        associationDirection: 'Both',
        expectedSemanticRevision: associationBefore.semanticRevision
      });
      expect(labelled.isError).toBe(true);
      expect(labelled.content[0].text).toContain('associations have no name');

      const association = await handler.handleRequest('update_connection', {
        connectionId: associationId,
        associationDirection: 'Both',
        expectedSemanticRevision: associationBefore.semanticRevision
      });
      expect(association.isError).toBeUndefined();
      expect((association.structuredContent as any).after).toMatchObject({
        type: 'bpmn:Association',
        associationDirection: 'Both'
      });

      const context = diagramContext.getCurrent();
      const beforeRejected = context.xml;
      const rejected = await handler.handleRequest('update_connection', {
        connectionId: 'MessageFlow_Notice',
        targetId: 'Participant_Internal',
        endpointPolicy: 'snap-to-boundary',
        expectedRevision: context.revision
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('must cross participant boundaries');
      expect(context.xml).toBe(beforeRejected);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(beforeRejected);

      await handler.handleRequest('close', {});
      await handler.handleRequest('open_bpmn', { filename });
      const reopenedMessage = (await handler.handleRequest('get_connection', {
        connectionId: 'MessageFlow_Notice'
      })).structuredContent as any;
      const reopenedAssociation = (await handler.handleRequest('get_connection', {
        connectionId: associationId
      })).structuredContent as any;
      expect(reopenedMessage).toMatchObject({
        type: 'bpmn:MessageFlow',
        sourceId: 'Participant_Internal',
        targetId: 'Participant_External',
        label: 'Rewired notice',
        ownerId: 'Collaboration_RoundTrip',
        scopeId: 'Collaboration_RoundTrip'
      });
      expect(reopenedAssociation).toMatchObject({
        type: 'bpmn:Association',
        associationDirection: 'Both'
      });
    });

    it('should move a rewired association from a nested artifact container to the root', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Association container move' });
      const context = diagramContext.getCurrent();
      const rootTask = await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Root task', position: { x: 100, y: 100 }
      });
      const rootTaskId = (rootTask.structuredContent as any).elementId as string;
      const rootAnnotation = await handler.handleRequest('add_text_annotation', {
        text: 'Root note',
        position: { x: 300, y: 110 },
        associatedElementId: rootTaskId
      });
      const rootAnnotationId = (rootAnnotation.structuredContent as any).annotationId as string;
      const subprocess = await handler.handleRequest('add_activity', {
        activityType: 'subProcess', name: 'Nested scope', position: { x: 500, y: 100 }
      });
      const subprocessId = (subprocess.structuredContent as any).elementId as string;
      const nestedTask = await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Nested task',
        ownerId: context.id,
        scopeId: subprocessId,
        position: { x: 550, y: 150 }
      });
      const nestedTaskId = (nestedTask.structuredContent as any).elementId as string;
      const nestedAnnotation = await handler.handleRequest('add_text_annotation', {
        text: 'Nested note',
        position: { x: 700, y: 160 },
        associatedElementId: nestedTaskId
      });
      const associationId = (nestedAnnotation.structuredContent as any).associationId as string;
      const before = (await handler.handleRequest('get_connection', {
        connectionId: associationId
      })).structuredContent as any;
      expect(before).toMatchObject({ ownerId: context.id, scopeId: subprocessId });

      const moved = await handler.handleRequest('update_connection', {
        connectionId: associationId,
        sourceId: rootAnnotationId,
        targetId: rootTaskId,
        endpointPolicy: 'snap-to-boundary',
        collisionPolicy: 'allow',
        expectedSemanticRevision: before.semanticRevision
      });
      expect(moved.isError).toBeUndefined();
      expect((moved.structuredContent as any).after).toMatchObject({
        ownerId: context.id,
        scopeId: context.id,
        sourceId: rootAnnotationId,
        targetId: rootTaskId
      });

      const filename = context.filename!;
      await handler.handleRequest('close', {});
      await handler.handleRequest('open_bpmn', { filename });
      const reopened = (await handler.handleRequest('get_connection', {
        connectionId: associationId
      })).structuredContent as any;
      expect(reopened).toMatchObject({
        ownerId: context.id,
        scopeId: context.id,
        sourceId: rootAnnotationId,
        targetId: rootTaskId
      });
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      const rootProcess = parsed.rootElement.rootElements.find(
        (item: any) => item.id === context.id
      );
      expect(rootProcess.artifacts.map((item: any) => item.id)).toContain(associationId);
      expect((parsed.elementsById[subprocessId].artifacts || []).map((item: any) => item.id))
        .not.toContain(associationId);
    });

    it('should preview, persist, guard, clear, and reopen one imported edge atomically', async () => {
      const filename = 'connection-geometry.bpmn';
      const fixture = await readFile(join(
        process.cwd(), 'tests/fixtures/import-roundtrip/full-semantics-di.bpmn'
      ), 'utf8');
      await writeFile(join(sandbox!.directory, filename), fixture, 'utf8');
      await handler.handleRequest('open_bpmn', { filename });

      const context = diagramContext.getCurrent();
      const connectionId = 'Flow_Approved';
      const original = (await handler.handleRequest('get_connection', {
        connectionId
      })).structuredContent as any;
      const originalXml = context.xml;
      const originalRevision = context.revision;
      const originalDisk = await readFile(join(sandbox!.directory, filename), 'utf8');
      const unrelatedEdges = structuredClone(Array.from(context.document.diagram.edges.entries())
        .filter(([, edge]) => edge.connectionId !== connectionId));
      const originalSemantic = structuredClone(context.connections.get(connectionId)!);
      const waypoints = [{ x: 430, y: 208 }, { x: 460, y: 208 }, { x: 490, y: 208 }];

      const preview = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints,
        expectedWaypoints: original.waypoints,
        expectedGeometryRevision: original.geometryRevision,
        expectedRevision: originalRevision,
        dryRun: true
      });
      expect(preview.isError).toBeUndefined();
      expect(preview.structuredContent).toMatchObject({
        connectionId,
        before: {
          edgeId: 'Flow_Approved_CustomDI',
          waypoints: original.waypoints,
          labelBounds: original.labelBounds,
          geometryRevision: original.geometryRevision
        },
        after: {
          waypoints,
          labelBounds: original.labelBounds,
          geometryRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        },
        diagnostics: expect.any(Array),
        introducedDiagnostics: expect.any(Array),
        endpointPolicy: 'exact',
        collisionPolicy: 'reject-new',
        dryRun: true,
        applied: false,
        beforeRevision: originalRevision,
        afterRevision: originalRevision,
        filename
      });
      expect(context.xml).toBe(originalXml);
      expect(context.revision).toBe(originalRevision);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(originalDisk);

      const applied = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints,
        labelBounds: null,
        expectedGeometryRevision: original.geometryRevision,
        expectedRevision: originalRevision
      });
      expect(applied.isError).toBeUndefined();
      expect(applied.structuredContent).toMatchObject({
        after: { waypoints },
        dryRun: false,
        applied: true,
        beforeRevision: originalRevision,
        afterRevision: expect.any(String)
      });
      expect((applied.structuredContent as any).after.labelBounds).toBeUndefined();
      expect((applied.structuredContent as any).after.geometryRevision)
        .not.toBe(original.geometryRevision);

      const staleRevision = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints,
        expectedGeometryRevision: original.geometryRevision
      });
      expect(staleRevision).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'geometry_conflict',
          reason: 'geometry_revision_mismatch',
          connectionId,
          actualWaypoints: waypoints
        }
      });
      const staleWaypoints = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints,
        expectedWaypoints: original.waypoints
      });
      expect(staleWaypoints).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'geometry_conflict',
          reason: 'waypoints_mismatch',
          connectionId,
          expectedWaypoints: original.waypoints,
          actualWaypoints: waypoints
        }
      });

      expect(Array.from(context.document.diagram.edges.entries())
        .filter(([, edge]) => edge.connectionId !== connectionId)).toEqual(unrelatedEdges);
      expect(context.connections.get(connectionId)).toEqual({
        ...originalSemantic,
        waypoints
      });
      await handler.handleRequest('open_bpmn', { filename });
      const reopened = diagramContext.getCurrent();
      expect(reopened.document.diagram.edges.get('Flow_Approved_CustomDI')).toMatchObject({
        connectionId,
        waypoints
      });
      expect(reopened.document.diagram.edges.get('Flow_Approved_CustomDI')?.labelBounds)
        .toBeUndefined();
      expect(Array.from(reopened.document.diagram.edges.entries())
        .filter(([, edge]) => edge.connectionId !== connectionId)).toEqual(unrelatedEdges);
      const exported = await handler.handleRequest('export', { format: 'xml' });
      const parsed = await new BpmnModdle().fromXML(exported.content[0].text as string);
      expect(parsed.elementsById.Flow_Approved_CustomDI.waypoint).toEqual(
        expect.arrayContaining(waypoints.map(point => expect.objectContaining(point)))
      );
      expect(parsed.elementsById.Flow_Approved_CustomDI.label).toBeUndefined();
    });

    it('should enforce exact endpoints, snap both boundaries, and apply collision policies', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Connection geometry policies' });
      const source = await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Source', position: { x: 100, y: 100 }
      });
      const target = await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Target', position: { x: 400, y: 100 }
      });
      const sourceId = (source.structuredContent as any).elementId as string;
      const targetId = (target.structuredContent as any).elementId as string;
      const connected = await handler.handleRequest('connect', {
        sourceId, targetId
      });
      const connectionId = (connected.structuredContent as any).connectionId as string;

      const exactGap = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints: [{ x: 150, y: 140 }, { x: 450, y: 140 }],
        endpointPolicy: 'exact',
        collisionPolicy: 'allow'
      });
      expect(exactGap.isError).toBe(true);
      expect(exactGap.content[0].text).toContain('Unsafe geometry');

      const snapped = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints: [{ x: 150, y: 140 }, { x: 450, y: 140 }],
        endpointPolicy: 'snap-to-boundary'
      });
      expect(snapped.isError).toBeUndefined();
      expect((snapped.structuredContent as any).after.waypoints).toEqual([
        { x: 200, y: 140 },
        { x: 400, y: 140 }
      ]);

      await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Blocker', position: { x: 250, y: 300 }
      });
      const crossing = [
        { x: 200, y: 140 },
        { x: 200, y: 340 },
        { x: 500, y: 340 },
        { x: 500, y: 140 },
        { x: 400, y: 140 }
      ];
      const rejected = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints: crossing
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('Geometry collision rejected');

      const warned = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints: crossing,
        collisionPolicy: 'warn',
        dryRun: true
      });
      expect(warned.isError).toBeUndefined();
      expect((warned.structuredContent as any).introducedDiagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({
          code: 'EDGE_SHAPE_COLLISION', severity: 'error'
        })])
      );
      expect(diagramContext.getCurrent().connections.get(connectionId)?.waypoints)
        .toEqual([{ x: 200, y: 140 }, { x: 400, y: 140 }]);

      const allowed = await handler.handleRequest('update_connection_geometry', {
        connectionId,
        waypoints: crossing,
        collisionPolicy: 'allow'
      });
      expect(allowed.isError).toBeUndefined();
      expect(diagramContext.getCurrent().connections.get(connectionId)?.waypoints)
        .toEqual(crossing);
    });

    it('should reject non-boolean default-flow input without creating a flow', async () => {
      const result = await handler.handleRequest('connect', {
        sourceId: 'Task_1',
        targetId: 'StartEvent_1',
        isDefault: 'true'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'Invalid arguments for tool "connect": isDefault: Expected boolean'
      );
      expect(diagramContext.getCurrent().connections.size).toBe(0);
    });

    it('should infer a message flow between participant process boundaries', async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Connection Test Collaboration',
        type: 'collaboration'
      });
      await handler.handleRequest('add_pool', { name: 'Buyer' });
      await handler.handleRequest('add_pool', { name: 'Seller' });
      const context = diagramContext.getCurrent();
      const participants = Array.from(context.elements.values()).filter(
        element => element.kind === 'participant'
      );
      const buyer = participants.find(element => element.name === 'Buyer');
      const seller = participants.find(element => element.name === 'Seller');
      if (buyer?.kind !== 'participant' || seller?.kind !== 'participant'
        || !buyer.processRef || !seller.processRef) {
        throw new Error('Expected two white-box participants');
      }
      await handler.handleRequest('add_activity', {
        activityType: 'sendTask',
        name: 'Send order',
        ownerId: buyer.processRef
      });
      await handler.handleRequest('add_activity', {
        activityType: 'receiveTask',
        name: 'Receive order',
        ownerId: seller.processRef
      });
      const source = Array.from(context.elements.values()).find(element => element.name === 'Send order');
      const target = Array.from(context.elements.values()).find(element => element.name === 'Receive order');
      if (!source || !target) throw new Error('Expected handler-created activities');

      const result = await handler.handleRequest('connect', {
        sourceId: source.id,
        targetId: target.id,
        label: 'Order'
      });

      expect(result.isError).toBeUndefined();
      expect(Array.from(context.connections.values())).toEqual([
        expect.objectContaining({
          type: 'bpmn:MessageFlow',
          ownerId: context.id,
          scopeId: context.id,
          source: source.id,
          target: target.id
        })
      ]);
    });

    it('should handle invalid element IDs', async () => {
      // The message names which end is wrong and the id it was given
      // (mcp-bpmn-8u0.6), so the caller does not have to bisect.
      const both = await handler.handleRequest('connect', {
        sourceId: 'invalid-source',
        targetId: 'invalid-target'
      });
      expect(both.isError).toBe(true);
      expect(both.content[0].text).toContain('Source element "invalid-source" not found');
      expect(both.structuredContent).toMatchObject({ code: 'element_not_found' });

      const created = await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Real source'
      });
      const sourceId = (created.structuredContent as { elementId: string }).elementId;
      const targetOnly = await handler.handleRequest('connect', {
        sourceId,
        targetId: 'invalid-target'
      });
      expect(targetOnly.isError).toBe(true);
      expect(targetOnly.content[0].text).toContain('Target element "invalid-target" not found');
    });

    it('should add, list, get, and independently delete an association', async () => {
      const created = await handler.handleRequest('add_association', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1',
        associationDirection: 'One'
      });

      expect(created.isError).toBeUndefined();
      expect(created.content[0].text).toBe(
        'Added association Association_1 from StartEvent_1 to Task_1 (One)'
      );
      const listing = await handler.handleRequest('list_elements', {
        elementType: 'bpmn:Association'
      });
      expect(JSON.parse(listing.content[0].text as string)).toMatchObject({
        count: 1,
        elements: [{
          id: 'Association_1',
          type: 'bpmn:Association',
          sourceId: 'StartEvent_1',
          targetId: 'Task_1',
          associationDirection: 'One'
        }]
      });
      const details = await handler.handleRequest('get_element', {
        elementId: 'Association_1'
      });
      expect(JSON.parse(details.content[0].text as string)).toMatchObject({
        id: 'Association_1',
        kind: 'association',
        associationDirection: 'One'
      });
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.Association_1).toMatchObject({
        $type: 'bpmn:Association',
        associationDirection: 'One'
      });
      expect(parsed.elementsById.Association_1_di.bpmnElement)
        .toBe(parsed.elementsById.Association_1);

      const deleted = await handler.handleRequest('delete_element', {
        elementId: 'Association_1'
      });
      expect(deleted.content[0].text).toBe('Deleted association Association_1');
      expect(diagramContext.getCurrent().connections.size).toBe(0);
      expect(diagramContext.getCurrent().elements.has('StartEvent_1')).toBe(true);
      expect(diagramContext.getCurrent().elements.has('Task_1')).toBe(true);
    });

    it('should reject an invalid association direction before mutation', async () => {
      const xmlBefore = diagramContext.getCurrent().xml;
      const result = await handler.handleRequest('add_association', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1',
        associationDirection: 'Sideways'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('associationDirection: Invalid enum value');
      expect(diagramContext.getCurrent().connections.size).toBe(0);
      expect(diagramContext.getCurrent().xml).toBe(xmlBefore);
    });
  });

  describe('auto_layout', () => {
    it('should update the active XML with distinct element positions', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Layout Test' });
      await handler.handleRequest('add_event', { eventType: 'start' });
      await handler.handleRequest('add_activity', { activityType: 'task', name: 'Task' });
      await handler.handleRequest('add_event', { eventType: 'end' });
      await handler.handleRequest('connect', { sourceId: 'StartEvent_1', targetId: 'Task_1' });
      await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'EndEvent_1' });
      const xmlBefore = diagramContext.getCurrent().xml;

      const result = await handler.handleRequest('auto_layout', {});

      expect(result.isError).toBeUndefined();
      // The message names the reading direction; algorithm stays 'horizontal'
      // as the only ranking the layout engine offers (mcp-bpmn-9sv.15).
      expect(result.content[0].text).toContain('Applied left-to-right auto-layout');
      expect(result.content[0].text).toContain('3 elements');
      expect(diagramContext.getCurrent().xml).not.toBe(xmlBefore);
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      const expectedIds = new Set(['StartEvent_1', 'Task_1', 'EndEvent_1']);
      const shapes = parsed.rootElement.diagrams[0].plane.planeElement.filter(
        (element: { bpmnElement?: { id?: string }; bounds?: { x: number } }) => (
          element.bpmnElement?.id && expectedIds.has(element.bpmnElement.id)
        )
      );
      expect(shapes).toHaveLength(3);
      expect(new Set(shapes.map((shape: { bounds: { x: number } }) => shape.bounds.x)).size)
        .toBe(3);
    });
  });
  });

  describe('Query operations', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', { name: 'Query Test' });
      await handler.handleRequest('add_event', { eventType: 'start', name: 'Start' });
      await handler.handleRequest('add_activity', { activityType: 'task', name: 'Task' });
      await handler.handleRequest('add_event', { eventType: 'end', name: 'End' });
    });

    const snapshotQueryState = async () => {
      const context = diagramContext.getCurrent();
      const filenames = (await readdir(sandbox!.directory)).sort();
      return {
        context,
        info: structuredClone(diagramContext.getCurrentInfo()),
        elements: structuredClone(Array.from(context.elements.entries())),
        connections: structuredClone(Array.from(context.connections.entries())),
        xml: context.xml,
        files: await Promise.all(filenames.map(async filename => ({
          filename,
          content: await readFile(join(sandbox!.directory, filename), 'utf8')
        })))
      };
    };

    const expectQueryStateUnchanged = async (
      snapshot: Awaited<ReturnType<typeof snapshotQueryState>>
    ) => {
      const context = diagramContext.getCurrent();
      expect(context).toBe(snapshot.context);
      expect(diagramContext.getCurrentInfo()).toEqual(snapshot.info);
      expect(Array.from(context.elements.entries())).toEqual(snapshot.elements);
      expect(Array.from(context.connections.entries())).toEqual(snapshot.connections);
      expect(context.xml).toBe(snapshot.xml);
      const filenames = (await readdir(sandbox!.directory)).sort();
      await expect(Promise.all(filenames.map(async filename => ({
        filename,
        content: await readFile(join(sandbox!.directory, filename), 'utf8')
      })))).resolves.toEqual(snapshot.files);
    };

    it('should list all active elements with stable pagination metadata', async () => {
      const result = await handler.handleRequest('list_elements', {});
      const listing = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(listing.elements.map((element: { id: string }) => element.id)).toEqual([
        'EndEvent_1',
        'StartEvent_1',
        'Task_1'
      ]);
      expect(listing).toMatchObject({
        count: 3,
        returnedCount: 3,
        offset: 0,
        hasMore: false,
        revision: expect.any(String),
        elements: expect.arrayContaining([
          expect.objectContaining({
            id: 'Task_1',
            shapeId: 'Task_1_di',
            bounds: { x: 150, y: 200, width: 100, height: 80 }
          })
        ])
      });
      for (const element of listing.elements) {
        expect(element).toMatchObject({
          shapeId: expect.any(String),
          bounds: {
            x: expect.any(Number),
            y: expect.any(Number),
            width: expect.any(Number),
            height: expect.any(Number)
          }
        });
      }
    });

    it('should return element identity, type, and name', async () => {
      const result = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      const details = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(details).toMatchObject({
        id: 'Task_1',
        type: 'bpmn:Task',
        name: 'Task',
        shapeId: 'Task_1_di',
        bounds: { x: 150, y: 200, width: 100, height: 80 },
        revision: expect.any(String)
      });
    });

    it('should reject getting a non-existent element without changing state or disk', async () => {
      const before = await snapshotQueryState();

      const result = await handler.handleRequest('get_element', {
        elementId: 'Missing_Get_Element'
      });

      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Error: Element Missing_Get_Element not found' }],
        isError: true,
        structuredContent: { code: 'element_not_found', elementId: 'Missing_Get_Element' }
      });
      await expectQueryStateUnchanged(before);

      const valid = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      expect(valid.isError).toBeUndefined();
      expect(JSON.parse(valid.content[0].text as string)).toMatchObject({
        id: 'Task_1',
        name: 'Task'
      });
    });

    it('should update both query state and serialized XML', async () => {
      const updated = await handler.handleRequest('update_element', {
        elementId: 'Task_1',
        name: 'Updated Task'
      });
      const result = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      const details = JSON.parse(result.content[0].text as string);

      expect(updated.isError).toBeUndefined();
      expect(details.name).toBe('Updated Task');
      expect(details.properties).toEqual({});
      expect(diagramContext.getCurrent().elements.get('Task_1')?.name).toBe('Updated Task');
      const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
      expect(parsed.elementsById.Task_1.name).toBe('Updated Task');
    });

    it('should preview and atomically persist shape and label geometry', async () => {
      const context = diagramContext.getCurrent();
      const filename = context.filename!;
      const beforeRevision = context.revision;
      const beforeXml = context.xml;
      const beforeFile = await readFile(join(sandbox!.directory, filename), 'utf8');
      const startShapeBefore = structuredClone(
        Array.from(context.document.diagram.shapes.values()).find(
          shape => shape.elementId === 'StartEvent_1'
        )
      );
      const requestedBounds = { x: 500, y: 350, width: 140, height: 90 };
      const labelBounds = { x: 520, y: 450, width: 80, height: 20 };

      const preview = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds: requestedBounds,
        labelBounds,
        expectedBounds: { x: 150, y: 200, width: 100, height: 80 },
        expectedRevision: beforeRevision,
        collisionPolicy: 'allow',
        dryRun: true
      });

      expect(preview.isError).toBeUndefined();
      expect(preview.structuredContent).toMatchObject({
        elementId: 'Task_1',
        before: {
          shapeId: 'Task_1_di',
          bounds: { x: 150, y: 200, width: 100, height: 80 }
        },
        after: { shapeId: 'Task_1_di', bounds: requestedBounds, labelBounds },
        diagnostics: expect.any(Array),
        dryRun: true,
        applied: false,
        beforeRevision,
        afterRevision: beforeRevision
      });
      expect(context.revision).toBe(beforeRevision);
      expect(context.xml).toBe(beforeXml);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(beforeFile);

      const applied = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds: requestedBounds,
        labelBounds,
        expectedBounds: { x: 150, y: 200, width: 100, height: 80 },
        expectedRevision: beforeRevision,
        collisionPolicy: 'allow'
      });

      expect(applied.isError).toBeUndefined();
      expect(applied.structuredContent).toMatchObject({
        after: { bounds: requestedBounds, labelBounds },
        dryRun: false,
        applied: true,
        beforeRevision,
        afterRevision: expect.not.stringMatching(beforeRevision)
      });
      expect(context.elements.get('Task_1')).toMatchObject({
        name: 'Task',
        position: { x: 500, y: 350 },
        size: { width: 140, height: 90 }
      });
      expect(Array.from(context.document.diagram.shapes.values()).find(
        shape => shape.elementId === 'StartEvent_1'
      )).toEqual(startShapeBefore);
      const parsed = await new BpmnModdle().fromXML(context.xml!);
      expect(parsed.elementsById.Task_1_di.bounds).toMatchObject(requestedBounds);
      expect(parsed.elementsById.Task_1_di.label.bounds).toMatchObject(labelBounds);
      expect(parsed.elementsById.Task_1.name).toBe('Task');
      const labeledQuery = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      expect(labeledQuery.structuredContent).toMatchObject({
        shapeId: 'Task_1_di',
        bounds: requestedBounds,
        labelBounds,
        revision: context.revision
      });
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toBe(context.xml);

      const cleared = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds: requestedBounds,
        labelBounds: null,
        expectedRevision: context.revision,
        collisionPolicy: 'allow'
      });
      expect(cleared.isError).toBeUndefined();
      expect((cleared.structuredContent as any).after.labelBounds).toBeUndefined();
      const clearedParsed = await new BpmnModdle().fromXML(context.xml!);
      expect(clearedParsed.elementsById.Task_1_di.label).toBeUndefined();
      const queried = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      expect((queried.structuredContent as any).labelBounds).toBeUndefined();

      const stale = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds: { x: 600, y: 350, width: 140, height: 90 },
        expectedBounds: { x: 150, y: 200, width: 100, height: 80 },
        collisionPolicy: 'allow'
      });
      expect(stale).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'geometry_conflict',
          elementId: 'Task_1',
          actualBounds: requestedBounds
        }
      });
      expect(context.elements.get('Task_1')?.position).toEqual({ x: 500, y: 350 });
    });

    it('should require an incident-edge policy and snap endpoints atomically', async () => {
      const connected = await handler.handleRequest('connect', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1'
      });
      const connectionId = (connected.structuredContent as any).connectionId as string;
      const context = diagramContext.getCurrent();
      const beforeRevision = context.revision;
      const beforeXml = context.xml;
      const bounds = { x: 500, y: 300, width: 120, height: 80 };

      const omitted = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds,
        collisionPolicy: 'allow'
      });
      expect(omitted.isError).toBe(true);
      expect(omitted.content[0].text).toContain('incidentConnectionPolicy is required');
      expect(context.xml).toBe(beforeXml);
      expect(context.revision).toBe(beforeRevision);

      const rejected = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds,
        collisionPolicy: 'allow',
        incidentConnectionPolicy: 'reject'
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('use snap-endpoints');
      expect(context.xml).toBe(beforeXml);

      const snapped = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_1',
        bounds,
        collisionPolicy: 'allow',
        incidentConnectionPolicy: 'snap-endpoints'
      });
      expect(snapped.isError).toBeUndefined();
      expect((snapped.structuredContent as any).diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'ENDPOINT_GAP' })])
      );
      const connection = context.connections.get(connectionId)!;
      const snappedTarget = connection.waypoints[connection.waypoints.length - 1];
      expect(snappedTarget.x).toBe(500);
      expect(snappedTarget.y).toBeGreaterThanOrEqual(300);
      expect(snappedTarget.y).toBeLessThanOrEqual(380);
      const edge = Array.from(context.document.diagram.edges.values()).find(
        candidate => candidate.connectionId === connection.id
      );
      expect(edge?.waypoints).toEqual(connection.waypoints);
    });

    it('should reject newly introduced collisions unless explicitly allowed', async () => {
      const context = diagramContext.getCurrent();
      const beforeXml = context.xml;
      const overlapping = { x: 200, y: 200, width: 36, height: 36 };

      const rejected = await handler.handleRequest('update_element_geometry', {
        elementId: 'StartEvent_1',
        bounds: overlapping
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toContain('Geometry collision rejected');
      expect(context.xml).toBe(beforeXml);

      const allowed = await handler.handleRequest('update_element_geometry', {
        elementId: 'StartEvent_1',
        bounds: overlapping,
        collisionPolicy: 'allow'
      });
      expect(allowed.isError).toBeUndefined();
      expect((allowed.structuredContent as any).diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'SHAPE_OVERLAP' })])
      );
    });

    it('should reject subprocess, boundary-event, participant, lane, and owner escapes', async () => {
      await handler.handleRequest('add_activity', {
        activityType: 'subProcess',
        name: 'Nested scope',
        position: { x: 400, y: 400 }
      });
      const processId = diagramContext.getCurrent().id;
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Nested task',
        ownerId: processId,
        scopeId: 'SubProcess_1',
        position: { x: 450, y: 450 }
      });
      await handler.handleRequest('add_event', {
        eventType: 'boundary',
        attachTo: 'Task_1',
        position: { x: 230, y: 220 }
      });

      for (const [elementId, bounds] of [
        ['Task_2', { x: 800, y: 800, width: 100, height: 80 }],
        ['SubProcess_1', { x: 800, y: 800, width: 300, height: 200 }],
        ['BoundaryEvent_1', { x: 800, y: 800, width: 36, height: 36 }]
      ] as const) {
        const before = diagramContext.getCurrent().xml;
        const result = await handler.handleRequest('update_element_geometry', {
          elementId,
          bounds,
          collisionPolicy: 'allow'
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unsafe geometry');
        expect(diagramContext.getCurrent().xml).toBe(before);
      }

      await handler.handleRequest('new_bpmn', {
        name: 'Containment collaboration',
        type: 'collaboration'
      });
      const pool = await handler.handleRequest('add_pool', {
        name: 'Pool',
        position: { x: 100, y: 100 },
        size: { width: 600, height: 300 }
      });
      const poolId = (pool.structuredContent as any).elementId as string;
      const ownerId = (pool.structuredContent as any).processId as string;
      const ownedTask = await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Owned task',
        ownerId,
        position: { x: 250, y: 180 }
      });
      const ownedTaskId = (ownedTask.structuredContent as any).elementId as string;
      const lane = await handler.handleRequest('add_lane', {
        poolId,
        name: 'Lane',
        flowNodeIds: [ownedTaskId]
      });
      const laneId = (lane.structuredContent as any).laneId as string;

      for (const [elementId, bounds] of [
        [laneId, { x: 900, y: 900, width: 600, height: 300 }],
        [ownedTaskId, { x: 900, y: 900, width: 100, height: 80 }],
        [poolId, { x: 900, y: 900, width: 600, height: 300 }]
      ] as const) {
        const before = diagramContext.getCurrent().xml;
        const result = await handler.handleRequest('update_element_geometry', {
          elementId,
          bounds,
          collisionPolicy: 'allow'
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unsafe geometry');
        expect(diagramContext.getCurrent().xml).toBe(before);
      }
    });

    it('should apply coordinated shape moves and an incident reroute against only the final geometry', async () => {
      const context = diagramContext.getCurrent();
      await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Swap left', position: { x: 500, y: 500 }
      });
      await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Swap right', position: { x: 750, y: 500 }
      });
      const left = (await handler.handleRequest('get_element', {
        elementId: 'Task_2'
      })).structuredContent as any;
      const right = (await handler.handleRequest('get_element', {
        elementId: 'Task_3'
      })).structuredContent as any;

      const transientCollision = await handler.handleRequest('update_element_geometry', {
        elementId: 'Task_2',
        bounds: right.bounds,
        expectedRevision: context.revision
      });
      expect(transientCollision.isError).toBe(true);

      const swapped = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: context.revision,
        elementUpdates: [
          { elementId: 'Task_2', bounds: right.bounds },
          { elementId: 'Task_3', bounds: left.bounds }
        ]
      });
      expect(swapped.isError).toBeUndefined();
      expect(swapped.structuredContent).toMatchObject({
        elements: [
          { elementId: 'Task_2', before: { bounds: left.bounds }, after: { bounds: right.bounds } },
          { elementId: 'Task_3', before: { bounds: right.bounds }, after: { bounds: left.bounds } }
        ],
        connections: [],
        introducedDiagnostics: [],
        collisionPolicy: 'reject-new',
        dryRun: false,
        applied: true,
        beforeRevision: expect.any(String),
        afterRevision: expect.any(String)
      });

      const connected = await handler.handleRequest('connect', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1'
      });
      const connectionId = (connected.structuredContent as any).connectionId as string;
      const connection = (await handler.handleRequest('get_connection', {
        connectionId
      })).structuredContent as any;
      const task = (await handler.handleRequest('get_element', {
        elementId: 'Task_1'
      })).structuredContent as any;
      const movedTask = { x: 500, y: 200, width: 100, height: 80 };
      const rerouted = [
        { x: 118, y: 236 },
        { x: 118, y: 350 },
        { x: 550, y: 350 },
        { x: 550, y: 280 }
      ];

      const patched = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: context.revision,
        elementUpdates: [{
          elementId: 'Task_1',
          bounds: movedTask,
          labelBounds: { x: 510, y: 290, width: 80, height: 20 }
        }],
        connectionUpdates: [{
          connectionId,
          waypoints: rerouted,
          labelBounds: { x: 270, y: 150, width: 80, height: 20 }
        }]
      });
      expect(patched.isError).toBeUndefined();
      expect(patched.structuredContent).toMatchObject({
        elements: [{
          before: { bounds: task.bounds },
          after: { bounds: movedTask, labelBounds: { x: 510, y: 290, width: 80, height: 20 } }
        }],
        connections: [{
          before: { waypoints: connection.waypoints },
          after: { waypoints: rerouted, labelBounds: { x: 270, y: 150, width: 80, height: 20 } },
          endpointPolicy: 'exact'
        }],
        summary: {
          total: expect.any(Number),
          errors: expect.any(Number),
          warnings: expect.any(Number),
          byCode: expect.any(Object)
        }
      });
      expect(context.connections.get(connectionId)?.waypoints).toEqual(rerouted);
      expect(Array.from(context.document.diagram.edges.values()).find(
        edge => edge.connectionId === connectionId
      )?.waypoints).toEqual(rerouted);
    });

    it('should dry-run and roll back stale, invalid, and failed geometry patches', async () => {
      const context = diagramContext.getCurrent();
      const filename = context.filename!;
      const task = (await handler.handleRequest('get_element', {
        elementId: 'Task_1'
      })).structuredContent as any;
      const proposed = { x: 500, y: 350, width: 140, height: 90 };
      const beforeXml = context.xml;
      const beforeRevision = context.revision;
      const beforeDisk = await readFile(join(sandbox!.directory, filename), 'utf8');

      const preview = await handler.handleRequest('apply_geometry_patch', {
        elementUpdates: [{
          elementId: 'Task_1',
          bounds: proposed,
          expectedBounds: task.bounds
        }],
        dryRun: true,
        collisionPolicy: 'allow'
      });
      expect(preview.isError).toBeUndefined();
      expect(preview.structuredContent).toMatchObject({
        elements: [{ before: { bounds: task.bounds }, after: { bounds: proposed } }],
        dryRun: true,
        applied: false,
        beforeRevision,
        afterRevision: beforeRevision
      });
      expect(context.xml).toBe(beforeXml);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(beforeDisk);

      const invalid = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: beforeRevision,
        elementUpdates: [{ elementId: 'Task_1', bounds: proposed }],
        connectionUpdates: [{
          connectionId: 'Missing_Flow',
          waypoints: [{ x: 10, y: 10 }, { x: 20, y: 20 }]
        }]
      });
      expect(invalid.isError).toBe(true);
      expect(context.xml).toBe(beforeXml);
      expect(context.revision).toBe(beforeRevision);

      const engine = (handler as unknown as {
        engine: { fileManager: FileManager };
      }).engine;
      jest.spyOn(engine.fileManager, 'saveBpmnFile').mockResolvedValueOnce({
        success: false,
        error: 'injected geometry patch failure'
      });
      const failed = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: beforeRevision,
        elementUpdates: [{ elementId: 'Task_1', bounds: proposed }],
        collisionPolicy: 'allow'
      });
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain('injected geometry patch failure');
      expect(context.xml).toBe(beforeXml);
      expect(context.revision).toBe(beforeRevision);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(beforeDisk);

      const applied = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: beforeRevision,
        elementUpdates: [{ elementId: 'Task_1', bounds: proposed }],
        collisionPolicy: 'allow'
      });
      expect(applied.isError).toBeUndefined();
      const appliedXml = context.xml;
      const appliedRevision = context.revision;
      const appliedDisk = await readFile(join(sandbox!.directory, filename), 'utf8');
      const stale = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: beforeRevision,
        elementUpdates: [{ elementId: 'Task_1', bounds: task.bounds }],
        collisionPolicy: 'allow'
      });
      expect(stale).toMatchObject({
        isError: true,
        structuredContent: { code: 'revision_conflict', conflict: true }
      });
      expect(context.xml).toBe(appliedXml);
      expect(context.revision).toBe(appliedRevision);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(appliedDisk);
    });

    it('should propose a directly applicable local route and preserve unrelated geometry', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Local routing proposal' });
      const source = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Source', position: { x: 100, y: 200 }
      })).structuredContent as any;
      const obstacle = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Obstacle', position: { x: 300, y: 180 }
      })).structuredContent as any;
      const target = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Target', position: { x: 550, y: 200 }
      })).structuredContent as any;
      const connected = (await handler.handleRequest('connect', {
        sourceId: source.elementId,
        targetId: target.elementId,
        label: 'Routed flow'
      })).structuredContent as any;
      const context = diagramContext.getCurrent();
      const beforeXml = context.xml;
      const beforeRevision = context.revision;
      const beforeDisk = await readFile(join(sandbox!.directory, context.filename!), 'utf8');
      const beforeShapes = structuredClone(Array.from(context.document.diagram.shapes.entries()));
      const beforeEdges = structuredClone(Array.from(context.document.diagram.edges.entries()));

      const proposal = await handler.handleRequest('route_connection', {
        connectionId: connected.connectionId,
        avoidElementIds: [obstacle.elementId]
      });

      expect(proposal.isError).toBeUndefined();
      expect(proposal.structuredContent).toMatchObject({
        connectionId: connected.connectionId,
        proposedWaypoints: expect.any(Array),
        proposedLabelBounds: expect.any(Object),
        geometryRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        scoreBreakdown: {
          shapeCollisions: 0,
          labelCollisions: 0,
          clearanceFailures: 0,
          connectionCrossings: 0,
          bends: expect.any(Number),
          length: expect.any(Number),
          total: expect.any(Number)
        },
        diagnostics: expect.any(Array),
        introducedDiagnostics: [],
        geometryPatch: {
          expectedRevision: beforeRevision,
          elementUpdates: [],
          connectionUpdates: [{
            connectionId: connected.connectionId,
            waypoints: expect.any(Array),
            expectedGeometryRevision: expect.any(String),
            endpointPolicy: 'exact'
          }],
          collisionPolicy: 'reject-new',
          dryRun: false
        },
        clearance: 20,
        preserveOtherGeometry: true,
        apply: false,
        applied: false,
        revision: beforeRevision,
        beforeRevision,
        afterRevision: beforeRevision
      });
      expect((proposal.structuredContent as any).proposedWaypoints)
        .toEqual((proposal.structuredContent as any).geometryPatch.connectionUpdates[0].waypoints);
      expect(context.xml).toBe(beforeXml);
      expect(context.revision).toBe(beforeRevision);
      await expect(readFile(join(sandbox!.directory, context.filename!), 'utf8'))
        .resolves.toBe(beforeDisk);

      const applied = await handler.handleRequest(
        'apply_geometry_patch',
        (proposal.structuredContent as any).geometryPatch
      );
      expect(applied.isError).toBeUndefined();
      expect(context.revision).not.toBe(beforeRevision);
      expect(Array.from(context.document.diagram.shapes.entries())).toEqual(beforeShapes);
      const afterEdges = Array.from(context.document.diagram.edges.entries());
      expect(afterEdges.filter(([, edge]) => edge.connectionId !== connected.connectionId))
        .toEqual(beforeEdges.filter(([, edge]) => edge.connectionId !== connected.connectionId));
      expect(context.connections.get(connected.connectionId)?.waypoints)
        .toEqual((proposal.structuredContent as any).proposedWaypoints);
    });

    it('should route sequence, message, and data-object connections and fail without mutation', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Routing connection types' });
      const source = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Source', position: { x: 100, y: 100 }
      })).structuredContent as any;
      const target = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Target', position: { x: 500, y: 100 }
      })).structuredContent as any;
      const blocker = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Blocker', position: { x: 300, y: 100 }
      })).structuredContent as any;
      const data = (await handler.handleRequest('add_data_object', {
        name: 'Payload', position: { x: 500, y: 350 }
      })).structuredContent as any;
      const sequence = (await handler.handleRequest('connect', {
        sourceId: source.elementId, targetId: target.elementId
      })).structuredContent as any;
      const parallelSequence = (await handler.handleRequest('connect', {
        sourceId: source.elementId, targetId: target.elementId
      })).structuredContent as any;
      const association = (await handler.handleRequest('add_association', {
        sourceId: target.elementId, targetId: data.referenceId
      })).structuredContent as any;

      for (const [connectionId, args] of [
        [sequence.connectionId, {
          avoidElementIds: [blocker.elementId],
          avoidConnectionIds: [parallelSequence.connectionId]
        }],
        [association.associationId, { avoidConnectionIds: [sequence.connectionId] }]
      ] as const) {
        const result = await handler.handleRequest('route_connection', { connectionId, ...args });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          connectionId,
          scoreBreakdown: {
            shapeCollisions: 0,
            labelCollisions: 0,
            clearanceFailures: 0,
            connectionCrossings: 0
          },
          introducedDiagnostics: []
        });
        expect((result.structuredContent as any).diagnostics).not.toEqual(
          expect.arrayContaining([expect.objectContaining({
            ids: expect.arrayContaining([connectionId, ...(args.avoidConnectionIds ?? [])])
          })])
        );
      }

      const impossibleAvoid = await handler.handleRequest('route_connection', {
        connectionId: sequence.connectionId,
        avoidElementIds: [source.elementId]
      });
      expect(impossibleAvoid.isError).toBe(true);
      expect(impossibleAvoid.content[0].text).toContain('cannot avoid its endpoint');

      await handler.handleRequest('new_bpmn', {
        name: 'Message routing', type: 'collaboration'
      });
      const upperPool = (await handler.handleRequest('add_pool', {
        name: 'Upper', position: { x: 50, y: 50 }, size: { width: 700, height: 250 }
      })).structuredContent as any;
      const lowerPool = (await handler.handleRequest('add_pool', {
        name: 'Lower', position: { x: 50, y: 450 }, size: { width: 700, height: 250 }
      })).structuredContent as any;
      const sender = (await handler.handleRequest('add_activity', {
        activityType: 'sendTask', name: 'Send', ownerId: upperPool.processId,
        position: { x: 300, y: 140 }
      })).structuredContent as any;
      const receiver = (await handler.handleRequest('add_activity', {
        activityType: 'receiveTask', name: 'Receive', ownerId: lowerPool.processId,
        position: { x: 500, y: 540 }
      })).structuredContent as any;
      const message = (await handler.handleRequest('connect', {
        sourceId: sender.elementId, targetId: receiver.elementId, label: 'Payload'
      })).structuredContent as any;
      const messageDetails = (await handler.handleRequest('get_connection', {
        connectionId: message.connectionId
      })).structuredContent as any;
      const messageResult = await handler.handleRequest('route_connection', {
        connectionId: message.connectionId,
        expectedGeometryRevision: messageDetails.geometryRevision,
        apply: true
      });
      expect(messageResult.isError).toBeUndefined();
      expect(messageResult.structuredContent).toMatchObject({
        connectionId: message.connectionId,
        applied: true,
        apply: true,
        introducedDiagnostics: []
      });
      const afterApplyXml = diagramContext.getCurrent().xml;
      const afterApplyRevision = diagramContext.getCurrent().revision;
      const stale = await handler.handleRequest('route_connection', {
        connectionId: message.connectionId,
        expectedGeometryRevision: messageDetails.geometryRevision
      });
      expect(stale).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'geometry_conflict',
          reason: 'geometry_revision_mismatch',
          connectionId: message.connectionId
        }
      });
      expect(diagramContext.getCurrent().xml).toBe(afterApplyXml);
      expect(diagramContext.getCurrent().revision).toBe(afterApplyRevision);

      const routingEngine = (handler as unknown as {
        engine: { fileManager: FileManager };
      }).engine;
      jest.spyOn(routingEngine.fileManager, 'saveBpmnFile').mockResolvedValueOnce({
        success: false,
        error: 'injected route persistence failure'
      });
      const failedApply = await handler.handleRequest('route_connection', {
        connectionId: message.connectionId,
        apply: true
      });
      expect(failedApply.isError).toBe(true);
      expect(failedApply.content[0].text).toContain('injected route persistence failure');
      expect(diagramContext.getCurrent().xml).toBe(afterApplyXml);
      expect(diagramContext.getCurrent().revision).toBe(afterApplyRevision);
      await handler.handleRequest('add_text_annotation', {
        text: 'Routing barrier', position: { x: 400, y: 350 }
      });

      const beforeFailureXml = diagramContext.getCurrent().xml;
      const beforeFailureRevision = diagramContext.getCurrent().revision;
      const failure = await handler.handleRequest('route_connection', {
        connectionId: message.connectionId,
        avoidElementIds: ['TextAnnotation_1'],
        clearance: 1_000_000
      });
      expect(failure).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'routing_failed',
          connectionId: message.connectionId,
          mutated: false,
          rankedDiagnostics: expect.arrayContaining([
            expect.objectContaining({
              rank: expect.any(Number),
              scoreBreakdown: expect.any(Object),
              diagnostics: expect.any(Array)
            })
          ])
        }
      });
      expect(diagramContext.getCurrent().xml).toBe(beforeFailureXml);
      expect(diagramContext.getCurrent().revision).toBe(beforeFailureRevision);
    });

    it('should preserve all semantics and untouched imported DI through a geometry patch', async () => {
      const filename = 'geometry-patch-preservation.bpmn';
      const fixture = await readFile(join(
        process.cwd(), 'tests/fixtures/import-roundtrip/full-semantics-di.bpmn'
      ), 'utf8');
      await writeFile(join(sandbox!.directory, filename), fixture, 'utf8');
      await handler.handleRequest('open_bpmn', { filename });
      const context = diagramContext.getCurrent();
      const semanticBefore = await normalizedSemanticXml(context.xml!);
      const untouchedShapes = structuredClone(Array.from(
        context.document.diagram.shapes.entries()
      ).filter(([, shape]) => shape.elementId !== 'DataObjectReference_Request'));
      const untouchedEdges = structuredClone(Array.from(
        context.document.diagram.edges.entries()
      ).filter(([, edge]) => edge.connectionId !== 'Flow_Approved'));
      const dataObject = (await handler.handleRequest('get_element', {
        elementId: 'DataObjectReference_Request'
      })).structuredContent as any;
      const flow = (await handler.handleRequest('get_connection', {
        connectionId: 'Flow_Approved'
      })).structuredContent as any;
      const movedBounds = { ...dataObject.bounds, x: dataObject.bounds.x + 20 };
      const movedLabel = { ...flow.labelBounds, y: flow.labelBounds.y - 20 };

      const result = await handler.handleRequest('apply_geometry_patch', {
        expectedRevision: context.revision,
        elementUpdates: [{
          elementId: 'DataObjectReference_Request',
          bounds: movedBounds
        }],
        connectionUpdates: [{
          connectionId: 'Flow_Approved',
          labelBounds: movedLabel
        }],
        collisionPolicy: 'allow'
      });
      expect(result.isError).toBeUndefined();
      expect(await normalizedSemanticXml(context.xml!)).toBe(semanticBefore);
      expect(Array.from(context.document.diagram.shapes.entries()).filter(
        ([, shape]) => shape.elementId !== 'DataObjectReference_Request'
      )).toEqual(untouchedShapes);
      expect(Array.from(context.document.diagram.edges.entries()).filter(
        ([, edge]) => edge.connectionId !== 'Flow_Approved'
      )).toEqual(untouchedEdges);

      await handler.handleRequest('open_bpmn', { filename });
      const reopened = diagramContext.getCurrent();
      expect(await normalizedSemanticXml(reopened.xml!)).toBe(semanticBefore);
      expect(Array.from(reopened.document.diagram.shapes.entries()).filter(
        ([, shape]) => shape.elementId !== 'DataObjectReference_Request'
      )).toEqual(untouchedShapes);
      expect(Array.from(reopened.document.diagram.edges.entries()).filter(
        ([, edge]) => edge.connectionId !== 'Flow_Approved'
      )).toEqual(untouchedEdges);
      expect(Array.from(reopened.document.diagram.shapes.values()).find(
        shape => shape.elementId === 'DataObjectReference_Request'
      )?.bounds).toEqual(movedBounds);
      expect(Array.from(reopened.document.diagram.edges.values()).find(
        edge => edge.connectionId === 'Flow_Approved'
      )?.labelBounds).toEqual(movedLabel);
    });

    it('should reject updating a non-existent element without changing state or disk', async () => {
      const before = await snapshotQueryState();

      const result = await handler.handleRequest('update_element', {
        elementId: 'Missing_Update_Element',
        name: 'Should not appear'
      });

      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Error: Element Missing_Update_Element not found' }],
        isError: true,
        structuredContent: { code: 'element_not_found', elementId: 'Missing_Update_Element' }
      });
      await expectQueryStateUnchanged(before);

      const valid = await handler.handleRequest('update_element', {
        elementId: 'Task_1',
        name: 'Still writable'
      });
      expect(valid).toMatchObject({
        content: [{ type: 'text', text: 'Updated element Task_1' }],
        structuredContent: {
          elementId: 'Task_1',
          filename: diagramContext.getCurrent().filename,
          beforeRevision: expect.any(String),
          afterRevision: expect.any(String)
        }
      });
      expect(diagramContext.getCurrent().elements.get('Task_1')?.name).toBe('Still writable');
    });

    it('should delete an element and cascade its incoming and outgoing connections', async () => {
      await handler.handleRequest('connect', { sourceId: 'StartEvent_1', targetId: 'Task_1' });
      await handler.handleRequest('connect', { sourceId: 'Task_1', targetId: 'EndEvent_1' });
      const context = diagramContext.getCurrent();
      const removedConnectionIds = Array.from(context.connections.keys());

      const result = await handler.handleRequest('delete_element', { elementId: 'Task_1' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Deleted element Task_1 and 2 associated connections');
      expect(context.elements.has('Task_1')).toBe(false);
      expect(Array.from(context.elements.keys()).sort()).toEqual(['EndEvent_1', 'StartEvent_1']);
      expect(context.connections.size).toBe(0);
      expect(context.xml).not.toContain('Task_1');
      for (const connectionId of removedConnectionIds) {
        expect(context.xml).not.toContain(connectionId);
      }
      await expect(readFile(join(sandbox!.directory, context.filename!), 'utf8'))
        .resolves.toBe(context.xml);
    });

    it('should reject deleting a non-existent element without changing state or disk', async () => {
      const before = await snapshotQueryState();

      const result = await handler.handleRequest('delete_element', {
        elementId: 'Missing_Delete_Element'
      });

      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Error: Element Missing_Delete_Element not found' }],
        isError: true,
        structuredContent: { code: 'element_not_found', elementId: 'Missing_Delete_Element' }
      });
      await expectQueryStateUnchanged(before);

      const valid = await handler.handleRequest('delete_element', { elementId: 'Task_1' });
      expect(valid).toMatchObject({
        content: [{
          type: 'text',
          text: 'Deleted element Task_1 and 0 associated connections'
        }],
        structuredContent: {
          elementId: 'Task_1',
          deletedKind: 'element',
          removedConnectionCount: 0,
          filename: diagramContext.getCurrent().filename,
          beforeRevision: expect.any(String),
          afterRevision: expect.any(String)
        }
      });
      expect(diagramContext.getCurrent().elements.has('Task_1')).toBe(false);
    });
  });

  describe('File and export operations', () => {
  describe('export', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Export Test Process'
      });

      // Add some elements
      await handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Start'
      });

      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Do Work'
      });
      
      await handler.handleRequest('connect', {
        sourceId: 'StartEvent_1',
        targetId: 'Task_1'
      });
    });

    it('should export as XML', async () => {
      const result = await handler.handleRequest('export', {
        format: 'xml'
      });

      expect(result.isError).toBeUndefined();
      const xml = result.content[0].text;
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('bpmn:definitions');
      expect(xml).toContain('Export Test Process');
      expect(xml).toContain('bpmn:startEvent');
      expect(xml).toContain('bpmn:task');
    });

  });

  describe('file lifecycle', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', { name: 'File Test' });
    });

    it('should save the active XML to its generated sandbox filename', async () => {
      const filename = diagramContext.getCurrentInfo()?.filename;
      if (!filename) throw new Error('Expected an active filename');

      const result = await handler.handleRequest('save', {});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(`Saved diagram "File Test" to ${filename}`);
      const savedXml = await readFile(join(sandbox!.directory, filename), 'utf8');
      expect(savedXml).toBe(diagramContext.getCurrent().xml);
      expect(savedXml).toContain('<bpmn:process');
    });

    it('should reject save when there is no active context', async () => {
      diagramContext.clear();
      const filesBefore = await readdir(sandbox!.directory);

      const result = await handler.handleRequest('save', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No diagram is currently open');
      expect(diagramContext.hasCurrent()).toBe(false);
      expect(await readdir(sandbox!.directory)).toEqual(filesBefore);
    });

    it('should reject save when the active context has no filename', async () => {
      const context = diagramContext.getCurrent();
      const originalFilename = context.filename!;
      const persistedXml = await readFile(join(sandbox!.directory, originalFilename), 'utf8');
      context.filename = undefined;

      const result = await handler.handleRequest('save', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('has no filename');
      expect(context.filename).toBeUndefined();
      await expect(readFile(join(sandbox!.directory, originalFilename), 'utf8'))
        .resolves.toBe(persistedXml);
    });

    it('should report a write failure without changing the active file or state', async () => {
      const context = diagramContext.getCurrent();
      const filename = context.filename!;
      const beforeXml = context.xml;
      const beforeDisk = await readFile(join(sandbox!.directory, filename), 'utf8');
      const engine = (handler as unknown as {
        engine: { fileManager: FileManager };
      }).engine;
      jest.spyOn(engine.fileManager, 'saveBpmnFile').mockResolvedValueOnce({
        success: false,
        error: 'injected handler save failure'
      });

      const result = await handler.handleRequest('save', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('injected handler save failure');
      expect(context.xml).toBe(beforeXml);
      expect(context.filename).toBe(filename);
      await expect(readFile(join(sandbox!.directory, filename), 'utf8')).resolves.toBe(beforeDisk);
    });

    it('should save as and delete a unique sandbox file', async () => {
      const filename = sandbox!.uniqueFilename('handler-save-as');
      const saved = await handler.handleRequest('save_as', { filename });

      expect(saved.isError).toBeUndefined();
      expect(saved.content[0].text)
        .toContain(`Saved diagram "File Test" as ${filename}`);
      // The generated placeholder goes with the rename (mcp-bpmn-8u0.2).
      expect(saved.structuredContent).toMatchObject({ removedPreviousFile: true });
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .resolves.toContain('<bpmn:process');

      const deleted = await handler.handleRequest('delete_diagram_file', { filename });
      expect(deleted.isError).toBeUndefined();
      await expect(readFile(join(sandbox!.directory, filename), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('should close the active diagram and clear current state', async () => {
      const result = await handler.handleRequest('close', {});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Closed diagram "File Test"');
      expect(diagramContext.hasCurrent()).toBe(false);
      const current = await handler.handleRequest('current', {});
      expect(current.content[0].text).toBe('No current diagram');
    });
  });

  describe('diagram storage utilities', () => {
    it('should list an empty sandbox with stable pagination metadata', async () => {
      const result = await handler.handleRequest('list_diagrams', {});
      const listing = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(listing).toEqual({
        count: 0,
        returnedCount: 0,
        offset: 0,
        limit: 100,
        hasMore: false,
        diagrams: [],
        path: sandbox!.directory
      });
    });

    it('should list populated sandbox diagrams in stable filename order', async () => {
      await handler.handleRequest('new_bpmn', { name: 'First listed diagram' });
      const first = { ...diagramContext.getCurrentInfo()! };
      await handler.handleRequest('new_bpmn', { name: 'Second listed diagram' });
      const second = { ...diagramContext.getCurrentInfo()! };
      const expected = [first, second]
        .map(info => ({
          filename: info.filename,
          path: join(sandbox!.directory, info.filename!),
          name: info.name,
          processId: info.processId
        }))
        .sort((left, right) => left.filename!.localeCompare(right.filename!));

      const result = await handler.handleRequest('list_diagrams', {});
      const listing = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(listing).toMatchObject({
        count: 2,
        returnedCount: 2,
        offset: 0,
        limit: 100,
        hasMore: false,
        path: sandbox!.directory
      });
      expect(listing.diagrams).toEqual(expected);
    });

    it('should return the exact isolated diagrams path', async () => {
      const result = await handler.handleRequest('get_diagrams_path', {});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(
        `BPMN diagrams are saved to: ${sandbox!.directory}\n\n`
        + 'You can set a custom path using the environment variable: MCP_BPMN_DIAGRAMS_PATH'
      );
    });
  });
  });

  describe('Validation operations', () => {
    beforeEach(async () => {
      await handler.handleRequest('new_bpmn', {
        name: 'Validation Test Process'
      });
    });

    it('should report non-fatal executable-profile guidance for an empty process', async () => {
      const result = await handler.handleRequest('validate', {});

      expect(result.isError).toBeUndefined();
      const validation = JSON.parse(result.content[0].text as string);
      expect(validation.valid).toBe(true);
      expect(validation.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'BPMN_PROFILE_MISSING_START_EVENT' }),
        expect.objectContaining({ code: 'BPMN_PROFILE_MISSING_END_EVENT' })
      ]));
    });

    it('should validate complete process', async () => {
      // Add start and end events
      await handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Start'
      });

      await handler.handleRequest('add_event', {
        eventType: 'end',
        name: 'End'
      });
      
      await handler.handleRequest('connect', {
        sourceId: 'StartEvent_1',
        targetId: 'EndEvent_1'
      });

      const result = await handler.handleRequest('validate', {});

      expect(result.isError).toBeUndefined();
      const validation = JSON.parse(result.content[0].text as string);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  describe('Error handling', () => {
    it('should handle unknown tool', async () => {
      const result = await handler.handleRequest('unknown_tool', {});
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error: Unknown tool: unknown_tool');
    });
  });

  describe('pool placement and sizing defaults', () => {
    const poolBounds = (poolId: string): { x: number; y: number; width: number; height: number } => {
      const element = diagramContext.getCurrent().elements.get(poolId)!;
      return { ...element.position, ...element.size };
    };

    it('stacks pools created without a position instead of overlapping them', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Stacked', type: 'collaboration' });
      const first = (await handler.handleRequest('add_pool', { name: 'Customer' }))
        .structuredContent as { elementId: string };
      const second = (await handler.handleRequest('add_pool', { name: 'Supplier' }))
        .structuredContent as { elementId: string };

      const top = poolBounds(first.elementId);
      const bottom = poolBounds(second.elementId);

      expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height);
      expect(bottom.x).toBe(top.x);
    });

    it('does not treat the default pool size as a layout floor', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Defaulted', type: 'collaboration' });
      const pool = (await handler.handleRequest('add_pool', { name: 'Only' }))
        .structuredContent as { elementId: string; processId: string };
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'One step',
        ownerId: pool.processId
      });

      // Before layout the element still carries the placeholder default.
      expect(poolBounds(pool.elementId).height).toBe(250);

      await handler.handleRequest('auto_layout', {});

      // Layout is free to size a single-row pool to its content plus the
      // white-box minimum, because 250 was never requested.
      expect(poolBounds(pool.elementId).height).toBeLessThan(250);
      expect(poolBounds(pool.elementId).height).toBeGreaterThanOrEqual(150);
    });

    it('honours an explicitly requested pool size as a lower bound', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Requested', type: 'collaboration' });
      const pool = (await handler.handleRequest('add_pool', {
        name: 'Only',
        size: { width: 900, height: 400 }
      })).structuredContent as { elementId: string; processId: string };
      await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'One step',
        ownerId: pool.processId
      });

      await handler.handleRequest('auto_layout', {});

      const bounds = poolBounds(pool.elementId);
      expect(bounds.height).toBeGreaterThanOrEqual(400);
      expect(bounds.width).toBeGreaterThanOrEqual(900);
    });
  });

  describe('caller-chosen filenames', () => {
    it('creates a new diagram directly under the requested filename', async () => {
      const created = await handler.handleRequest('new_bpmn', {
        name: 'Named',
        filename: 'approval-process.bpmn'
      });

      expect(created.isError).toBeUndefined();
      expect(created.structuredContent).toMatchObject({ filename: 'approval-process.bpmn' });

      const listed = await handler.handleRequest('list_diagrams', {});
      const listing = JSON.parse(listed.content[0].text as string);
      const filenames = listing.diagrams.map((diagram: { filename: string }) => diagram.filename);
      expect(filenames).toContain('approval-process.bpmn');
      // No placeholder was ever written, so there is nothing to clean up.
      expect(filenames.filter((f: string) => f.startsWith('mcp-bpmn-v1_'))).toEqual([]);
    });

    it('appends the .bpmn extension to a requested name that omits it', async () => {
      const created = await handler.handleRequest('new_bpmn', {
        name: 'Named',
        filename: 'no-extension'
      });

      expect(created.structuredContent).toMatchObject({ filename: 'no-extension.bpmn' });
    });

    it('keeps a caller-chosen filename when save_as renames the diagram', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Named', filename: 'first-name.bpmn' });

      const saved = await handler.handleRequest('save_as', { filename: 'second-name.bpmn' });

      expect(saved.structuredContent).toMatchObject({
        filename: 'second-name.bpmn',
        previousFilename: 'first-name.bpmn',
        removedPreviousFile: false
      });
      const listed = await handler.handleRequest('list_diagrams', {});
      const listing = JSON.parse(listed.content[0].text as string);
      const filenames = listing.diagrams.map((diagram: { filename: string }) => diagram.filename);
      expect(filenames).toEqual(expect.arrayContaining(['first-name.bpmn', 'second-name.bpmn']));
    });
  });

  describe('build_process', () => {
    it('creates a whole process, resolving refs to server IDs, in one call', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Bulk' });

      const built = await handler.handleRequest('build_process', {
        nodes: [
          { kind: 'event', ref: 'start', eventType: 'start', name: 'Request received' },
          { kind: 'activity', ref: 'review', activityType: 'userTask', name: 'Review' },
          { kind: 'gateway', ref: 'decide', gatewayType: 'exclusive', name: 'Approved?' },
          { kind: 'activity', ref: 'pay', activityType: 'serviceTask', name: 'Pay' },
          { kind: 'activity', ref: 'reject', activityType: 'task', name: 'Reject' },
          { kind: 'event', ref: 'done', eventType: 'end', name: 'Done' }
        ],
        flows: [
          { source: 'start', target: 'review' },
          { source: 'review', target: 'decide' },
          { source: 'decide', target: 'pay', label: 'yes', condition: '${approved}' },
          { source: 'decide', target: 'reject', label: 'no', isDefault: true },
          { source: 'pay', target: 'done' },
          { source: 'reject', target: 'done' }
        ]
      });

      expect(built.isError).toBeUndefined();
      const structured = built.structuredContent as {
        elements: Array<{ ref: string; elementId: string; type: string }>;
        connections: Array<{ connectionId: string }>;
        elementCount: number;
        connectionCount: number;
      };
      expect(structured.elementCount).toBe(6);
      expect(structured.connectionCount).toBe(6);

      const byRef = new Map(structured.elements.map(e => [e.ref, e]));
      expect(byRef.get('review')!.type).toBe('bpmn:UserTask');
      expect(byRef.get('decide')!.type).toBe('bpmn:ExclusiveGateway');
      expect(byRef.get('start')!.type).toBe('bpmn:StartEvent');
      // Refs are caller-side only and never leak into the document.
      for (const ref of byRef.keys()) {
        expect(diagramContext.getCurrent().elements.has(ref)).toBe(false);
      }

      const validated = await handler.handleRequest('validate', { level: 'full' });
      expect(JSON.parse(validated.content[0].text as string).valid).toBe(true);
    });

    it('connects to elements that already exist alongside new refs', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Mixed' });
      const existing = (await handler.handleRequest('add_event', {
        eventType: 'start', name: 'Existing start'
      })).structuredContent as { elementId: string };

      const built = await handler.handleRequest('build_process', {
        nodes: [{ kind: 'activity', ref: 'next', activityType: 'task', name: 'Next' }],
        flows: [{ source: existing.elementId, target: 'next' }]
      });

      expect(built.isError).toBeUndefined();
      const structured = built.structuredContent as {
        connections: Array<{ sourceId: string; targetId: string }>;
      };
      expect(structured.connections[0].sourceId).toBe(existing.elementId);
    });

    it('writes nothing when a later step fails', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Atomic' });
      const before = diagramContext.getCurrent();
      const beforeRevision = before.revision;
      const beforeXml = before.xml;

      const built = await handler.handleRequest('build_process', {
        nodes: [
          { kind: 'event', ref: 'start', eventType: 'start', name: 'Start' },
          { kind: 'activity', ref: 'work', activityType: 'task', name: 'Work' }
        ],
        flows: [
          { source: 'start', target: 'work' },
          { source: 'work', target: 'nowhere' }
        ]
      });

      expect(built.isError).toBe(true);
      expect(built.content[0].text).toContain('flows[1]');
      expect(built.content[0].text).toContain('nowhere');
      // The two valid nodes and the valid flow are rolled back with the batch.
      expect(diagramContext.getCurrent().elements.size).toBe(0);
      expect(diagramContext.getCurrent().connections.size).toBe(0);
      expect(diagramContext.getCurrent().revision).toBe(beforeRevision);
      expect(diagramContext.getCurrent().xml).toBe(beforeXml);
    });

    it('reports which node failed validation without partially building', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Bad node' });

      const built = await handler.handleRequest('build_process', {
        nodes: [
          { kind: 'activity', ref: 'ok', activityType: 'task', name: 'Fine' },
          { kind: 'event', ref: 'bad', eventType: 'boundary', name: 'Orphan boundary' }
        ],
        flows: []
      });

      expect(built.isError).toBe(true);
      expect(built.content[0].text).toContain('nodes[1]');
      expect(built.content[0].text).toContain('bad');
      expect(diagramContext.getCurrent().elements.size).toBe(0);
    });

    it('rejects a ref that collides with an existing element id', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Collide' });
      const existing = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'First'
      })).structuredContent as { elementId: string };

      const built = await handler.handleRequest('build_process', {
        nodes: [{ kind: 'activity', ref: existing.elementId, activityType: 'task', name: 'Clash' }],
        flows: []
      });

      expect(built.isError).toBe(true);
      expect(built.content[0].text).toContain('existing element id');
    });

    it('rejects duplicate refs before touching the diagram', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Dupes' });

      const built = await handler.handleRequest('build_process', {
        nodes: [
          { kind: 'activity', ref: 'same', activityType: 'task', name: 'One' },
          { kind: 'activity', ref: 'same', activityType: 'task', name: 'Two' }
        ],
        flows: []
      });

      expect(built.isError).toBe(true);
      expect(built.structuredContent).toMatchObject({ code: 'invalid_arguments' });
      expect(diagramContext.getCurrent().elements.size).toBe(0);
    });
  });

  describe('documentation, annotation text, and save_as overwrite', () => {
    const xmlOf = async (): Promise<string> => {
      const exported = await handler.handleRequest('export', { format: 'xml' });
      return exported.content[0].text as string;
    };

    it('carries bpmn:documentation from creation through export and reopen', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Documented', filename: 'documented.bpmn' });
      const task = (await handler.handleRequest('add_activity', {
        activityType: 'userTask',
        name: 'Review claim',
        documentation: 'Assessor checks the claim against policy limits.'
      })).structuredContent as { elementId: string };
      const start = (await handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Claim filed',
        documentation: 'Raised by the customer portal.'
      })).structuredContent as { elementId: string };
      await handler.handleRequest('connect', {
        sourceId: start.elementId,
        targetId: task.elementId,
        documentation: 'Straight through, no triage.'
      });

      const xml = await xmlOf();
      expect(xml).toContain('<bpmn:documentation>Assessor checks the claim');
      expect(xml).toContain('<bpmn:documentation>Raised by the customer portal.');
      expect(xml).toContain('<bpmn:documentation>Straight through, no triage.');

      await handler.handleRequest('close', {});
      await handler.handleRequest('open_bpmn', { filename: 'documented.bpmn' });
      const reopened = await handler.handleRequest('get_element', { elementId: task.elementId });
      expect((reopened.structuredContent as any).properties.documentation)
        .toBe('Assessor checks the claim against policy limits.');
    });

    it('edits documentation with update_element', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Edit docs' });
      const task = (await handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Step',
        documentation: 'First wording.'
      })).structuredContent as { elementId: string };

      await handler.handleRequest('update_element', {
        elementId: task.elementId,
        documentation: 'Corrected wording.'
      });

      const xml = await xmlOf();
      expect(xml).toContain('<bpmn:documentation>Corrected wording.');
      expect(xml).not.toContain('First wording.');
    });

    it('edits the text of an existing annotation instead of forcing delete and recreate', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Annotation edit' });
      const annotation = (await handler.handleRequest('add_text_annotation', {
        text: 'Needs sign-off'
      })).structuredContent as { annotationId: string };

      const updated = await handler.handleRequest('update_element', {
        elementId: annotation.annotationId,
        properties: { text: 'Needs two sign-offs' }
      });

      expect(updated.isError).toBeUndefined();
      const xml = await xmlOf();
      expect(xml).toContain('Needs two sign-offs');
      expect(xml).not.toContain('Needs sign-off<');
    });

    it('replaces an existing file only when save_as asks for it', async () => {
      await handler.handleRequest('new_bpmn', { name: 'First', filename: 'target.bpmn' });
      await handler.handleRequest('close', {});
      await handler.handleRequest('new_bpmn', { name: 'Second' });

      const refused = await handler.handleRequest('save_as', { filename: 'target.bpmn' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('already exists');

      const replaced = await handler.handleRequest('save_as', {
        filename: 'target.bpmn',
        overwrite: true
      });
      expect(replaced.isError).toBeUndefined();
      expect(replaced.structuredContent).toMatchObject({ filename: 'target.bpmn' });

      await handler.handleRequest('close', {});
      const reopened = await handler.handleRequest('open_bpmn', { filename: 'target.bpmn' });
      expect((reopened.structuredContent as any).name).toBe('Second');
    });

    it('updates a connection label without first fetching its revision', async () => {
      await handler.handleRequest('new_bpmn', { name: 'No revision' });
      const start = (await handler.handleRequest('add_event', { eventType: 'start' }))
        .structuredContent as { elementId: string };
      const task = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Work'
      })).structuredContent as { elementId: string };
      const flow = (await handler.handleRequest('connect', {
        sourceId: start.elementId,
        targetId: task.elementId
      })).structuredContent as { connectionId: string };

      // One call, no get_connection round trip first (mcp-bpmn-8u0.7).
      const updated = await handler.handleRequest('update_connection', {
        connectionId: flow.connectionId,
        label: 'Approved'
      });

      expect(updated.isError).toBeUndefined();
      expect(await xmlOf()).toContain('name="Approved"');
    });

    it('still rejects a stale revision when one is supplied', async () => {
      await handler.handleRequest('new_bpmn', { name: 'Stale revision' });
      const start = (await handler.handleRequest('add_event', { eventType: 'start' }))
        .structuredContent as { elementId: string };
      const task = (await handler.handleRequest('add_activity', {
        activityType: 'task', name: 'Work'
      })).structuredContent as { elementId: string };
      const flow = (await handler.handleRequest('connect', {
        sourceId: start.elementId,
        targetId: task.elementId
      })).structuredContent as { connectionId: string };

      const stale = await handler.handleRequest('update_connection', {
        connectionId: flow.connectionId,
        label: 'Approved',
        expectedRevision: `sha256:${'a'.repeat(64)}:v1`
      });

      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({ code: 'revision_conflict' });
    });
  });
});
