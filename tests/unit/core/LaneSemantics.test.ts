import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import BpmnModdle from 'bpmn-moddle';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { IdGenerator } from '../../../src/utils/IdGenerator.js';
import { TOOL_INPUT_LIMITS, tools } from '../../../src/server/tools.js';

describe('lane semantics', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;
  let handler: BpmnRequestHandler;
  const moddle = new BpmnModdle();

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-lanes-'));
    IdGenerator.reset();
    diagramContext.clear();
    engine = new SimpleBpmnEngine(directory);
    handler = new BpmnRequestHandler(engine);
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const exportDefinitions = async (): Promise<any> => {
    const result = await handler.handleRequest('export', {});
    expect(result.isError).toBeUndefined();
    return (await moddle.fromXML(result.content[0].text)).rootElement;
  };

  const shapeFor = (definitions: any, elementId: string): any =>
    definitions.diagrams[0].plane.planeElement.find(
      (item: any) => item.$type === 'bpmndi:BPMNShape' && item.bpmnElement?.id === elementId
    );

  const contains = (outer: any, inner: any): boolean =>
    inner.x >= outer.x && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width
      && inner.y + inner.height <= outer.y + outer.height;

  it('advertises required assignments and persists two laid-out lanes across reopen and mutation', async () => {
    const laneTool = tools.find(tool => tool.name === 'add_lane')!;
    // name became optional when add_lane learned to target an existing lane by
    // id, where the name is a rename rather than a requirement (mcp-bpmn-9sv.19).
    expect(laneTool.inputSchema.required).toEqual(['poolId', 'flowNodeIds']);
    expect((laneTool.inputSchema.properties!.flowNodeIds as any).minItems).toBe(1);

    await handler.handleRequest('new_bpmn', { name: 'Departments', type: 'collaboration' });
    await handler.handleRequest('add_pool', { name: 'Company', position: { x: 40, y: 60 } });
    await handler.handleRequest('add_event', {
      eventType: 'start', name: 'Receive', ownerId: 'Participant_1_Process'
    });
    await handler.handleRequest('add_activity', {
      activityType: 'userTask', name: 'Review', ownerId: 'Participant_1_Process'
    });
    await handler.handleRequest('add_event', {
      eventType: 'boundary',
      name: 'Review timeout',
      eventDefinition: 'timer',
      eventDefinitionPayload: {
        timer: { type: 'timeDuration', expression: 'PT1H' }
      },
      attachTo: 'UserTask_1',
      ownerId: 'Participant_1_Process'
    });

    const sales = await handler.handleRequest('add_lane', {
      poolId: 'Participant_1', name: 'Sales', flowNodeIds: ['StartEvent_1'], position: 'top'
    });
    const operations = await handler.handleRequest('add_lane', {
      poolId: 'Participant_1', name: 'Operations', flowNodeIds: ['UserTask_1'], position: 'bottom'
    });
    expect(sales.isError).toBeUndefined();
    expect(operations.isError).toBeUndefined();

    let definitions = await exportDefinitions();
    let process = definitions.rootElements.find((root: any) => root.id === 'Participant_1_Process');
    expect(process.laneSets).toHaveLength(1);
    expect(process.laneSets[0].lanes.map((lane: any) => [
      lane.name,
      lane.flowNodeRef.map((node: any) => node.id)
    // A boundary event joins its host's lane, the way bpmn-js records it: the
    // geometry oracle reads lane ancestry from flowNodeRef, and without the
    // membership the event's unavoidable overlap with the band it is drawn in
    // reads as an error no layout can clear (mcp-bpmn-3g8.17).
    ])).toEqual([
      ['Sales', ['StartEvent_1']],
      ['Operations', ['UserTask_1', 'BoundaryEvent_1']]
    ]);

    const participantBounds = shapeFor(definitions, 'Participant_1').bounds;
    for (const [laneId, nodeId] of [['Lane_1', 'StartEvent_1'], ['Lane_2', 'UserTask_1']]) {
      const laneBounds = shapeFor(definitions, laneId).bounds;
      const nodeBounds = shapeFor(definitions, nodeId).bounds;
      expect(contains(participantBounds, laneBounds)).toBe(true);
      expect(contains(laneBounds, nodeBounds)).toBe(true);
    }
    const hostBounds = shapeFor(definitions, 'UserTask_1').bounds;
    const boundaryBounds = shapeFor(definitions, 'BoundaryEvent_1').bounds;
    const boundaryCenter = {
      x: boundaryBounds.x + boundaryBounds.width / 2,
      y: boundaryBounds.y + boundaryBounds.height / 2
    };
    expect(
      boundaryCenter.x === hostBounds.x
      || boundaryCenter.x === hostBounds.x + hostBounds.width
      || boundaryCenter.y === hostBounds.y
      || boundaryCenter.y === hostBounds.y + hostBounds.height
    ).toBe(true);

    const filename = diagramContext.getCurrent().filename!;
    await handler.handleRequest('close', {});
    expect((await handler.handleRequest('open_bpmn', { filename })).isError).toBeUndefined();
    expect((await handler.handleRequest('update_element', {
      elementId: 'UserTask_1', name: 'Review reopened'
    })).isError).toBeUndefined();
    definitions = await exportDefinitions();
    process = definitions.rootElements.find((root: any) => root.id === 'Participant_1_Process');
    expect(process.laneSets[0].lanes[1].flowNodeRef.map((node: any) => node.id))
      .toEqual(['UserTask_1', 'BoundaryEvent_1']);
    expect(process.flowElements.find((node: any) => node.id === 'UserTask_1').name)
      .toBe('Review reopened');
    expect(shapeFor(definitions, 'Lane_2')).toBeDefined();
  });

  it('rejects invalid pool, process, and member IDs atomically', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Invalid lanes', type: 'collaboration' });
    await handler.handleRequest('add_pool', { name: 'Internal' });
    await handler.handleRequest('add_pool', { name: 'External', blackBox: true });
    await handler.handleRequest('add_activity', {
      activityType: 'task', name: 'Owned', ownerId: 'Participant_1_Process'
    });
    const before = await engine.exportXml(diagramContext.getCurrent().id);

    for (const args of [
      { poolId: 'Missing', name: 'Bad', flowNodeIds: ['Task_1'] },
      { poolId: 'Participant_2', name: 'Bad', flowNodeIds: ['Task_1'] },
      { poolId: 'Participant_1', name: 'Bad', flowNodeIds: ['Missing'] },
      { poolId: 'Participant_1', name: 'Bad', flowNodeIds: ['Participant_1'] }
    ]) {
      expect((await handler.handleRequest('add_lane', args)).isError).toBe(true);
    }
    expect(await engine.exportXml(diagramContext.getCurrent().id)).toBe(before);
  });

  it('moves assignments between lanes and removes references when a node or lane is deleted', async () => {
    await handler.handleRequest('new_bpmn', { name: 'Moves', type: 'collaboration' });
    await handler.handleRequest('add_pool', { name: 'Pool' });
    await handler.handleRequest('add_activity', {
      activityType: 'task', name: 'Task', ownerId: 'Participant_1_Process'
    });
    await handler.handleRequest('add_lane', {
      poolId: 'Participant_1', name: 'First', flowNodeIds: ['Task_1']
    });
    await handler.handleRequest('add_lane', {
      poolId: 'Participant_1', name: 'Second', flowNodeIds: ['Task_1']
    });

    let definitions = await exportDefinitions();
    let lanes = definitions.rootElements.find((root: any) => root.id === 'Participant_1_Process')
      .laneSets[0].lanes;
    expect(lanes[0].flowNodeRef || []).toHaveLength(0);
    expect(lanes[1].flowNodeRef.map((node: any) => node.id)).toEqual(['Task_1']);

    expect((await handler.handleRequest('delete_element', { elementId: 'Lane_1' })).isError)
      .toBeUndefined();
    expect((await handler.handleRequest('delete_element', { elementId: 'Task_1' })).isError)
      .toBeUndefined();
    definitions = await exportDefinitions();
    lanes = definitions.rootElements.find((root: any) => root.id === 'Participant_1_Process')
      .laneSets[0].lanes;
    expect(lanes.map((lane: any) => lane.id)).toEqual(['Lane_2']);
    expect(lanes[0].flowNodeRef || []).toHaveLength(0);
  });

  it('enforces flow-node count bounds at the direct engine boundary without mutation', async () => {
    const context = await engine.createProcess('Bounded lane', 'collaboration');
    const participant = await engine.createElement(context.id, {
      type: 'bpmn:Participant', name: 'Company'
    });
    if (participant.kind !== 'participant' || !participant.processRef) {
      throw new Error('Expected a white-box participant');
    }
    const flowNodeIds = Array.from(
      { length: TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems },
      (_, index) => `Task_${index}`
    );
    flowNodeIds.forEach((id, index) => context.elements.set(id, {
      kind: 'flowNode',
      id,
      type: 'bpmn:Task',
      name: `Task ${index}`,
      ownerId: participant.processRef!,
      scopeId: participant.processRef!,
      position: { x: 100 + index, y: 200 },
      size: { width: 100, height: 80 },
      properties: {}
    }));
    jest.spyOn((engine as unknown as {
      serializer: { serialize: () => Promise<string> };
    }).serializer, 'serialize').mockResolvedValue('<bpmn:definitions />');

    await expect(engine.addLane(
      context.id, participant.id, 'Maximum members', flowNodeIds
    )).resolves.toMatchObject({ flowNodeRefs: flowNodeIds });

    const lanesBefore = Array.from(context.document.lanes.entries());
    const xmlBefore = context.xml;
    const diskBefore = await fs.readFile(join(directory, context.filename!), 'utf8');
    await expect(engine.addLane(
      context.id,
      participant.id,
      'One member too many',
      [...flowNodeIds, 'Task_Overflow']
    )).rejects.toThrow(
      `A lane accepts at most ${TOOL_INPUT_LIMITS.laneFlowNodeIds.maxItems} flowNodeIds`
    );
    expect(Array.from(context.document.lanes.entries())).toEqual(lanesBefore);
    expect(context.xml).toBe(xmlBefore);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(diskBefore);
  });
});
