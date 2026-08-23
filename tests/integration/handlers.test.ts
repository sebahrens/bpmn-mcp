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
      expect(result.content[0].text).toContain('Pools can only be added to collaborations');
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
      expect(result.content[0].text).toContain('No current context');
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
        'Deleted element TextAnnotation_1 and 1 associated connections'
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
      const result = await handler.handleRequest('connect', {
        sourceId: 'invalid-source',
        targetId: 'invalid-target'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error: Source or target element not found');
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
      expect(result.content[0].text).toContain('Applied horizontal auto-layout');
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
        hasMore: false
      });
    });

    it('should return element identity, type, and name', async () => {
      const result = await handler.handleRequest('get_element', { elementId: 'Task_1' });
      const details = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(details).toMatchObject({
        id: 'Task_1',
        type: 'bpmn:Task',
        name: 'Task'
      });
    });

    it('should reject getting a non-existent element without changing state or disk', async () => {
      const before = await snapshotQueryState();

      const result = await handler.handleRequest('get_element', {
        elementId: 'Missing_Get_Element'
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Element Missing_Get_Element not found' }],
        isError: true
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

    it('should reject updating a non-existent element without changing state or disk', async () => {
      const before = await snapshotQueryState();

      const result = await handler.handleRequest('update_element', {
        elementId: 'Missing_Update_Element',
        name: 'Should not appear'
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Element Missing_Update_Element not found' }],
        isError: true
      });
      await expectQueryStateUnchanged(before);

      const valid = await handler.handleRequest('update_element', {
        elementId: 'Task_1',
        name: 'Still writable'
      });
      expect(valid).toEqual({
        content: [{ type: 'text', text: 'Updated element Task_1' }],
        structuredContent: {
          elementId: 'Task_1',
          filename: diagramContext.getCurrent().filename
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

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Element Missing_Delete_Element not found' }],
        isError: true
      });
      await expectQueryStateUnchanged(before);

      const valid = await handler.handleRequest('delete_element', { elementId: 'Task_1' });
      expect(valid).toEqual({
        content: [{
          type: 'text',
          text: 'Deleted element Task_1 and 0 associated connections'
        }],
        structuredContent: {
          elementId: 'Task_1',
          deletedKind: 'element',
          removedConnectionCount: 0,
          filename: diagramContext.getCurrent().filename
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
      expect(result.content[0].text).toContain('No current diagram to save');
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
      expect(result.content[0].text).toContain('No filename set');
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
      expect(saved.content[0].text).toBe(`Saved diagram "File Test" as ${filename}`);
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
});
