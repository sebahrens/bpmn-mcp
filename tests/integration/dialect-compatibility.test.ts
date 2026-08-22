import BpmnModdle from 'bpmn-moddle';
import camundaDescriptor from 'camunda-bpmn-moddle/resources/camunda.json';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';

const fixtureDirectory = join(process.cwd(), 'tests', 'fixtures', 'dialects');

describe('BPMN extension profile decision', () => {
  const expectedPortableAssignments = [
    { type: 'bpmn:HumanPerformer', expression: 'alice' },
    {
      type: 'bpmn:PotentialOwner',
      expression: 'group(reviewers), group(operations)'
    }
  ];

  it('imports and round-trips the portable BPMN assignment candidate', async () => {
    const xml = await readFixture('portable-user-task.bpmn');
    const moddle = new BpmnModdle();
    const parsed = await moddle.fromXML(xml);
    const task = parsed.elementsById.UserTask_Portable;

    expect(parsed.warnings).toEqual([]);
    expect(portableAssignments(task)).toEqual(expectedPortableAssignments);
    expect(task.$attrs).toEqual({});

    const serialized = (await moddle.toXML(parsed.rootElement)).xml;
    const reparsed = await moddle.fromXML(serialized);
    expect(reparsed.warnings).toEqual([]);
    expect(portableAssignments(reparsed.elementsById.UserTask_Portable))
      .toEqual(expectedPortableAssignments);
  });

  it('imports Camunda 7 task fields through the selected typed descriptor', async () => {
    const xml = await readFixture('camunda7-user-task.bpmn');
    const moddle = new BpmnModdle({ camunda: camundaDescriptor });
    const parsed = await moddle.fromXML(xml);
    const task = parsed.elementsById.UserTask_Camunda7;

    expect(parsed.warnings).toEqual([]);
    expect(task).toMatchObject({
      assignee: 'alice',
      candidateGroups: 'reviewers,operations',
      dueDate: '2026-09-01T12:00:00Z'
    });

    const serialized = (await moddle.toXML(parsed.rootElement)).xml;
    const reparsed = await moddle.fromXML(serialized);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.elementsById.UserTask_Camunda7).toMatchObject({
      assignee: 'alice',
      candidateGroups: 'reviewers,operations',
      dueDate: '2026-09-01T12:00:00Z'
    });
  });

  it.each([
    ['portable-user-task.bpmn', 'UserTask_Portable'],
    ['camunda7-user-task.bpmn', 'UserTask_Camunda7']
  ])('preserves %s through an unrelated retained-graph mutation', async (fixture, taskId) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-dialect-'));
    try {
      const engine = new SimpleBpmnEngine(directory);
      const context = await engine.importXml(await readFixture(fixture));
      await engine.updateElement(context.id, taskId, { name: 'Reviewed request' });
      const exported = await engine.exportXml(context.id);

      if (fixture.startsWith('camunda7')) {
        const parsed = await new BpmnModdle({ camunda: camundaDescriptor }).fromXML(exported);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.elementsById[taskId]).toMatchObject({
          name: 'Reviewed request',
          assignee: 'alice',
          candidateGroups: 'reviewers,operations',
          dueDate: '2026-09-01T12:00:00Z'
        });
      } else {
        const parsed = await new BpmnModdle().fromXML(exported);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.elementsById[taskId].name).toBe('Reviewed request');
        expect(portableAssignments(parsed.elementsById[taskId]))
          .toEqual(expectedPortableAssignments);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps Camunda attributes opaque through a core-moddle round-trip', async () => {
    const xml = await readFixture('camunda7-user-task.bpmn');
    const moddle = new BpmnModdle();
    const parsed = await moddle.fromXML(xml);
    const task = parsed.elementsById.UserTask_Camunda7;

    expect(parsed.warnings).toEqual([]);
    expect(task.$attrs).toEqual({
      'camunda:assignee': 'alice',
      'camunda:candidateGroups': 'reviewers,operations',
      'camunda:dueDate': '2026-09-01T12:00:00Z'
    });

    const serialized = (await moddle.toXML(parsed.rootElement)).xml;
    expect(serialized).toContain('xmlns:camunda="http://camunda.org/schema/1.0/bpmn"');
    expect(serialized).toContain('camunda:assignee="alice"');
  });
});

async function readFixture(filename: string): Promise<string> {
  return fs.readFile(join(fixtureDirectory, filename), 'utf8');
}

function portableAssignments(task: any): Array<{ type: string; expression: string }> {
  return task.resources.map((resource: any) => ({
    type: resource.$type,
    expression: resource.resourceAssignmentExpression.expression.body
  }));
}
