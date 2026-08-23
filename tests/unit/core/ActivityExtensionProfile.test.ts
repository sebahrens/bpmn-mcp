import BpmnModdle from 'bpmn-moddle';
import camundaDescriptor from 'camunda-bpmn-moddle/resources/camunda.json';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import { parseToolRequest, TOOL_INPUT_LIMITS, tools } from '../../../src/server/tools.js';
import { IdGenerator } from '../../../src/utils/IdGenerator.js';

describe('typed activity extension profiles', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;
  let handler: BpmnRequestHandler;
  const camundaModdle = new BpmnModdle({ camunda: camundaDescriptor });

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-activity-profile-'));
    IdGenerator.reset();
    diagramContext.clear();
    engine = new SimpleBpmnEngine(directory);
    handler = new BpmnRequestHandler(engine);
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps portable authoring vendor-free and rejects vendor fields', async () => {
    const created = await handler.handleRequest('new_bpmn', { name: 'Portable' });
    expect(created.content[0].text).toContain('Extension profile: portable');

    const rejected = await handler.handleRequest('add_activity', {
      activityType: 'userTask',
      name: 'Review',
      properties: { assignee: 'alice' }
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain('requires extensionProfile "camunda7"');

    const added = await handler.handleRequest('add_activity', {
      activityType: 'userTask',
      name: 'Review'
    });
    expect(added.isError).toBeUndefined();
    expect(diagramContext.getCurrent().xml).not.toContain('camunda:');
    expect(diagramContext.getCurrent().xml).not.toContain('camunda.org');
  });

  it('adds, updates, removes, saves, and reopens escaped Camunda 7 fields', async () => {
    await handler.handleRequest('new_bpmn', {
      name: 'Camunda task',
      extensionProfile: 'camunda7'
    });
    await expectSuccess(handler.handleRequest('add_activity', {
      activityType: 'userTask',
      name: 'Review',
      properties: {
        assignee: '${owner < "lead" && ready}',
        candidateGroups: ['ops & support', '${dynamicGroup}'],
        dueDate: '${dateTime().plusDays(2)}'
      }
    }));

    let parsed = await camundaModdle.fromXML(diagramContext.getCurrent().xml!);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.elementsById.UserTask_1).toMatchObject({
      assignee: '${owner < "lead" && ready}',
      candidateGroups: 'ops & support,${dynamicGroup}',
      dueDate: '${dateTime().plusDays(2)}'
    });
    expect(diagramContext.getCurrent().xml).toContain('&#60;');
    expect(diagramContext.getCurrent().xml).toContain('&#38;&#38;');

    await expectSuccess(handler.handleRequest('update_element', {
      elementId: 'UserTask_1',
      properties: {
        assignee: null,
        candidateGroups: ['approvers'],
        dueDate: null
      }
    }));
    const filename = diagramContext.getCurrent().filename!;
    await expectSuccess(handler.handleRequest('save', {}));
    await expectSuccess(handler.handleRequest('open_bpmn', { filename }));

    parsed = await camundaModdle.fromXML(diagramContext.getCurrent().xml!);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.elementsById.UserTask_1).toMatchObject({
      candidateGroups: 'approvers'
    });
    expect(parsed.elementsById.UserTask_1.assignee).toBeUndefined();
    expect(parsed.elementsById.UserTask_1.dueDate).toBeUndefined();
    expect(diagramContext.getCurrent().elements.get('UserTask_1')?.properties).toEqual({
      candidateGroups: ['approvers']
    });
    expect(JSON.parse((await handler.handleRequest('current', {})).content[0].text))
      .toMatchObject({ extensionProfile: 'camunda7' });
  });

  it('detects actual Camunda use, preserves opaque extensions, and ignores unused declarations', async () => {
    const imported = await engine.importXml(camundaImportXml());
    expect(imported.extensionProfile).toBe('camunda7');
    expect(imported.elements.get('UserTask_Imported')?.properties).toMatchObject({
      assignee: 'alice',
      candidateGroups: ['reviewers', 'operations'],
      dueDate: '2026-09-01T12:00:00Z'
    });

    await engine.updateElement(imported.id, 'UserTask_Imported', { name: 'Updated' });
    const exported = await engine.exportXml(imported.id);
    const reparsed = await camundaModdle.fromXML(exported);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.elementsById.UserTask_Imported.extensionElements.values[0])
      .toMatchObject({ key: 'opaque', value: 'keep-me' });

    const unused = await engine.importXml(camundaImportXml().replace(
      /\s+camunda:(assignee|candidateGroups|dueDate)="[^"]*"/g,
      ''
    ));
    expect(unused.extensionProfile).toBe('portable');
  });

  it('advertises closed typed property schemas and blocks QName/raw XML injection', () => {
    for (const toolName of ['add_activity', 'update_element']) {
      const schema = tools.find(tool => tool.name === toolName)!.inputSchema as any;
      expect(schema.properties.properties.additionalProperties).toBe(false);
    }
    expect(() => parseToolRequest('add_activity', {
      activityType: 'userTask',
      name: 'Injected',
      properties: { 'evil:assignee': 'alice' }
    })).toThrow('Unrecognized key');
    expect(() => parseToolRequest('update_element', {
      elementId: 'UserTask_1',
      properties: { rawXml: '<camunda:script />' }
    })).toThrow('Unrecognized key');
    expect(() => parseToolRequest('add_activity', {
      activityType: 'userTask',
      name: 'Ambiguous groups',
      properties: { candidateGroups: ['reviewers,admins'] }
    })).toThrow('Group names must not contain commas');
  });

  it('rejects Camunda fields on non-user tasks even in the Camunda profile', async () => {
    const context = await engine.createProcess('Typed ownership', 'process', 'camunda7');
    await expect(engine.createElement(context.id, {
      type: 'bpmn:ServiceTask',
      properties: { assignee: 'alice' }
    })).rejects.toThrow('assignee is only valid on bpmn:UserTask');
  });

  it('enforces candidate-group count bounds at the direct engine boundary without mutation', async () => {
    const context = await engine.createProcess('Bounded groups', 'process', 'camunda7');
    const maximumGroups = Array.from(
      { length: TOOL_INPUT_LIMITS.candidateGroups.maxItems },
      (_, index) => `group-${index}`
    );
    await expect(engine.createElement(context.id, {
      type: 'bpmn:UserTask',
      name: 'Maximum groups',
      properties: { candidateGroups: maximumGroups }
    })).resolves.toMatchObject({
      properties: { candidateGroups: maximumGroups }
    });

    const elementsBefore = Array.from(context.elements.entries());
    const xmlBefore = context.xml;
    const diskBefore = await fs.readFile(join(directory, context.filename!), 'utf8');
    await expect(engine.createElement(context.id, {
      type: 'bpmn:UserTask',
      name: 'One group too many',
      properties: { candidateGroups: [...maximumGroups, 'overflow'] }
    })).rejects.toThrow(
      `candidateGroups must contain 1-${TOOL_INPUT_LIMITS.candidateGroups.maxItems} strings`
    );
    expect(Array.from(context.elements.entries())).toEqual(elementsBefore);
    expect(context.xml).toBe(xmlBefore);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(diskBefore);
  });
});

async function expectSuccess(resultPromise: Promise<{ isError?: boolean }>): Promise<void> {
  expect((await resultPromise).isError).not.toBe(true);
}

function camundaImportXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
  xmlns:custom="urn:test:opaque" id="Definitions_Imported" targetNamespace="urn:test">
  <bpmn:process id="Process_Imported">
    <bpmn:userTask id="UserTask_Imported" camunda:assignee="alice"
      camunda:candidateGroups="reviewers,operations"
      camunda:dueDate="2026-09-01T12:00:00Z">
      <bpmn:extensionElements>
        <custom:metadata key="opaque" value="keep-me" />
      </bpmn:extensionElements>
    </bpmn:userTask>
  </bpmn:process>
</bpmn:definitions>`;
}
