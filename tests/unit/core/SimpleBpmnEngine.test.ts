import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import BpmnModdle from 'bpmn-moddle';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { BpmnValidator } from '../../../src/core/BpmnValidator.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { IdGenerator } from '../../../src/utils/IdGenerator.js';

interface SemanticSummary {
  roots: Array<{ id: string; type: string }>;
  elements: Array<{ id: string; type: string }>;
  connections: Array<{ id: string; type: string; source: string; target: string }>;
  planeTarget: string;
  shapes: Array<{ id: string; element: string }>;
  edges: Array<{ id: string; element: string; waypoints: Array<{ x: number; y: number }> }>;
}

describe('SimpleBpmnEngine schema-aware document model', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;
  let handler: BpmnRequestHandler;
  const moddle = new BpmnModdle();

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-document-'));
    IdGenerator.reset();
    diagramContext.clear();
    engine = new SimpleBpmnEngine(directory);
    handler = new BpmnRequestHandler(engine);
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const exportedDefinitions = async (): Promise<any> => {
    const result = await handler.handleRequest('export', {});
    expect(result.isError).toBeUndefined();
    return (await moddle.fromXML(result.content[0].text as string)).rootElement;
  };

  const findSemantic = (definitions: any, id: string): any => {
    for (const root of definitions.rootElements || []) {
      if (root.id === id) return root;
      for (const participant of root.participants || []) {
        if (participant.id === id) return participant;
      }
      const pending = [...(root.flowElements || []), ...(root.artifacts || [])];
      while (pending.length > 0) {
        const current = pending.shift();
        if (current.id === id) return current;
        pending.push(...(current.flowElements || []), ...(current.artifacts || []));
      }
    }
    return undefined;
  };

  const expectSemanticShape = (definitions: any, id: string, expectedType: string): void => {
    const semantic = findSemantic(definitions, id);
    expect(semantic?.$type).toBe(expectedType);
    const shape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNShape' && item.bpmnElement?.id === id
    );
    expect(shape?.bpmnElement).toBe(semantic);
    expect(shape?.bounds).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number)
    }));
  };

  const summarize = (definitions: any): SemanticSummary => {
    const elements: SemanticSummary['elements'] = [];
    const connections: SemanticSummary['connections'] = [];
    const visit = (items: any[]): void => {
      for (const item of items) {
        if (['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association'].includes(item.$type)) {
          connections.push({
            id: item.id,
            type: item.$type,
            source: item.sourceRef?.id,
            target: item.targetRef?.id
          });
        } else {
          elements.push({ id: item.id, type: item.$type });
          visit(item.flowElements || []);
        }
      }
    };

    for (const root of definitions.rootElements || []) {
      visit(root.flowElements || []);
      visit(root.participants || []);
      visit(root.messageFlows || []);
      visit(root.artifacts || []);
    }
    const plane = definitions.diagrams[0].plane;
    return {
      roots: definitions.rootElements.map((root: any) => ({ id: root.id, type: root.$type }))
        .sort((left: any, right: any) => left.id.localeCompare(right.id)),
      elements: elements.sort((left, right) => left.id.localeCompare(right.id)),
      connections: connections.sort((left, right) => left.id.localeCompare(right.id)),
      planeTarget: plane.bpmnElement.id,
      shapes: plane.planeElement
        .filter((item: any) => item.$type === 'bpmndi:BPMNShape')
        .map((item: any) => ({ id: item.id, element: item.bpmnElement.id }))
        .sort((left: any, right: any) => left.id.localeCompare(right.id)),
      edges: plane.planeElement
        .filter((item: any) => item.$type === 'bpmndi:BPMNEdge')
        .map((item: any) => ({
          id: item.id,
          element: item.bpmnElement.id,
          waypoints: item.waypoint.map((point: any) => ({ x: point.x, y: point.y }))
        }))
        .sort((left: any, right: any) => left.id.localeCompare(right.id))
    };
  };

  it.each([
    ['start', 'bpmn:StartEvent'],
    ['end', 'bpmn:EndEvent'],
    ['intermediate-throw', 'bpmn:IntermediateThrowEvent'],
    ['intermediate-catch', 'bpmn:IntermediateCatchEvent']
  ])('serializes advertised event %s as %s', async (eventType, expectedType) => {
    await handler.handleRequest('new_bpmn', { name: 'Event types' });
    const result = await handler.handleRequest('add_event', { eventType, name: eventType });
    expect(result.isError).toBeUndefined();
    const id = (result.content[0].text as string).split('ID: ')[1];
    expectSemanticShape(await exportedDefinitions(), id, expectedType);
  });

  it('serializes advertised boundary events with an activity reference', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Boundary event' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Attached activity' });
    const result = await handler.handleRequest('add_event', {
      eventType: 'boundary',
      name: 'Timeout',
      attachTo: 'Task_1'
    });
    expect(result.isError).toBeUndefined();
    const boundary = findSemantic(await exportedDefinitions(), 'BoundaryEvent_1');
    expect(boundary.$type).toBe('bpmn:BoundaryEvent');
    expect(boundary.attachedToRef.id).toBe('Task_1');
    expect(boundary.cancelActivity).toBe(true);

    const definitions = await exportedDefinitions();
    const taskShape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === 'Task_1'
    );
    const boundaryShape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === 'BoundaryEvent_1'
    );
    expect(boundaryShape.bounds.x + boundaryShape.bounds.width / 2)
      .toBe(taskShape.bounds.x + taskShape.bounds.width / 2);
    expect(boundaryShape.bounds.y + boundaryShape.bounds.height / 2)
      .toBe(taskShape.bounds.y + taskShape.bounds.height);

    await engine.deleteElement(diagramContext.getCurrent().id, 'Task_1');
    const afterDelete = await exportedDefinitions();
    expect(findSemantic(afterDelete, 'Task_1')).toBeUndefined();
    expect(findSemantic(afterDelete, 'BoundaryEvent_1')).toBeUndefined();
  });

  it.each([
    ['a missing attachment', { eventType: 'boundary' }, 'require attachTo'],
    ['a non-activity attachment', { eventType: 'boundary', attachTo: 'StartEvent_1' },
      'existing activity'],
    ['attachTo on a non-boundary event', { eventType: 'end', attachTo: 'Task_1' },
      'only valid on boundary events'],
    ['a cancel boundary on a regular task', {
      eventType: 'boundary', eventDefinition: 'cancel', attachTo: 'Task_1'
    }, 'only attach to a transaction']
  ])('rejects %s before mutation', async (_caseName, args, expectedError) => {
    await handler.handleRequest('new_bpmn', { name: 'Invalid boundary' });
    await handler.handleRequest('add_event', { eventType: 'start', name: 'Not an activity' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Regular task' });
    const context = diagramContext.getCurrent();
    const beforeXml = await engine.exportXml(context.id);
    const beforeElements = Array.from(context.elements.entries());

    const result = await handler.handleRequest('add_event', args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(expectedError);
    expect(Array.from(context.elements.entries())).toEqual(beforeElements);
    expect(await engine.exportXml(context.id)).toBe(beforeXml);
  });

  it('preserves boundary attachment and interruption semantics through reopen and mutation', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Persistent boundary' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Attached activity' });
    await handler.handleRequest('add_event', {
      eventType: 'boundary',
      eventDefinition: 'timer',
      eventDefinitionPayload: {
        timer: { type: 'timeDuration', expression: 'PT5M' }
      },
      attachTo: 'Task_1',
      cancelActivity: false
    });
    const original = diagramContext.getCurrent();
    const filename = engine.getActiveFilename(original.id);

    engine.clear();
    const reopened = await engine.loadDiagram(filename);
    expect(reopened.elements.get('BoundaryEvent_1')?.properties).toMatchObject({
      attachTo: 'Task_1',
      cancelActivity: false
    });
    await engine.updateElement(reopened.id, 'Task_1', { name: 'Updated attached activity' });

    const definitions = (await moddle.fromXML(await engine.exportXml(reopened.id))).rootElement;
    const boundary = findSemantic(definitions, 'BoundaryEvent_1');
    expect(boundary.attachedToRef).toBe(findSemantic(definitions, 'Task_1'));
    expect(boundary.cancelActivity).toBe(false);
    expect(findSemantic(definitions, 'Task_1').name).toBe('Updated attached activity');
  });

  it.each([
    ['message', 'start', 'bpmn:MessageEventDefinition', { reference: { name: 'Notice' } }],
    ['timer', 'intermediate-catch', 'bpmn:TimerEventDefinition', {
      timer: { type: 'timeDuration', expression: 'PT15M', language: 'ISO-8601' }
    }],
    ['error', 'end', 'bpmn:ErrorEventDefinition', {
      reference: { name: 'Rejected', code: 'ORDER_REJECTED' }
    }],
    ['signal', 'intermediate-throw', 'bpmn:SignalEventDefinition', {
      reference: { name: 'Order shipped' }
    }],
    ['conditional', 'intermediate-catch', 'bpmn:ConditionalEventDefinition', {
      condition: { expression: '${approved}', language: 'FEEL' }
    }],
    ['escalation', 'intermediate-throw', 'bpmn:EscalationEventDefinition', {
      reference: { name: 'Review needed', code: 'REVIEW' }
    }],
    ['compensation', 'intermediate-throw', 'bpmn:CompensateEventDefinition', {}],
    ['cancel', 'end', 'bpmn:CancelEventDefinition', {}],
    ['terminate', 'end', 'bpmn:TerminateEventDefinition', {}]
  ])('serializes advertised %s definition on %s as %s', async (
    eventDefinition,
    eventType,
    expectedType,
    eventDefinitionPayload
  ) => {
    await handler.handleRequest('new_bpmn', { name: 'Event definitions' });
    const result = await handler.handleRequest('add_event', {
      eventType,
      eventDefinition,
      eventDefinitionPayload,
      name: eventDefinition
    });
    expect(result.isError).toBeUndefined();
    const id = (result.content[0].text as string).split('ID: ')[1];
    const definition = findSemantic(await exportedDefinitions(), id).eventDefinitions[0];
    expect(definition.$type).toBe(expectedType);
    expect(definition.id).toMatch(/EventDefinition_/);
    const referenceProperty = ({
      message: 'messageRef',
      signal: 'signalRef',
      error: 'errorRef',
      escalation: 'escalationRef'
    } as Record<string, string>)[eventDefinition];
    if (referenceProperty) {
      expect(definition[referenceProperty]?.id).toBeTruthy();
      expect((await exportedDefinitions()).rootElements).toContainEqual(
        expect.objectContaining({ id: definition[referenceProperty].id })
      );
    }
  });

  it('serializes timer and conditional payloads instead of empty definition tags', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Payload events' });
    await handler.handleRequest('add_event', {
      eventType: 'intermediate-catch',
      eventDefinition: 'timer',
      eventDefinitionPayload: {
        timer: { type: 'timeCycle', expression: 'R3/PT10M', language: 'ISO-8601' }
      }
    });
    await handler.handleRequest('add_event', {
      eventType: 'intermediate-catch',
      eventDefinition: 'conditional',
      eventDefinitionPayload: {
        condition: { expression: '${amount > 100}', language: 'FEEL' }
      }
    });

    const definitions = await exportedDefinitions();
    const timer = findSemantic(definitions, 'IntermediateCatchEvent_1').eventDefinitions[0];
    const conditional = findSemantic(definitions, 'IntermediateCatchEvent_2').eventDefinitions[0];
    expect(timer.timeCycle).toMatchObject({
      $type: 'bpmn:FormalExpression',
      body: 'R3/PT10M',
      language: 'ISO-8601'
    });
    expect(conditional.condition).toMatchObject({
      $type: 'bpmn:FormalExpression',
      body: '${amount > 100}',
      language: 'FEEL'
    });
  });

  it('serializes the complete legal event matrix and rejects every disallowed pairing', async () => {
    const eventMatrix = {
      start: ['message', 'timer', 'conditional', 'signal'],
      end: ['message', 'error', 'escalation', 'cancel', 'compensation', 'signal', 'terminate'],
      'intermediate-catch': ['message', 'timer', 'conditional', 'signal'],
      'intermediate-throw': ['message', 'escalation', 'compensation', 'signal'],
      boundary: ['message', 'timer', 'conditional', 'signal', 'error', 'escalation', 'cancel', 'compensation']
    } as const;
    const allDefinitions = [
      'message', 'timer', 'error', 'signal', 'conditional', 'escalation',
      'compensation', 'cancel', 'terminate'
    ] as const;
    const payloadFor = (definition: typeof allDefinitions[number]) => {
      if (definition === 'timer') {
        return { timer: { type: 'timeDuration', expression: 'PT1M' } };
      }
      if (definition === 'conditional') {
        return { condition: { expression: '${ready}' } };
      }
      if (['message', 'signal', 'error', 'escalation'].includes(definition)) {
        return { reference: { name: `${definition} root` } };
      }
      return {};
    };

    await handler.handleRequest('new_bpmn', { name: 'Complete event matrix' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Boundary owner' });
    const transactionResult = await handler.handleRequest('add_activity', {
      activityType: 'transaction',
      name: 'Cancelable transaction'
    });
    expect(transactionResult.isError).toBeUndefined();
    const transaction = diagramContext.getCurrent().elements.get('Transaction_1');
    if (!transaction) throw new Error('Expected handler-created transaction');
    for (const [eventType, allowedDefinitions] of Object.entries(eventMatrix)) {
      for (const eventDefinition of allowedDefinitions) {
        const result = await handler.handleRequest('add_event', {
          eventType,
          eventDefinition,
          eventDefinitionPayload: payloadFor(eventDefinition),
          attachTo: eventType === 'boundary'
            ? eventDefinition === 'cancel' ? transaction.id : 'Task_1'
            : undefined
        });
        expect(result.isError).toBeUndefined();
      }
    }

    const context = diagramContext.getCurrent();
    const parsed = await moddle.fromXML(await engine.exportXml(context.id));
    expect(parsed.warnings).toEqual([]);
    const validation = await new BpmnValidator().validate(context.xml!, 'semantic');
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    const beforeCount = context.elements.size;
    for (const [eventType, allowedDefinitions] of Object.entries(eventMatrix)) {
      for (const eventDefinition of allDefinitions.filter(
        definition => !(allowedDefinitions as readonly string[]).includes(definition)
      )) {
        const result = await handler.handleRequest('add_event', {
          eventType,
          eventDefinition,
          eventDefinitionPayload: payloadFor(eventDefinition),
          attachTo: eventType === 'boundary' ? 'Task_1' : undefined
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not legal');
      }
    }
    expect(context.elements.size).toBe(beforeCount);
  });

  it('creates resolvable root references and preserves them through reopen and update', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Referenced events' });
    await handler.handleRequest('add_event', {
      eventType: 'start',
      name: 'Receive order',
      eventDefinition: 'message',
      eventDefinitionPayload: {
        reference: { id: 'Message_Order', name: 'Order' }
      }
    });
    await handler.handleRequest('add_event', {
      eventType: 'end',
      name: 'Reject order',
      eventDefinition: 'error',
      eventDefinitionPayload: {
        reference: { id: 'Error_Rejected', name: 'Rejected', code: 'ORDER_REJECTED' }
      }
    });

    const context = diagramContext.getCurrent();
    const filename = engine.getActiveFilename(context.id);
    const first = await exportedDefinitions();
    const message = first.rootElements.find((root: any) => root.id === 'Message_Order');
    const error = first.rootElements.find((root: any) => root.id === 'Error_Rejected');
    expect(findSemantic(first, 'StartEvent_1').eventDefinitions[0].messageRef).toBe(message);
    expect(findSemantic(first, 'EndEvent_1').eventDefinitions[0].errorRef).toBe(error);
    expect(error.errorCode).toBe('ORDER_REJECTED');

    engine.clear();
    const reopened = await engine.loadDiagram(filename);
    expect(reopened.elements.get('StartEvent_1')?.properties).toMatchObject({
      eventDefinition: 'message',
      eventDefinitionPayload: {
        reference: { id: 'Message_Order', name: 'Order' }
      }
    });
    await engine.updateElement(reopened.id, 'StartEvent_1', { name: 'Receive updated order' });
    const afterUpdate = (await moddle.fromXML(await engine.exportXml(reopened.id))).rootElement;
    const updatedMessage = afterUpdate.rootElements.find((root: any) => root.id === 'Message_Order');
    expect(findSemantic(afterUpdate, 'StartEvent_1').eventDefinitions[0].messageRef)
      .toBe(updatedMessage);
    expect(findSemantic(afterUpdate, 'StartEvent_1').name).toBe('Receive updated order');
  });

  it('rejects conflicting metadata for a shared root without changing the document', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Shared message root' });
    await handler.handleRequest('add_event', {
      eventType: 'start',
      eventDefinition: 'message',
      eventDefinitionPayload: {
        reference: { id: 'Message_Shared', name: 'First name' }
      }
    });
    const context = diagramContext.getCurrent();
    const beforeXml = await engine.exportXml(context.id);

    const result = await handler.handleRequest('add_event', {
      eventType: 'intermediate-catch',
      eventDefinition: 'message',
      eventDefinitionPayload: {
        reference: { id: 'Message_Shared', name: 'Conflicting name' }
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Conflicting names for shared event root Message_Shared');
    expect(context.elements.size).toBe(1);
    expect(await engine.exportXml(context.id)).toBe(beforeXml);
  });

  it.each([
    ['end', 'timer'],
    ['intermediate-catch', 'error'],
    ['intermediate-throw', 'conditional'],
    ['boundary', 'terminate']
  ])('rejects illegal %s/%s combinations without mutation', async (eventType, eventDefinition) => {
    await handler.handleRequest('new_bpmn', { name: 'Invalid event matrix' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Attached' });
    const before = diagramContext.getCurrent();
    const beforeXml = await engine.exportXml(before.id);
    const result = await handler.handleRequest('add_event', {
      eventType,
      eventDefinition,
      attachTo: eventType === 'boundary' ? 'Task_1' : undefined,
      eventDefinitionPayload: eventDefinition === 'timer'
        ? { timer: { type: 'timeDuration', expression: 'PT1M' } }
        : eventDefinition === 'conditional'
          ? { condition: { expression: '${ready}' } }
          : undefined
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not legal');
    expect(before.elements.size).toBe(1);
    expect(await engine.exportXml(before.id)).toBe(beforeXml);
  });

  it.each([
    ['timer', 'intermediate-catch', 'Timer event definition requires'],
    ['conditional', 'intermediate-catch', 'Conditional event definition requires']
  ])('returns an actionable error when %s required payload is missing', async (
    eventDefinition,
    eventType,
    expectedError
  ) => {
    await handler.handleRequest('new_bpmn', { name: 'Missing payload' });
    const result = await handler.handleRequest('add_event', { eventType, eventDefinition });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(expectedError);
    expect(diagramContext.getCurrent().elements.size).toBe(0);
  });

  it.each([
    [
      { definitionId: 'bad definition id', reference: { name: 'Notice' } },
      'eventDefinitionPayload.definitionId: Invalid'
    ],
    [
      { reference: { id: '123 invalid', name: 'Notice' } },
      'eventDefinitionPayload.reference.id: Invalid'
    ]
  ])('rejects invalid custom event IDs before serialization', async (eventDefinitionPayload, error) => {
    await handler.handleRequest('new_bpmn', { name: 'Invalid event IDs' });
    const context = diagramContext.getCurrent();
    const beforeXml = await engine.exportXml(context.id);
    const result = await handler.handleRequest('add_event', {
      eventType: 'start',
      eventDefinition: 'message',
      eventDefinitionPayload
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(error);
    expect(context.elements.size).toBe(0);
    expect(await engine.exportXml(context.id)).toBe(beforeXml);
  });

  it('enforces non-interrupting compensation boundary semantics', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Compensation boundary' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Compensated work' });
    const added = await handler.handleRequest('add_event', {
      eventType: 'boundary',
      eventDefinition: 'compensation',
      attachTo: 'Task_1'
    });
    expect(added.isError).toBeUndefined();
    const boundary = findSemantic(await exportedDefinitions(), 'BoundaryEvent_1');
    expect(boundary.cancelActivity).toBe(false);

    const invalid = await handler.handleRequest('add_event', {
      eventType: 'boundary',
      eventDefinition: 'compensation',
      attachTo: 'Task_1',
      cancelActivity: true
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('must set cancelActivity to false');
  });

  it('applies boundary interruption defaults when the event definition changes', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Updated boundary definition' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Compensated work' });
    await handler.handleRequest('add_event', {
      eventType: 'boundary',
      eventDefinition: 'timer',
      eventDefinitionPayload: {
        timer: { type: 'timeDuration', expression: 'PT1M' }
      },
      attachTo: 'Task_1'
    });
    const context = diagramContext.getCurrent();
    expect(context.elements.get('BoundaryEvent_1')?.properties.cancelActivity).toBe(true);

    await engine.updateElement(context.id, 'BoundaryEvent_1', {
      properties: {
        eventDefinition: 'compensation',
        eventDefinitionPayload: {}
      }
    });

    const boundary = findSemantic(await exportedDefinitions(), 'BoundaryEvent_1');
    expect(boundary.eventDefinitions[0].$type).toBe('bpmn:CompensateEventDefinition');
    expect(boundary.cancelActivity).toBe(false);
  });

  it.each([
    ['task', 'bpmn:Task'],
    ['userTask', 'bpmn:UserTask'],
    ['serviceTask', 'bpmn:ServiceTask'],
    ['scriptTask', 'bpmn:ScriptTask'],
    ['businessRuleTask', 'bpmn:BusinessRuleTask'],
    ['manualTask', 'bpmn:ManualTask'],
    ['receiveTask', 'bpmn:ReceiveTask'],
    ['sendTask', 'bpmn:SendTask'],
    ['subProcess', 'bpmn:SubProcess'],
    ['transaction', 'bpmn:Transaction'],
    ['callActivity', 'bpmn:CallActivity']
  ])('serializes advertised activity %s as %s', async (activityType, expectedType) => {
    await handler.handleRequest('new_bpmn', { name: 'Activity types' });
    const result = await handler.handleRequest('add_activity', { activityType, name: activityType });
    expect(result.isError).toBeUndefined();
    const id = (result.content[0].text as string).split('ID: ')[1];
    expectSemanticShape(await exportedDefinitions(), id, expectedType);
  });

  it('round-trips a call activity QName and DI through update and reopen', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Callable process' });
    const added = await handler.handleRequest('add_activity', {
      activityType: 'callActivity',
      name: 'Invoke fulfillment',
      properties: { calledElement: 'FulfillmentProcess' },
      position: { x: 240, y: 160 }
    });
    expect(added.isError).toBeUndefined();

    const context = diagramContext.getCurrent();
    const callActivity = context.elements.get('CallActivity_1');
    expect(callActivity).toMatchObject({
      type: 'bpmn:CallActivity',
      name: 'Invoke fulfillment',
      properties: { calledElement: 'FulfillmentProcess' }
    });
    const first = await moddle.fromXML(await engine.exportXml(context.id));
    expect(first.elementsById.CallActivity_1).toMatchObject({
      $type: 'bpmn:CallActivity',
      calledElement: 'FulfillmentProcess'
    });
    expect(first.elementsById.CallActivity_1_di.bpmnElement)
      .toBe(first.elementsById.CallActivity_1);
    expect(first.elementsById.CallActivity_1_di.bounds)
      .toMatchObject({ x: 240, y: 160, width: 100, height: 80 });

    await engine.updateElement(context.id, 'CallActivity_1', {
      properties: { calledElement: 'partner:Fulfillment_v2' }
    });
    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(context.filename!);
    await reopenedEngine.updateElement(reopened.id, 'CallActivity_1', {
      name: 'Invoke fulfillment v2'
    });
    const roundTripped = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(roundTripped.elementsById.CallActivity_1).toMatchObject({
      $type: 'bpmn:CallActivity',
      name: 'Invoke fulfillment v2',
      calledElement: 'partner:Fulfillment_v2'
    });
    expect(reopened.elements.get('CallActivity_1')?.properties.calledElement)
      .toBe('partner:Fulfillment_v2');
    expect(roundTripped.elementsById.CallActivity_1_di.bpmnElement)
      .toBe(roundTripped.elementsById.CallActivity_1);
  });

  it.each([
    ['empty', ''],
    ['whitespace', 'Fulfillment Process'],
    ['leading digit', '2Fulfillment'],
    ['multiple prefixes', 'partner:team:Fulfillment'],
    ['URI rather than QName', 'https://example.test/fulfillment'],
    ['non-string', 42]
  ])('rejects an invalid %s calledElement without mutation', async (_label, calledElement) => {
    const context = await engine.createProcess('Invalid callable reference');

    await expect(engine.createElement(context.id, {
      type: 'bpmn:CallActivity',
      name: 'Rejected call',
      properties: { calledElement }
    })).rejects.toThrow('calledElement must be a valid BPMN QName');
    expect(context.elements.size).toBe(0);
  });

  it('rejects calledElement on other activity types and preserves a valid value after a failed update', async () => {
    const context = await engine.createProcess('Called element ownership');
    const callActivity = await engine.createElement(context.id, {
      type: 'bpmn:CallActivity',
      name: 'Valid call',
      properties: { calledElement: 'Überprüfung' }
    });

    await expect(engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Invalid owner',
      properties: { calledElement: 'SomeProcess' }
    })).rejects.toThrow('calledElement is only valid on bpmn:CallActivity');
    await expect(engine.updateElement(context.id, callActivity.id, {
      properties: { calledElement: 'partner:invalid:value' }
    })).rejects.toThrow('calledElement must be a valid BPMN QName');

    expect(context.elements.size).toBe(1);
    expect(context.elements.get(callActivity.id)?.properties.calledElement).toBe('Überprüfung');
    expect((await moddle.fromXML(await engine.exportXml(context.id)))
      .elementsById[callActivity.id].calledElement).toBe('Überprüfung');
  });

  it.each([
    ['exclusive', 'bpmn:ExclusiveGateway'],
    ['parallel', 'bpmn:ParallelGateway'],
    ['inclusive', 'bpmn:InclusiveGateway'],
    ['eventBased', 'bpmn:EventBasedGateway'],
    ['complex', 'bpmn:ComplexGateway']
  ])('serializes advertised gateway %s as %s', async (gatewayType, expectedType) => {
    await handler.handleRequest('new_bpmn', { name: 'Gateway types' });
    const result = await handler.handleRequest('add_gateway', { gatewayType, name: gatewayType });
    expect(result.isError).toBeUndefined();
    const id = (result.content[0].text as string).split('ID: ')[1];
    expectSemanticShape(await exportedDefinitions(), id, expectedType);
  });

  it.each([
    'bpmn:DataStoreReference',
    'bpmn:TextAnnotation',
    'bpmn:Group'
  ] as const)('serializes supported artifact %s with DI', async artifactType => {
    const context = await engine.createProcess('Artifact types');
    const artifact = await engine.createElement(context.id, { type: artifactType });
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;

    expectSemanticShape(definitions, artifact.id, artifactType);
  });

  it('creates and round-trips a data object pair with collection, item subject, and reference DI', async () => {
    const imported = await engine.importXml(`<?xml version="1.0" encoding="UTF-8"?>
      <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
        id="Definitions_Data" targetNamespace="urn:mcp-bpmn:data">
        <bpmn:itemDefinition id="ItemDefinition_Record" />
        <bpmn:process id="Process_Data" name="Data process" isExecutable="true" />
      </bpmn:definitions>`);

    const { dataObject, reference } = await engine.addDataObject(
      imported.id,
      'Customer record',
      {
        position: { x: 240, y: 160 },
        isCollection: true,
        itemSubjectRef: 'ItemDefinition_Record'
      }
    );
    const first = await moddle.fromXML(await engine.exportXml(imported.id));

    expect(first.elementsById[dataObject.id]).toMatchObject({
      $type: 'bpmn:DataObject',
      name: 'Customer record',
      isCollection: true,
      itemSubjectRef: first.elementsById.ItemDefinition_Record
    });
    expect(first.elementsById[reference.id]).toMatchObject({
      $type: 'bpmn:DataObjectReference',
      name: 'Customer record',
      dataObjectRef: first.elementsById[dataObject.id]
    });
    expect(first.elementsById[`${reference.id}_di`]).toMatchObject({
      $type: 'bpmndi:BPMNShape',
      bpmnElement: first.elementsById[reference.id],
      bounds: expect.objectContaining({ x: 240, y: 160, width: 36, height: 50 })
    });
    expect(Object.values(first.elementsById).some(
      (element: any) => element.$type === 'bpmn:Task' && element.id.includes('DataObject')
    )).toBe(false);

    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(imported.filename!);
    const reopenedXml = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(reopenedXml.elementsById[dataObject.id].isCollection).toBe(true);
    expect(reopenedXml.elementsById[dataObject.id].itemSubjectRef)
      .toBe(reopenedXml.elementsById.ItemDefinition_Record);

    await reopenedEngine.updateElement(reopened.id, reference.id, {
      properties: { isCollection: false, itemSubjectRef: null }
    });
    const updated = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(updated.elementsById[dataObject.id].isCollection).toBe(false);
    expect(updated.elementsById[dataObject.id].itemSubjectRef).toBeUndefined();

    await reopenedEngine.deleteElement(reopened.id, reference.id);
    const deleted = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(deleted.elementsById[reference.id]).toBeUndefined();
    expect(deleted.elementsById[dataObject.id]).toBeUndefined();
    expect(deleted.elementsById[`${reference.id}_di`]).toBeUndefined();
    expect(deleted.elementsById.ItemDefinition_Record).toBeDefined();
  });

  it('rejects missing data-object and item-subject references without changing state', async () => {
    const context = await engine.createProcess('Invalid data references');
    const beforeXml = await engine.exportXml(context.id);

    await expect(engine.createElement(context.id, {
      type: 'bpmn:DataObjectReference',
      name: 'Missing backing'
    })).rejects.toThrow('require a valid dataObjectRef');
    await expect(engine.createElement(context.id, {
      type: 'bpmn:DataObjectReference',
      name: 'Unknown backing',
      properties: { dataObjectRef: 'DataObject_Missing' }
    })).rejects.toThrow('references missing data object DataObject_Missing');
    await expect(engine.addDataObject(context.id, 'Unknown item subject', {
      itemSubjectRef: 'ItemDefinition_Missing'
    })).rejects.toThrow('Invalid data object itemSubjectRef: ItemDefinition_Missing');

    expect(context.elements.size).toBe(0);
    expect(context.document.dataObjects.size).toBe(0);
    expect(await engine.exportXml(context.id)).toBe(beforeXml);
  });

  it('serializes the advertised participant with DI', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Participant type', type: 'collaboration' });
    const result = await handler.handleRequest('add_pool', { name: 'Participant' });

    expect(result.isError).toBeUndefined();
    expectSemanticShape(await exportedDefinitions(), 'Participant_1', 'bpmn:Participant');
  });

  it('rejects a lane without flow-node membership without mutating the collaboration', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Collaboration', type: 'collaboration' });
    await handler.handleRequest('add_pool', { name: 'Pool' });
    const before = diagramContext.getCurrent();
    const beforeXml = await engine.exportXml(before.id);
    const result = await handler.handleRequest('add_lane', { poolId: 'Participant_1', name: 'Lane' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Invalid arguments for tool "add_lane": flowNodeIds: Required'
    );
    expect(before.elements.size).toBe(1);
    expect(await engine.exportXml(before.id)).toBe(beforeXml);
  });

  it('rejects unknown element and connection types without changing state or the persisted file', async () => {
    const context = await engine.createProcess('Mutation safety');
    const start = await engine.createElement(context.id, { type: 'bpmn:StartEvent' });
    const task = await engine.createElement(context.id, { type: 'bpmn:Task' });
    const filename = context.filename!;
    const beforeXml = await fs.readFile(join(directory, filename), 'utf8');

    await expect(engine.createElement(context.id, { type: 'bpmn:UnknownNode' as never }))
      .rejects.toThrow('Unsupported BPMN element type');
    await expect(engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      properties: { eventDefinition: 'unknown' }
    })).rejects.toThrow('Unsupported event definition type');
    await expect(engine.updateElement(context.id, task.id, {
      name: 'Should not stick',
      properties: { eventDefinition: 'unknown' }
    })).rejects.toThrow('Unsupported event definition type');
    await expect(engine.connect(context.id, start.id, task.id, undefined, 'bpmn:UnknownFlow' as never))
      .rejects.toThrow('Unsupported BPMN connection type');

    expect(context.elements.size).toBe(2);
    expect(context.elements.get(task.id)?.name).toBeUndefined();
    expect(context.elements.get(task.id)?.properties).toEqual({});
    expect(context.connections.size).toBe(0);
    expect(await fs.readFile(join(directory, filename), 'utf8')).toBe(beforeXml);
  });

  it('rejects unknown imported semantic types without registering or writing the document', async () => {
    const filesBefore = await fs.readdir(directory);
    const unknownXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_unknown" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_unknown">
    <bpmn:madeUp id="Unknown_1" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(engine.importXml(unknownXml)).rejects.toThrow('unknown type');
    expect(await fs.readdir(directory)).toEqual(filesBefore);
    expect(() => engine.getProcess('Process_unknown')).toThrow('Process Process_unknown not found');
  });

  it('rejects imported cross-process sequence flows before registration or file writes', async () => {
    const filesBefore = await fs.readdir(directory);
    const invalidXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_cross_process" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_One">
    <bpmn:task id="Task_One" />
    <bpmn:sequenceFlow id="Flow_Cross" sourceRef="Task_One" targetRef="Task_Two" />
  </bpmn:process>
  <bpmn:process id="Process_Two">
    <bpmn:task id="Task_Two" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(engine.importXml(invalidXml)).rejects.toThrow('crosses process');
    expect(await fs.readdir(directory)).toEqual(filesBefore);
    expect(() => engine.getProcess('Process_One')).toThrow('Process Process_One not found');
  });

  it('validates participant properties before creating its generated process root', async () => {
    const context = await engine.createProcess('Participant validation', 'collaboration');
    const beforeXml = await engine.exportXml(context.id);

    await expect(engine.createElement(context.id, {
      type: 'bpmn:Participant',
      properties: { eventDefinition: 'unknown' }
    })).rejects.toThrow('Unsupported event definition type');

    expect(context.document.processes.size).toBe(0);
    expect(context.elements.size).toBe(0);
    expect(await engine.exportXml(context.id)).toBe(beforeXml);
  });

  it('keeps collaboration roots, participant refs, and the plane target aligned', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Buyer & Seller', type: 'collaboration' });
    await handler.handleRequest('add_pool', {
      name: 'Buyer',
      position: { x: 25, y: 75 },
      size: { width: 840, height: 310 }
    });
    const context = diagramContext.getCurrent();
    const annotation = await engine.createElement(context.id, {
      type: 'bpmn:TextAnnotation',
      properties: { text: 'Collaboration note' }
    });
    const association = await engine.connect(
      context.id,
      'Participant_1',
      annotation.id,
      undefined,
      'bpmn:Association'
    );
    const definitions = await exportedDefinitions();
    const collaboration = definitions.rootElements.find((root: any) => root.$type === 'bpmn:Collaboration');
    const participant = collaboration.participants[0];

    expect(collaboration.id).toBe('Collaboration_1');
    expect(participant.$type).toBe('bpmn:Participant');
    expect(participant.processRef.id).toBe('Participant_1_Process');
    expect(definitions.rootElements.some((root: any) => root.id === participant.processRef.id)).toBe(true);
    expect(collaboration.artifacts.map((artifact: any) => artifact.id)).toEqual(
      expect.arrayContaining([annotation.id, association.id])
    );
    const participantShape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement.id === participant.id
    );
    expect(participantShape.bounds).toMatchObject({ x: 25, y: 75, width: 840, height: 310 });
    expect(definitions.diagrams[0].plane.bpmnElement.id).toBe(collaboration.id);
  });

  it('lets MCP element tools infer a sole collaboration owner and rejects ambiguity', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Targeted collaboration', type: 'collaboration' });
    await handler.handleRequest('add_pool', { name: 'Buyer' });
    const context = diagramContext.getCurrent();
    const participant = context.elements.get('Participant_1');
    expect(participant?.kind).toBe('participant');
    if (!participant || participant.kind !== 'participant' || !participant.processRef) {
      throw new Error('Expected a white-box participant with processRef');
    }

    const inferred = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Inferred owner'
    });
    expect(inferred.isError).toBeUndefined();
    const inferredTask = Array.from(context.elements.values()).find(element => element.name === 'Inferred owner');
    expect(inferredTask).toMatchObject({ ownerId: participant.processRef, scopeId: participant.processRef });

    await handler.handleRequest('add_pool', { name: 'Seller' });
    const ambiguous = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'No owner'
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain('explicit process owner');

    const added = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Owned task',
      ownerId: participant.processRef,
      scopeId: participant.processRef
    });
    expect(added.isError).toBeUndefined();
    const listed = await handler.handleRequest('list_elements', {});
    const elements = JSON.parse(listed.content[0].text as string).elements;
    expect(elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: participant.id,
        processRef: participant.processRef,
        size: { width: 600, height: 250 }
      }),
      expect.objectContaining({
        name: 'Owned task',
        ownerId: participant.processRef,
        scopeId: participant.processRef
      })
    ]));
  });

  it('creates distinct participant processes, infers message flow, and rejects explicit cross-process sequence flow', async () => {
    const context = await engine.createProcess('Two owners', 'collaboration');
    const buyer = await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'Buyer',
      position: { x: 40, y: 40 },
      size: { width: 720, height: 220 }
    });
    const seller = await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'Seller',
      position: { x: 40, y: 300 },
      size: { width: 720, height: 260 }
    });
    expect(buyer.kind).toBe('participant');
    expect(seller.kind).toBe('participant');
    if (buyer.kind !== 'participant' || seller.kind !== 'participant'
      || !buyer.processRef || !seller.processRef) {
      throw new Error('Expected two white-box participants with distinct processRefs');
    }

    const buyerStart = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      ownerId: buyer.processRef,
      scopeId: buyer.processRef
    });
    const buyerTask = await engine.createElement(context.id, {
      type: 'bpmn:SendTask',
      ownerId: buyer.processRef,
      scopeId: buyer.processRef
    });
    const sellerTask = await engine.createElement(context.id, {
      type: 'bpmn:ReceiveTask',
      ownerId: seller.processRef,
      scopeId: seller.processRef
    });
    const sellerEnd = await engine.createElement(context.id, {
      type: 'bpmn:EndEvent',
      ownerId: seller.processRef,
      scopeId: seller.processRef
    });
    const beforeInvalidBoundary = context.elements.size;
    await expect(engine.createElement(context.id, {
      type: 'bpmn:BoundaryEvent',
      ownerId: seller.processRef,
      scopeId: seller.processRef,
      properties: { attachTo: buyerTask.id }
    })).rejects.toThrow('must share process ownership and scope');
    expect(context.elements.size).toBe(beforeInvalidBoundary);
    const buyerFlow = await engine.connect(context.id, buyerStart.id, buyerTask.id);
    const sellerFlow = await engine.connect(context.id, sellerTask.id, sellerEnd.id);
    const messageFlow = await engine.connect(
      context.id,
      buyerTask.id,
      sellerTask.id,
      'Order'
    );
    expect(messageFlow.type).toBe('bpmn:MessageFlow');

    const beforeConnections = Array.from(context.connections.entries());
    const beforeXml = await engine.exportXml(context.id);
    await expect(engine.connect(
      context.id,
      buyerTask.id,
      sellerTask.id,
      undefined,
      'bpmn:SequenceFlow'
    ))
      .rejects.toThrow('Sequence flows cannot cross process');
    expect(Array.from(context.connections.entries())).toEqual(beforeConnections);
    expect(await engine.exportXml(context.id)).toBe(beforeXml);

    const definitions = (await moddle.fromXML(beforeXml)).rootElement;
    const collaboration = definitions.rootElements.find((root: any) => root.id === context.id);
    const buyerProcess = definitions.rootElements.find((root: any) => root.id === buyer.processRef);
    const sellerProcess = definitions.rootElements.find((root: any) => root.id === seller.processRef);
    expect(collaboration.participants.map((participant: any) => participant.$type))
      .toEqual(['bpmn:Participant', 'bpmn:Participant']);
    expect(collaboration.participants.map((participant: any) => participant.processRef.id))
      .toEqual([buyer.processRef, seller.processRef]);
    expect(buyerProcess.flowElements.map((element: any) => element.id)).toContain(buyerFlow.id);
    expect(sellerProcess.flowElements.map((element: any) => element.id)).toContain(sellerFlow.id);
    expect(collaboration.messageFlows.map((flow: any) => flow.id)).toEqual([messageFlow.id]);
    const messageEdge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === messageFlow.id
    );
    expect(messageEdge.$type).toBe('bpmndi:BPMNEdge');
    expect(messageEdge.bpmnElement.$type).toBe('bpmn:MessageFlow');
    expect(definitions.diagrams[0].plane.bpmnElement.id).toBe(context.id);
  });

  it('rejects invalid and ambiguous flow endpoint scopes before mutation', async () => {
    const context = await engine.createProcess('Endpoint scopes', 'collaboration');
    const buyer = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Buyer' });
    const seller = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Seller' });
    const external = await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'External',
      properties: { blackBox: true }
    });
    if (buyer.kind !== 'participant' || seller.kind !== 'participant'
      || !buyer.processRef || !seller.processRef) {
      throw new Error('Expected two white-box participants with processRefs');
    }
    const buyerTask = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: buyer.processRef, scopeId: buyer.processRef
    });
    const sellerTask = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: seller.processRef, scopeId: seller.processRef
    });
    const buyerSubprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess', ownerId: buyer.processRef, scopeId: buyer.processRef
    });
    const nestedBuyerTask = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: buyer.processRef, scopeId: buyerSubprocess.id
    });
    const annotation = await engine.createElement(context.id, {
      type: 'bpmn:TextAnnotation', ownerId: buyer.processRef, scopeId: buyer.processRef
    });
    const assertRejectedWithoutMutation = async (
      operation: Promise<unknown>,
      message: string
    ): Promise<void> => {
      const beforeConnections = Array.from(context.connections.entries());
      const beforeXml = await engine.exportXml(context.id);
      await expect(operation).rejects.toThrow(message);
      expect(Array.from(context.connections.entries())).toEqual(beforeConnections);
      expect(await engine.exportXml(context.id)).toBe(beforeXml);
    };

    await assertRejectedWithoutMutation(
      engine.connect(context.id, buyer.id, buyerTask.id, undefined, 'bpmn:SequenceFlow'),
      'Sequence flows can only connect BPMN flow nodes'
    );
    await assertRejectedWithoutMutation(
      engine.connect(context.id, buyerTask.id, nestedBuyerTask.id),
      'Sequence flows cannot cross process or nested-scope boundaries'
    );
    await assertRejectedWithoutMutation(
      engine.connect(context.id, buyerTask.id, nestedBuyerTask.id, undefined, 'bpmn:MessageFlow'),
      'Message flows must cross participant boundaries'
    );
    await assertRejectedWithoutMutation(
      engine.connect(context.id, annotation.id, sellerTask.id, undefined, 'bpmn:MessageFlow'),
      'is not a BPMN interaction node'
    );

    const participantMessage = await engine.connect(
      context.id,
      external.id,
      sellerTask.id,
      undefined,
      'bpmn:MessageFlow'
    );
    expect(participantMessage.type).toBe('bpmn:MessageFlow');

    await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'Buyer alias',
      properties: { processRef: buyer.processRef }
    });
    await assertRejectedWithoutMutation(
      engine.connect(context.id, buyerTask.id, sellerTask.id, undefined, 'bpmn:MessageFlow'),
      'ambiguous participant ownership'
    );
  });

  it('parses the two-pool fixture and preserves ownership, refs, bounds, and flows after reopen and mutation', async () => {
    const fixture = await fs.readFile(
      join(process.cwd(), 'tests/fixtures/collaboration/two-pool.bpmn'),
      'utf8'
    );
    const fixtureDefinitions = (await moddle.fromXML(fixture)).rootElement;
    const fixtureCollaboration = fixtureDefinitions.rootElements.find(
      (root: any) => root.id === 'Collaboration_TwoPool'
    );
    const buyerProcess = fixtureDefinitions.rootElements.find((root: any) => root.id === 'Process_Buyer');
    const sellerProcess = fixtureDefinitions.rootElements.find((root: any) => root.id === 'Process_Seller');
    const fixturePlane = fixtureDefinitions.diagrams[0].plane;

    expect(fixtureCollaboration.participants.map((participant: any) => participant.processRef.id))
      .toEqual(['Process_Buyer', 'Process_Seller']);
    expect(buyerProcess.flowElements.filter((item: any) => item.$type === 'bpmn:SequenceFlow'))
      .toHaveLength(1);
    expect(sellerProcess.flowElements.filter((item: any) => item.$type === 'bpmn:SequenceFlow'))
      .toHaveLength(1);
    expect(fixtureCollaboration.messageFlows.map((flow: any) => flow.id)).toEqual(['Message_Order']);
    expect(fixturePlane.bpmnElement.id).toBe('Collaboration_TwoPool');
    expect(fixturePlane.planeElement).toHaveLength(9);

    const imported = await engine.importXml(fixture);
    expect(imported.elements.get('Buyer_Send')).toMatchObject({
      ownerId: 'Process_Buyer',
      scopeId: 'Process_Buyer'
    });
    expect(imported.elements.get('Participant_Seller')).toMatchObject({
      kind: 'participant',
      processRef: 'Process_Seller',
      position: { x: 40, y: 300 },
      size: { width: 720, height: 260 }
    });
    expect(imported.connections.get('Message_Order')).toMatchObject({
      type: 'bpmn:MessageFlow',
      ownerId: 'Collaboration_TwoPool',
      scopeId: 'Collaboration_TwoPool'
    });

    const saved = (await fs.readdir(directory)).find(filename => filename.endsWith('.bpmn'));
    expect(saved).toBeDefined();
    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(saved!);
    await reopenedEngine.updateElement(reopened.id, 'Seller_Receive', { name: 'Order received' });
    const reopenedDefinitions = (await moddle.fromXML(await reopenedEngine.exportXml(reopened.id))).rootElement;
    const reopenedCollaboration = reopenedDefinitions.rootElements.find(
      (root: any) => root.id === 'Collaboration_TwoPool'
    );
    const reopenedSeller = reopenedDefinitions.rootElements.find((root: any) => root.id === 'Process_Seller');
    const reopenedBuyer = reopenedDefinitions.rootElements.find((root: any) => root.id === 'Process_Buyer');
    const sellerParticipantShape = reopenedDefinitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement.id === 'Participant_Seller'
    );
    expect(reopenedCollaboration.messageFlows.map((flow: any) => flow.id)).toEqual(['Message_Order']);
    expect(reopenedBuyer.flowElements.filter((item: any) => item.$type === 'bpmn:SequenceFlow')
      .map((flow: any) => flow.id)).toEqual(['Buyer_Flow']);
    expect(reopenedSeller.flowElements.filter((item: any) => item.$type === 'bpmn:SequenceFlow')
      .map((flow: any) => flow.id)).toEqual(['Seller_Flow']);
    expect(reopenedCollaboration.participants[1].processRef.id).toBe('Process_Seller');
    expect(reopenedSeller.flowElements.find((item: any) => item.id === 'Seller_Receive').name)
      .toBe('Order received');
    expect(sellerParticipantShape.bounds).toMatchObject({ x: 40, y: 300, width: 720, height: 260 });
    expect(reopenedDefinitions.diagrams[0].plane.bpmnElement.id).toBe('Collaboration_TwoPool');
    expect(reopened.elements.get('Buyer_Send')).toMatchObject({
      ownerId: 'Process_Buyer',
      scopeId: 'Process_Buyer'
    });
  });

  it('keeps black-box participants without creating or requiring a processRef', async () => {
    const context = await engine.createProcess('Black box', 'collaboration');
    await expect(engine.createElement(context.id, {
      id: 'DuplicateRoot',
      type: 'bpmn:Participant',
      properties: { processRef: 'DuplicateRoot' }
    })).rejects.toThrow('invalid processRef');
    expect(context.document.processes.size).toBe(0);
    expect(context.elements.size).toBe(0);
    const participant = await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'External supplier',
      properties: { blackBox: true }
    });
    expect(participant).toMatchObject({ kind: 'participant', processRef: undefined });
    expect(context.document.processes.size).toBe(0);
    await expect(engine.createElement(context.id, {
      type: 'bpmn:Task',
      ownerId: participant.id,
      scopeId: participant.id
    })).rejects.toThrow('Missing BPMN process owner');

    const imported = await engine.importXml(await engine.exportXml(context.id));
    await engine.updateElement(imported.id, participant.id, { name: 'Renamed supplier' });
    const definitions = (await moddle.fromXML(await engine.exportXml(imported.id))).rootElement;
    const serialized = definitions.rootElements[0].participants[0];
    expect(serialized.name).toBe('Renamed supplier');
    expect(serialized.processRef).toBeUndefined();
  });

  it('rejects structural participant updates without changing ownership', async () => {
    const context = await engine.createProcess('Immutable participant ownership', 'collaboration');
    const participant = await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'Buyer'
    });
    expect(participant.kind).toBe('participant');
    const beforeXml = await engine.exportXml(context.id);

    await expect(engine.updateElement(context.id, participant.id, {
      properties: { blackBox: true }
    })).rejects.toThrow('cannot be changed after creation');
    await expect(engine.updateElement(context.id, participant.id, {
      properties: { processRef: 'Replacement_Process' }
    })).rejects.toThrow('cannot be changed after creation');

    expect(await engine.exportXml(context.id)).toBe(beforeXml);
    expect(context.document.processes.has('Replacement_Process')).toBe(false);
  });

  it('serializes handler-created black-box pools without a process root or processRef', async () => {
    await handler.handleRequest('new_bpmn', { name: 'External collaboration', type: 'collaboration' });
    const result = await handler.handleRequest('add_pool', { name: 'External system', blackBox: true });
    expect(result.isError).toBeUndefined();

    const definitions = await exportedDefinitions();
    const collaboration = definitions.rootElements.find((root: any) => root.$type === 'bpmn:Collaboration');
    expect(collaboration.participants[0].processRef).toBeUndefined();
    expect(definitions.rootElements.filter((root: any) => root.$type === 'bpmn:Process')).toHaveLength(0);
  });

  it('keeps nested scopes, artifacts, associations, and message flows in their semantic owners', async () => {
    const context = await engine.createProcess('Scoped collaboration', 'collaboration');
    const buyer = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Buyer' });
    const seller = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Seller' });
    expect(buyer.kind).toBe('participant');
    expect(seller.kind).toBe('participant');
    if (buyer.kind !== 'participant' || seller.kind !== 'participant'
      || !buyer.processRef || !seller.processRef) {
      throw new Error('Expected two white-box participants with processRefs');
    }

    const subprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess',
      name: 'Buyer scope',
      ownerId: buyer.processRef,
      scopeId: buyer.processRef
    });
    const buyerTask = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Place order',
      ownerId: buyer.processRef,
      scopeId: subprocess.id
    });
    const sellerTask = await engine.createElement(context.id, {
      type: 'bpmn:ReceiveTask',
      name: 'Receive order',
      ownerId: seller.processRef,
      scopeId: seller.processRef
    });
    const annotation = await engine.createElement(context.id, {
      type: 'bpmn:TextAnnotation',
      ownerId: buyer.processRef,
      scopeId: buyer.processRef,
      properties: { text: 'Buyer note' }
    });
    const message = await engine.connect(
      context.id,
      buyerTask.id,
      sellerTask.id,
      'Order',
      'bpmn:MessageFlow'
    );
    const association = await engine.connect(
      context.id,
      subprocess.id,
      annotation.id,
      undefined,
      'bpmn:Association'
    );

    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const collaboration = definitions.rootElements.find((root: any) => root.id === context.id);
    const buyerProcess = definitions.rootElements.find((root: any) => root.id === buyer.processRef);
    const serializedSubprocess = buyerProcess.flowElements.find((item: any) => item.id === subprocess.id);
    expect(serializedSubprocess.flowElements.map((item: any) => item.id)).toContain(buyerTask.id);
    expect(buyerProcess.artifacts.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([annotation.id, association.id])
    );
    expect(collaboration.messageFlows.map((item: any) => item.id)).toContain(message.id);
    expect(collaboration.messageFlows[0].sourceRef.id).toBe(buyerTask.id);
    expect(collaboration.messageFlows[0].targetRef.id).toBe(sellerTask.id);
    expect(definitions.diagrams[0].plane.bpmnElement.id).toBe(context.id);
  });

  it('creates directed associations with semantic ownership, BaseElement refs, and DI', async () => {
    const context = await engine.createProcess('Association semantics');
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Reviewed task',
      position: { x: 120, y: 160 }
    });
    const annotation = await engine.createElement(context.id, {
      type: 'bpmn:TextAnnotation',
      properties: { text: 'Review note' },
      position: { x: 420, y: 170 }
    });

    const directed = await engine.addAssociation(context.id, annotation.id, task.id, 'Both');
    const undirected = await engine.addAssociation(context.id, task.id, annotation.id);
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const process = definitions.rootElements.find((root: any) => root.id === context.id);
    const serializedDirected = process.artifacts.find((item: any) => item.id === directed.id);
    const serializedUndirected = process.artifacts.find((item: any) => item.id === undirected.id);

    expect(directed).toMatchObject({
      type: 'bpmn:Association',
      ownerId: context.id,
      scopeId: context.id,
      associationDirection: 'Both'
    });
    expect(serializedDirected).toMatchObject({
      $type: 'bpmn:Association',
      associationDirection: 'Both'
    });
    expect(serializedDirected.sourceRef.id).toBe(annotation.id);
    expect(serializedDirected.targetRef.id).toBe(task.id);
    expect(serializedUndirected.associationDirection).toBe('None');
    const edge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === directed.id
    );
    expect(edge?.$type).toBe('bpmndi:BPMNEdge');
    expect(edge.bpmnElement).toBe(serializedDirected);
    expect(edge.waypoint).toHaveLength(2);
  });

  it('creates and round-trips formatted text annotations with exact text, bounds, and association DI', async () => {
    const context = await engine.createProcess('Annotation semantics');
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Review note',
      position: { x: 420, y: 180 }
    });
    const text = '  First line & <context>\nSecond "line"  ';
    const { annotation, association } = await engine.addTextAnnotation(context.id, text, {
      textFormat: 'text/markdown',
      position: { x: 120, y: 80 },
      size: { width: 240, height: 90 },
      associatedElementId: task.id
    });

    expect(annotation).toMatchObject({
      type: 'bpmn:TextAnnotation',
      ownerId: context.id,
      scopeId: context.id,
      position: { x: 120, y: 80 },
      size: { width: 240, height: 90 },
      properties: { text, textFormat: 'text/markdown' }
    });
    expect(association).toMatchObject({
      type: 'bpmn:Association',
      source: annotation.id,
      target: task.id,
      associationDirection: 'None'
    });

    const xml = await engine.exportXml(context.id);
    const parsed = await moddle.fromXML(xml);
    const parsedAnnotation = parsed.elementsById[annotation.id];
    const parsedAssociation = parsed.elementsById[association!.id];
    expect(parsedAnnotation).toMatchObject({
      $type: 'bpmn:TextAnnotation',
      text,
      textFormat: 'text/markdown'
    });
    expect(parsed.elementsById[`${annotation.id}_di`]).toMatchObject({
      bpmnElement: parsedAnnotation,
      bounds: expect.objectContaining({ x: 120, y: 80, width: 240, height: 90 })
    });
    expect(parsedAssociation).toMatchObject({
      sourceRef: parsedAnnotation,
      targetRef: parsed.elementsById[task.id],
      associationDirection: 'None'
    });
    expect(parsed.elementsById[`${association!.id}_di`].bpmnElement).toBe(parsedAssociation);

    const imported = await engine.importXml(xml);
    expect(imported.elements.get(annotation.id)).toMatchObject({
      position: { x: 120, y: 80 },
      size: { width: 240, height: 90 },
      properties: { text, textFormat: 'text/markdown' }
    });
    expect(imported.connections.get(association!.id)).toMatchObject({
      source: annotation.id,
      target: task.id,
      associationDirection: 'None'
    });
  });

  it('rejects a missing text-annotation association target before mutation', async () => {
    const context = await engine.createProcess('Rejected annotation');
    const xmlBefore = await engine.exportXml(context.id);

    await expect(engine.addTextAnnotation(context.id, 'Orphaned note', {
      associatedElementId: 'Task_Missing'
    })).rejects.toThrow('Associated element Task_Missing not found');

    expect(context.elements.size).toBe(0);
    expect(context.connections.size).toBe(0);
    expect(await engine.exportXml(context.id)).toBe(xmlBefore);
  });

  it('resolves the nearest compatible association scope and rejects invalid endpoints atomically', async () => {
    const context = await engine.createProcess('Association scopes', 'collaboration');
    const buyer = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Buyer' });
    const seller = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Seller' });
    if (buyer.kind !== 'participant' || seller.kind !== 'participant'
      || !buyer.processRef || !seller.processRef) {
      throw new Error('Expected two participant process owners');
    }
    const subprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess', ownerId: buyer.processRef, scopeId: buyer.processRef
    });
    const nestedTask = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: buyer.processRef, scopeId: subprocess.id
    });
    const nestedNote = await engine.createElement(context.id, {
      type: 'bpmn:TextAnnotation', ownerId: buyer.processRef, scopeId: subprocess.id
    });
    const sellerTask = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: seller.processRef, scopeId: seller.processRef
    });

    const association = await engine.addAssociation(context.id, nestedTask.id, nestedNote.id, 'One');
    expect(association).toMatchObject({ ownerId: buyer.processRef, scopeId: subprocess.id });
    const xmlBeforeReject = await engine.exportXml(context.id);
    const countBeforeReject = context.connections.size;

    await expect(engine.addAssociation(context.id, nestedTask.id, sellerTask.id))
      .rejects.toThrow('cannot cross process ownership boundaries');
    await expect(engine.addAssociation(context.id, nestedTask.id, 'Missing_BaseElement'))
      .rejects.toThrow('Source or target element not found');
    await expect(engine.addAssociation(
      context.id,
      nestedTask.id,
      nestedNote.id,
      'Sideways' as never
    )).rejects.toThrow('Invalid association direction');
    expect(context.connections.size).toBe(countBeforeReject);
    expect(await engine.exportXml(context.id)).toBe(xmlBeforeReject);
  });

  it('deletes an association independently and cascades it when an annotation is deleted', async () => {
    const context = await engine.createProcess('Association deletion');
    const task = await engine.createElement(context.id, { type: 'bpmn:Task' });
    const annotation = await engine.createElement(context.id, { type: 'bpmn:TextAnnotation' });
    const first = await engine.addAssociation(context.id, annotation.id, task.id);

    await engine.deleteAssociation(context.id, first.id);
    expect(context.elements.has(annotation.id)).toBe(true);
    expect(context.elements.has(task.id)).toBe(true);
    expect(context.connections.has(first.id)).toBe(false);

    const second = await engine.addAssociation(context.id, annotation.id, task.id, 'One');
    await expect(engine.deleteElement(context.id, annotation.id)).resolves.toBe(1);
    expect(context.elements.has(annotation.id)).toBe(false);
    expect(context.elements.has(task.id)).toBe(true);
    expect(context.connections.has(second.id)).toBe(false);
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    expect(findSemantic(definitions, annotation.id)).toBeUndefined();
    expect(findSemantic(definitions, second.id)).toBeUndefined();
  });

  it('creates expanded subprocess children across flow-node kinds and rejects boundary crossings', async () => {
    const context = await engine.createProcess('Expanded subprocess');
    const subprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess',
      name: 'Review',
      position: { x: 300, y: 200 }
    });
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      name: 'Nested start',
      ownerId: context.id,
      scopeId: subprocess.id,
      position: { x: 250, y: 170 }
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:UserTask',
      name: 'Nested task',
      ownerId: context.id,
      scopeId: subprocess.id,
      position: { x: 450, y: 260 }
    });
    const gateway = await engine.createElement(context.id, {
      type: 'bpmn:ExclusiveGateway',
      name: 'Nested decision',
      ownerId: context.id,
      scopeId: subprocess.id,
      position: { x: 700, y: 280 }
    });
    const nestedFlow = await engine.connect(context.id, start.id, task.id);
    await engine.connect(context.id, task.id, gateway.id);
    const outside = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Outside'
    });

    await expect(engine.connect(context.id, gateway.id, outside.id))
      .rejects.toThrow('nested-scope boundaries');

    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const serializedSubprocess = findSemantic(definitions, subprocess.id);
    expect(serializedSubprocess.flowElements.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([start.id, task.id, gateway.id, nestedFlow.id])
    );

    const shapes = definitions.diagrams[0].plane.planeElement.filter(
      (item: any) => item.$type === 'bpmndi:BPMNShape'
    );
    const subprocessShape = shapes.find((item: any) => item.bpmnElement.id === subprocess.id);
    expect(subprocessShape.isExpanded).toBe(true);
    for (const childId of [start.id, task.id, gateway.id]) {
      const childShape = shapes.find((item: any) => item.bpmnElement.id === childId);
      expect(childShape.bounds.x).toBeGreaterThanOrEqual(subprocessShape.bounds.x);
      expect(childShape.bounds.y).toBeGreaterThanOrEqual(subprocessShape.bounds.y);
      expect(childShape.bounds.x + childShape.bounds.width)
        .toBeLessThanOrEqual(subprocessShape.bounds.x + subprocessShape.bounds.width);
      expect(childShape.bounds.y + childShape.bounds.height)
        .toBeLessThanOrEqual(subprocessShape.bounds.y + subprocessShape.bounds.height);
    }
  });

  it('requires a subprocess to be expanded before adding nested flow nodes', async () => {
    const context = await engine.createProcess('Collapsed subprocess');
    const subprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess',
      name: 'Collapsed',
      properties: { isExpanded: false }
    });

    await expect(engine.createElement(context.id, {
      type: 'bpmn:Task',
      ownerId: context.id,
      scopeId: subprocess.id
    })).rejects.toThrow('expanded');

    await engine.updateElement(context.id, subprocess.id, { properties: { isExpanded: true } });
    const nested = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess',
      ownerId: context.id,
      scopeId: subprocess.id
    });
    const nestedGateway = await engine.createElement(context.id, {
      type: 'bpmn:ParallelGateway',
      ownerId: context.id,
      scopeId: nested.id
    });
    expect(nestedGateway.scopeId).toBe(nested.id);
  });

  it('passes subprocess ownership through every MCP flow-node creation tool', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Tool-created subprocess' });
    const context = diagramContext.getCurrent();
    const subprocessResult = await handler.handleRequest('add_activity', {
      activityType: 'subProcess',
      name: 'Tool scope'
    });
    expect(subprocessResult.isError).toBeUndefined();
    const subprocessId = (subprocessResult.content[0].text as string).split('ID: ')[1];

    const results = await Promise.all([
      handler.handleRequest('add_event', {
        eventType: 'start',
        name: 'Tool event',
        ownerId: context.id,
        scopeId: subprocessId
      }),
      handler.handleRequest('add_activity', {
        activityType: 'task',
        name: 'Tool activity',
        ownerId: context.id,
        scopeId: subprocessId
      }),
      handler.handleRequest('add_gateway', {
        gatewayType: 'exclusive',
        name: 'Tool gateway',
        ownerId: context.id,
        scopeId: subprocessId
      })
    ]);
    expect(results.every(result => result.isError === undefined)).toBe(true);

    const children = Array.from(context.elements.values())
      .filter(element => element.scopeId === subprocessId);
    expect(children.map(element => element.type)).toEqual(
      expect.arrayContaining(['bpmn:StartEvent', 'bpmn:Task', 'bpmn:ExclusiveGateway'])
    );
    expect(children.every(element => element.ownerId === context.id)).toBe(true);
    expect(findSemantic(await exportedDefinitions(), subprocessId).flowElements).toHaveLength(3);
  });

  it('preserves subprocess hierarchy and DI through save, reopen, and mutation', async () => {
    const context = await engine.createProcess('Persistent subprocess');
    const subprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess',
      name: 'Persistent scope',
      position: { x: 240, y: 160 }
    });
    const child = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Original child',
      ownerId: context.id,
      scopeId: subprocess.id,
      position: { x: 320, y: 240 }
    });
    await engine.save(context.id);

    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(context.filename!);
    expect(reopened.elements.get(child.id)).toMatchObject({
      ownerId: context.id,
      scopeId: subprocess.id,
      position: { x: 320, y: 240 }
    });
    const gateway = await reopenedEngine.createElement(reopened.id, {
      type: 'bpmn:InclusiveGateway',
      name: 'Added after reopen',
      ownerId: context.id,
      scopeId: subprocess.id
    });
    await reopenedEngine.connect(reopened.id, child.id, gateway.id);

    const definitions = (await moddle.fromXML(await reopenedEngine.exportXml(reopened.id))).rootElement;
    const serializedSubprocess = findSemantic(definitions, subprocess.id);
    expect(serializedSubprocess.flowElements.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([child.id, gateway.id])
    );
    const subprocessShape = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement?.id === subprocess.id
    );
    expect(subprocessShape.isExpanded).toBe(true);
  });

  it('deletes a non-empty subprocess and its complete nested hierarchy deterministically', async () => {
    const context = await engine.createProcess('Delete subprocess');
    const outside = await engine.createElement(context.id, { type: 'bpmn:Task', name: 'Outside' });
    const subprocess = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess', name: 'Delete me'
    });
    const nested = await engine.createElement(context.id, {
      type: 'bpmn:SubProcess', ownerId: context.id, scopeId: subprocess.id
    });
    const child = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: context.id, scopeId: nested.id
    });
    const childEnd = await engine.createElement(context.id, {
      type: 'bpmn:EndEvent', ownerId: context.id, scopeId: nested.id
    });
    await engine.connect(context.id, outside.id, subprocess.id);
    await engine.connect(context.id, child.id, childEnd.id);

    await expect(engine.deleteElement(context.id, subprocess.id)).resolves.toBe(2);
    expect(context.elements.has(outside.id)).toBe(true);
    expect(context.elements.has(subprocess.id)).toBe(false);
    expect(context.elements.has(nested.id)).toBe(false);
    expect(context.elements.has(child.id)).toBe(false);
    expect(context.elements.has(childEnd.id)).toBe(false);
    expect(context.connections.size).toBe(0);
    expect(findSemantic(
      (await moddle.fromXML(await engine.exportXml(context.id))).rootElement,
      subprocess.id
    )).toBeUndefined();
  });

  it('keeps a shared process root when one of its participants is deleted', async () => {
    const context = await engine.createProcess('Shared process', 'collaboration');
    const first = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'First' });
    expect(first.kind).toBe('participant');
    if (first.kind !== 'participant' || !first.processRef) {
      throw new Error('Expected a white-box participant with processRef');
    }
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent', ownerId: first.processRef, scopeId: first.processRef
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: first.processRef, scopeId: first.processRef
    });
    const flow = await engine.connect(context.id, start.id, task.id);
    const second = await engine.createElement(context.id, {
      type: 'bpmn:Participant',
      name: 'Second',
      properties: { processRef: first.processRef }
    });

    await engine.deleteElement(context.id, first.id);
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const collaboration = definitions.rootElements.find((root: any) => root.id === context.id);
    expect(collaboration.participants.map((participant: any) => participant.id)).toEqual([second.id]);
    expect(collaboration.participants[0].processRef.id).toBe(first.processRef);
    expect(definitions.rootElements.some((root: any) => root.id === first.processRef)).toBe(true);
    const sharedProcess = definitions.rootElements.find((root: any) => root.id === first.processRef);
    expect(sharedProcess.flowElements.map((item: any) => item.id)).toEqual(
      expect.arrayContaining([start.id, task.id, flow.id])
    );
  });

  it('deleting a sole participant removes its process, owned contents, connections, and DI', async () => {
    const context = await engine.createProcess('Delete owner', 'collaboration');
    const participant = await engine.createElement(context.id, { type: 'bpmn:Participant', name: 'Buyer' });
    expect(participant.kind).toBe('participant');
    if (participant.kind !== 'participant' || !participant.processRef) {
      throw new Error('Expected a white-box participant with processRef');
    }
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent', ownerId: participant.processRef, scopeId: participant.processRef
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task', ownerId: participant.processRef, scopeId: participant.processRef
    });
    const flow = await engine.connect(context.id, start.id, task.id);

    await engine.deleteElement(context.id, participant.id);
    expect(context.document.processes.has(participant.processRef)).toBe(false);
    expect(context.elements.has(start.id)).toBe(false);
    expect(context.elements.has(task.id)).toBe(false);
    expect(context.connections.has(flow.id)).toBe(false);
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    expect(definitions.rootElements.some((root: any) => root.id === participant.processRef)).toBe(false);
    expect(definitions.diagrams[0].plane.planeElement || []).toHaveLength(0);
  });

  it('recomputes connection DI after auto-layout moves elements', async () => {
    const context = await engine.createProcess('Auto layout DI');
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      position: { x: 10, y: 10 }
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      position: { x: 500, y: 500 }
    });
    const flow = await engine.connect(context.id, start.id, task.id);

    await engine.applyAutoLayout(context.id);
    const definitions = (await moddle.fromXML(await engine.exportXml(context.id))).rootElement;
    const edge = definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.bpmnElement.id === flow.id
    );
    const waypoints = edge.waypoint.map((point: any) => ({ x: point.x, y: point.y }));
    const laidOutStart = context.elements.get(start.id)!;
    const laidOutTask = context.elements.get(task.id)!;
    expect(waypoints[0]).toEqual({
      x: laidOutStart.position.x + laidOutStart.size.width,
      y: laidOutStart.position.y + laidOutStart.size.height / 2
    });
    expect(waypoints.at(-1)).toEqual({
      x: laidOutTask.position.x,
      y: laidOutTask.position.y + laidOutTask.size.height / 2
    });
    expect(context.connections.get(flow.id)?.waypoints).toEqual(waypoints);
  });

  it('serializes, imports, updates, and saves conditional and default sequence flows', async () => {
    const specialCondition = '${amount < 10 && customer === "Zürich & Ω"}';
    const context = await engine.createProcess('Conditional routing');
    const gateway = await engine.createElement(context.id, {
      type: 'bpmn:ExclusiveGateway',
      name: 'Route'
    });
    const conditionalTarget = await engine.createElement(context.id, { type: 'bpmn:Task' });
    const defaultTarget = await engine.createElement(context.id, { type: 'bpmn:Task' });
    const plainTarget = await engine.createElement(context.id, { type: 'bpmn:Task' });
    const conditional = await engine.connect(
      context.id,
      gateway.id,
      conditionalTarget.id,
      'conditional label',
      {
        condition: specialCondition,
        conditionLanguage: 'FEEL',
        conditionType: 'bpmn:FormalExpression'
      }
    );
    const defaultFlow = await engine.connect(
      context.id,
      gateway.id,
      defaultTarget.id,
      'otherwise',
      { isDefault: true }
    );
    const plain = await engine.connect(
      context.id,
      gateway.id,
      plainTarget.id,
      'plain label'
    );

    expect(context.connections.get(conditional.id)?.condition).toEqual({
      body: specialCondition,
      language: 'FEEL',
      type: 'bpmn:FormalExpression'
    });
    expect(context.elements.get(gateway.id)).toMatchObject({ defaultFlow: defaultFlow.id });

    const firstXml = await engine.exportXml(context.id);
    const firstParsed = await moddle.fromXML(firstXml);
    expect(firstParsed.elementsById[conditional.id].conditionExpression).toMatchObject({
      $type: 'bpmn:FormalExpression',
      body: specialCondition,
      language: 'FEEL'
    });
    expect(firstParsed.elementsById[plain.id].conditionExpression).toBeUndefined();
    expect(firstParsed.elementsById[defaultFlow.id].conditionExpression).toBeUndefined();
    expect(firstParsed.elementsById[gateway.id].default)
      .toBe(firstParsed.elementsById[defaultFlow.id]);

    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(context.filename!);
    expect(reopened.connections.get(conditional.id)?.condition).toEqual({
      body: specialCondition,
      language: 'FEEL',
      type: 'bpmn:FormalExpression',
      evaluatesToTypeRef: undefined
    });
    expect(reopened.elements.get(gateway.id)).toMatchObject({ defaultFlow: defaultFlow.id });
    await reopenedEngine.updateElement(reopened.id, conditionalTarget.id, { name: 'Updated target' });
    await reopenedEngine.save(reopened.id);
    const afterUpdate = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(afterUpdate.elementsById[conditional.id].conditionExpression.body).toBe(specialCondition);
    expect(afterUpdate.elementsById[gateway.id].default)
      .toBe(afterUpdate.elementsById[defaultFlow.id]);

    await reopenedEngine.updateElement(reopened.id, gateway.id, {
      defaultFlow: plain.id
    });
    const afterReassignment = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(afterReassignment.elementsById[gateway.id].default)
      .toBe(afterReassignment.elementsById[plain.id]);

    await reopenedEngine.updateElement(reopened.id, gateway.id, {
      defaultFlow: null
    });
    const afterClear = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    expect(afterClear.elementsById[gateway.id].default).toBeUndefined();
    const afterClearEngine = new SimpleBpmnEngine(directory);
    const afterClearContext = await afterClearEngine.loadDiagram(reopened.filename!);
    const clearedGateway = afterClearContext.elements.get(gateway.id);
    if (clearedGateway?.kind !== 'flowNode') throw new Error('Expected reopened gateway');
    expect(clearedGateway.defaultFlow).toBeUndefined();
  });

  it('rejects invalid conditional/default combinations without mutating state', async () => {
    const context = await engine.createProcess('Conditional validation');
    const start = await engine.createElement(context.id, { type: 'bpmn:StartEvent' });
    const task = await engine.createElement(context.id, { type: 'bpmn:Task' });
    const parallel = await engine.createElement(context.id, { type: 'bpmn:ParallelGateway' });

    await expect(engine.connect(context.id, start.id, task.id, undefined, {
      condition: '${invalid}'
    })).rejects.toThrow('cannot own a conditional sequence flow');
    await expect(engine.connect(context.id, parallel.id, task.id, undefined, {
      isDefault: true
    })).rejects.toThrow('cannot own a default sequence flow');
    await expect(engine.connect(context.id, task.id, parallel.id, undefined, {
      condition: '${approved}',
      isDefault: true
    })).rejects.toThrow('default sequence flow cannot have a condition');
    await expect(engine.connect(context.id, task.id, parallel.id, undefined, {
      conditionLanguage: 'FEEL'
    })).rejects.toThrow('requires a condition expression');
    await expect(engine.connect(context.id, task.id, parallel.id, undefined, {
      isDefault: 'true' as never
    })).rejects.toThrow('isDefault must be a boolean');
    expect(context.connections.size).toBe(0);
  });

  it('rejects invalid imported conditional/default flow semantics', async () => {
    const invalidSource = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="Definitions_InvalidSource" targetNamespace="urn:test">
  <bpmn:process id="Process_InvalidSource">
    <bpmn:startEvent id="Start_Invalid" />
    <bpmn:task id="Task_Invalid" />
    <bpmn:sequenceFlow id="Flow_Invalid" sourceRef="Start_Invalid" targetRef="Task_Invalid">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${invalid}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;
    const conditionalDefault = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="Definitions_InvalidDefault" targetNamespace="urn:test">
  <bpmn:process id="Process_InvalidDefault">
    <bpmn:exclusiveGateway id="Gateway_Invalid" default="Flow_InvalidDefault" />
    <bpmn:task id="Task_InvalidDefault" />
    <bpmn:sequenceFlow id="Flow_InvalidDefault"
      sourceRef="Gateway_Invalid" targetRef="Task_InvalidDefault">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${invalid}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;

    await expect(engine.importXml(invalidSource)).rejects.toThrow('Failed to parse BPMN XML');
    await expect(engine.importXml(conditionalDefault)).rejects.toThrow('Failed to parse BPMN XML');
    expect(() => engine.getProcess('Process_InvalidSource')).toThrow('not found');
    expect(() => engine.getProcess('Process_InvalidDefault')).toThrow('not found');
  });

  it('preserves opaque metadata on an imported formal condition during updates', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:custom="urn:test:condition" id="Definitions_Metadata" targetNamespace="urn:test">
  <bpmn:process id="Process_Metadata">
    <bpmn:task id="Task_Source" />
    <bpmn:task id="Task_Target" />
    <bpmn:sequenceFlow id="Flow_Metadata" sourceRef="Task_Source" targetRef="Task_Target">
      <bpmn:conditionExpression id="Expression_Metadata"
        xsi:type="bpmn:tFormalExpression" language="FEEL"><bpmn:extensionElements><custom:metadata value="keep-me" /></bpmn:extensionElements>\${approved}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;
    const imported = await engine.importXml(xml);

    await engine.updateElement(imported.id, 'Task_Target', { name: 'Updated' });
    const parsed = await moddle.fromXML(await engine.exportXml(imported.id));
    expect(parsed.elementsById.Expression_Metadata).toMatchObject({
      $type: 'bpmn:FormalExpression',
      language: 'FEEL'
    });
    expect(parsed.elementsById.Expression_Metadata.body.trim()).toBe('${approved}');
    expect(parsed.elementsById.Expression_Metadata.extensionElements.values[0].value)
      .toBe('keep-me');
  });

  it('rejects conditions on inferred message flows', async () => {
    const context = await engine.createProcess('Conditional messages', 'collaboration');
    const buyer = await engine.createElement(context.id, { type: 'bpmn:Participant' });
    const seller = await engine.createElement(context.id, { type: 'bpmn:Participant' });
    if (buyer.kind !== 'participant' || seller.kind !== 'participant'
      || !buyer.processRef || !seller.processRef) {
      throw new Error('Expected white-box participants');
    }
    const send = await engine.createElement(context.id, {
      type: 'bpmn:SendTask', ownerId: buyer.processRef
    });
    const receive = await engine.createElement(context.id, {
      type: 'bpmn:ReceiveTask', ownerId: seller.processRef
    });

    await expect(engine.connect(context.id, send.id, receive.id, undefined, {
      condition: '${notAllowed}'
    })).rejects.toThrow('Conditions can only be added to sequence flows');
    expect(context.connections.size).toBe(0);
  });

  it('round-trips XML metacharacters, Unicode, refs, and DI through mutations and import', async () => {
    const special = `& < > " ' Zürich Ω 🚀`;
    const context = await engine.createProcess(`Process ${special}`);
    const start = await engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      name: `Start ${special}`,
      position: { x: 25, y: 50 }
    });
    const task = await engine.createElement(context.id, {
      type: 'bpmn:UserTask',
      name: 'Before update',
      position: { x: 225, y: 50 }
    });
    const flow = await engine.connect(context.id, start.id, task.id, `Flow ${special}`);
    await engine.updateElement(context.id, task.id, { name: `Task ${special}` });

    const firstXml = await engine.exportXml(context.id);
    const firstDefinitions = (await moddle.fromXML(firstXml)).rootElement;
    expect(firstDefinitions.rootElements[0].name).toBe(`Process ${special}`);
    expect(findSemantic(firstDefinitions, start.id).name).toBe(`Start ${special}`);
    expect(findSemantic(firstDefinitions, task.id).name).toBe(`Task ${special}`);
    expect(findSemantic(firstDefinitions, flow.id).name).toBe(`Flow ${special}`);

    const firstSummary = summarize(firstDefinitions);
    const imported = await engine.importXml(firstXml);
    const secondDefinitions = (await moddle.fromXML(await engine.exportXml(imported.id))).rootElement;
    expect(summarize(secondDefinitions)).toEqual(firstSummary);

    const removed = await engine.deleteElement(imported.id, task.id);
    expect(removed).toBe(1);
    const afterDelete = (await moddle.fromXML(await engine.exportXml(imported.id))).rootElement;
    expect(findSemantic(afterDelete, task.id)).toBeUndefined();
    expect(findSemantic(afterDelete, flow.id)).toBeUndefined();
    expect(afterDelete.diagrams[0].plane.bpmnElement.id).toBe(imported.id);
    expect(afterDelete.diagrams[0].plane.planeElement.map((item: any) => item.bpmnElement.id))
      .toEqual([start.id]);
  });
});
