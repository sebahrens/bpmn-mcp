import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import { parseToolRequest, tools, type ToolArguments } from '../../src/server/tools.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

describe('typed activity property validation', () => {
  let directory: string;
  let handler: BpmnRequestHandler;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-property-validation-'));
    IdGenerator.reset();
    diagramContext.clear();
    handler = new BpmnRequestHandler(new SimpleBpmnEngine(directory));

    await expectSuccess(handler.handleRequest('new_bpmn', {
      name: 'Property safety',
      extensionProfile: 'camunda7'
    }));
    await expectSuccess(handler.handleRequest('add_activity', {
      activityType: 'userTask',
      name: 'First task',
      properties: { assignee: 'alice', candidateGroups: ['reviewers'] }
    }));
    await expectSuccess(handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Second task'
    }));
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['prototype key', JSON.parse('{"__proto__":{"polluted":"yes"}}')],
    ['qualified attribute', { 'camunda:assignee': 'mallory' }],
    ['raw XML', { rawXml: '<camunda:script />' }],
    ['nested arbitrary data', { metadata: { priority: 3 } }]
  ])('rejects %s for create and update without mutation', async (_label, properties) => {
    const before = snapshotElements();
    const createResult = await handler.handleRequest('add_activity', {
      activityType: 'userTask',
      name: 'Rejected task',
      properties
    });
    const updateResult = await handler.handleRequest('update_element', {
      elementId: 'UserTask_1',
      name: 'Rejected update',
      properties
    });

    expect(createResult.isError).toBe(true);
    expect(updateResult.isError).toBe(true);
    expect(createResult.content[0].text).toContain('Invalid arguments for tool "add_activity"');
    expect(updateResult.content[0].text).toContain('Invalid arguments for tool "update_element"');
    expect(snapshotElements()).toEqual(before);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['blank assignee', { assignee: '   ' }],
    ['empty groups', { candidateGroups: [] }],
    ['comma in group', { candidateGroups: ['reviewers,admins'] }],
    ['string groups', { candidateGroups: 'reviewers' }],
    ['unknown property', { implementation: 'delegate' }]
  ])('rejects invalid typed payload: %s', async (_label, properties) => {
    const before = snapshotElements();
    const result = await handler.handleRequest('add_activity', {
      activityType: 'userTask',
      name: 'Rejected task',
      properties
    });
    expect(result.isError).toBe(true);
    expect(snapshotElements()).toEqual(before);
  });

  it('copies typed arrays away from the caller payload', () => {
    const source = { candidateGroups: ['reviewers', 'operations'] };
    const parsed = parseToolRequest('add_activity', {
      activityType: 'userTask',
      name: 'Safe task',
      properties: source
    });
    const properties = (parsed.args as ToolArguments<'add_activity'>).properties!;

    expect(properties).not.toBe(source);
    expect(properties.candidateGroups).not.toBe(source.candidateGroups);
    expect(properties).toEqual(source);
  });

  it('advertises closed typed schemas for both mutation tools', () => {
    const addSchema = tools.find(tool => tool.name === 'add_activity')!.inputSchema as any;
    const updateSchema = tools.find(tool => tool.name === 'update_element')!.inputSchema as any;
    expect(addSchema.properties.properties.additionalProperties).toBe(false);
    expect(updateSchema.properties.properties.additionalProperties).toBe(false);
    // isForCompensation and triggeredByEvent were added so a compensation
    // handler and an event subprocess can be authored at all; the engine
    // supported both but no tool accepted them (mcp-bpmn-9sv.18, mcp-bpmn-9sv.20).
    expect(Object.keys(addSchema.properties.properties.properties).sort()).toEqual([
      'assignee', 'calledElement', 'candidateGroups', 'dueDate', 'isExpanded',
      'isForCompensation', 'multiInstance', 'triggeredByEvent'
    ]);
    expect(updateSchema.properties.properties.properties.assignee.anyOf)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        { type: 'null' }
      ]));
  });

  it('round-trips typed properties and isolates element updates', async () => {
    await expectSuccess(handler.handleRequest('update_element', {
      elementId: 'UserTask_1',
      properties: { assignee: 'bob', candidateGroups: ['approvers'] }
    }));

    const first = await getElement('UserTask_1');
    const second = await getElement('Task_1');
    expect(first.properties).toMatchObject({
      assignee: 'bob',
      candidateGroups: ['approvers']
    });
    expect(second.properties).toEqual({});
  });

  function snapshotElements(): unknown {
    return Array.from(
      diagramContext.getCurrent().elements.values(),
      element => structuredClone(element)
    );
  }

  async function getElement(elementId: string): Promise<Record<string, any>> {
    const result = await handler.handleRequest('get_element', { elementId });
    await expectSuccess(Promise.resolve(result));
    return result.structuredContent as Record<string, any>;
  }
});

async function expectSuccess(resultPromise: Promise<unknown>): Promise<void> {
  expect((await resultPromise as { isError?: boolean }).isError).not.toBe(true);
}
