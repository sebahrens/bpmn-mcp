import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';

const fixturePath = join(
  process.cwd(),
  'tests',
  'fixtures',
  'import-roundtrip',
  'full-semantics-di.bpmn'
);

async function canonicalXml(
  xml: string,
  restoreName?: { id: string; name: string }
): Promise<string> {
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(xml);
  if (restoreName) {
    parsed.elementsById[restoreName.id].name = restoreName.name;
  }
  return (await moddle.toXML(parsed.rootElement, { format: false, preamble: false })).xml;
}

describe('lossless imported BPMN mutation', () => {
  let directory: string;
  let fixture: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-roundtrip-'));
    fixture = await fs.readFile(fixturePath, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('canonically round-trips the complete moddle graph without mutation', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(fixture);

    expect(await canonicalXml(await engine.exportXml(context.id)))
      .toBe(await canonicalXml(fixture));
  });

  it('changes only the targeted task while preserving semantics, labels, bounds, and waypoints', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(fixture);
    await engine.updateElement(context.id, 'Task_Unrelated', { name: 'Reviewed request' });
    const exported = await engine.exportXml(context.id);

    expect(await canonicalXml(exported, { id: 'Task_Unrelated', name: 'Review request' }))
      .toBe(await canonicalXml(fixture));

    const parsed = await new BpmnModdle().fromXML(exported);
    expect(parsed.elementsById.Task_Unrelated.name).toBe('Reviewed request');
    expect(parsed.elementsById.Lane_Reviewer.flowNodeRef.map((item: any) => item.id))
      .toContain('Task_Unrelated');
    expect(parsed.elementsById.Flow_Approved.conditionExpression.body).toBe('${approved = true}');
    expect(parsed.elementsById.MessageFlow_Notice.messageRef.id).toBe('Message_Notice');
    expect(parsed.elementsById.Association_Lane_Task.sourceRef.id).toBe('Lane_Reviewer');
    expect(parsed.elementsById.Task_Unrelated.extensionElements.values[0].key).toBe('task-extension');
    expect(parsed.elementsById.SubProcess_Preserved_CustomDI.isExpanded).toBe(true);
    expect(parsed.elementsById.Task_Unrelated_CustomDI.bounds)
      .toMatchObject({ x: 210, y: 168, width: 110, height: 80 });
    expect(parsed.elementsById.Flow_Approved_CustomDI.waypoint.map((point: any) => ({
      x: point.x,
      y: point.y
    }))).toEqual([{ x: 430, y: 208 }, { x: 490, y: 208 }]);
    expect(parsed.elementsById.Flow_Approved_CustomDI.label.bounds)
      .toMatchObject({ x: 444, y: 186, width: 62, height: 14 });
  });

  it('adds, connects, saves, and reopens without disturbing retained content', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(fixture);
    const added = await engine.createElement(context.id, {
      type: 'bpmn:Task',
      name: 'Added after import',
      position: { x: 850, y: 290 }
    });
    const connection = await engine.connect(context.id, 'End_RoundTrip', added.id, 'follow-up');
    await engine.save(context.id);

    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(context.filename!);
    await reopenedEngine.updateElement(reopened.id, 'Task_Unrelated', {
      name: 'Updated after reopen'
    });
    const parsed = await new BpmnModdle().fromXML(await reopenedEngine.exportXml(reopened.id));

    expect(parsed.elementsById[added.id].name).toBe('Added after import');
    expect(parsed.elementsById.Task_Unrelated.name).toBe('Updated after reopen');
    expect(parsed.elementsById[connection.id]).toMatchObject({
      name: 'follow-up',
      sourceRef: expect.objectContaining({ id: 'End_RoundTrip' }),
      targetRef: expect.objectContaining({ id: added.id })
    });
    expect(parsed.elementsById.Task_Unrelated.extensionElements.values[0].value).toBe('still-here');
    expect(parsed.elementsById.Flow_Approved.conditionExpression.body).toBe('${approved = true}');
    expect(parsed.elementsById.Flow_Approved_CustomDI.label.bounds)
      .toMatchObject({ x: 444, y: 186, width: 62, height: 14 });
  });

  it('deletes related references while preserving unrelated retained content', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(fixture);
    await engine.deleteElement(context.id, 'Task_Unrelated');
    const exported = await engine.exportXml(context.id);
    const parsed = await new BpmnModdle().fromXML(exported);

    expect(parsed.elementsById.Task_Unrelated).toBeUndefined();
    expect(parsed.elementsById.Flow_Start_Task).toBeUndefined();
    expect(parsed.elementsById.Flow_Task_Gateway).toBeUndefined();
    expect(parsed.elementsById.MessageFlow_Notice).toBeUndefined();
    expect(parsed.elementsById.Association_Lane_Task).toBeUndefined();
    expect(parsed.elementsById.Lane_Reviewer.flowNodeRef.map((item: any) => item.id))
      .not.toContain('Task_Unrelated');
    expect(parsed.elementsById.Process_RoundTrip.extensionElements.values[0].value).toBe('keep-me');
    expect(parsed.elementsById.Nested_Task_CustomDI.bounds)
      .toMatchObject({ x: 590, y: 168, width: 100, height: 80 });
  });

  it('deletes retained data associations that would otherwise become orphaned', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(fixture);
    await engine.deleteElement(context.id, 'DataObjectReference_Request');
    const parsed = await new BpmnModdle().fromXML(await engine.exportXml(context.id));

    expect(parsed.elementsById.DataObjectReference_Request).toBeUndefined();
    expect(parsed.elementsById.DataObject_Request).toBeUndefined();
    expect(parsed.elementsById.DataInputAssociation_Request).toBeUndefined();
    expect(parsed.elementsById.DataObjectReference_Request_CustomDI).toBeUndefined();
    expect(parsed.elementsById.ItemDefinition_Request).toBeDefined();
    expect(parsed.elementsById.Task_Unrelated.extensionElements.values[0].value).toBe('still-here');
  });

  it('preserves a no-DI graph and flows to valid unexposed moddle types', async () => {
    const noDi = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_NoDI" targetNamespace="urn:mcp-bpmn:no-di">
  <bpmn:process id="Process_NoDI" name="No DI">
    <bpmn:adHocSubProcess id="AdHoc_Opaque" name="Opaque ad-hoc subprocess" />
    <bpmn:task id="Task_Visible" name="Visible task" />
    <bpmn:sequenceFlow id="Flow_Opaque" sourceRef="AdHoc_Opaque" targetRef="Task_Visible" />
  </bpmn:process>
</bpmn:definitions>`;
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(noDi);

    expect(context.elements.has('AdHoc_Opaque')).toBe(false);
    expect(context.connections.has('Flow_Opaque')).toBe(false);
    await engine.updateElement(context.id, 'Task_Visible', { name: 'Changed visible task' });
    expect(await canonicalXml(await engine.exportXml(context.id), {
      id: 'Task_Visible',
      name: 'Visible task'
    })).toBe(await canonicalXml(noDi));
  });

  it('does not replace active state when a later import is malformed', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const active = await engine.importXml(fixture);
    const before = await engine.exportXml(active.id);

    await expect(engine.importXml('<bpmn:definitions>')).rejects.toThrow('Failed to parse BPMN XML');

    expect(engine.getProcess(active.id)).toBe(active);
    expect(await canonicalXml(await engine.exportXml(active.id))).toBe(await canonicalXml(before));
  });

  it('does not publish a failed mutation to memory or disk', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const active = await engine.importXml(fixture);
    const before = await engine.exportXml(active.id);

    await expect(engine.updateElement(active.id, 'Task_Unrelated', {
      name: 'Must not stick',
      properties: { eventDefinition: 'unknown' }
    })).rejects.toThrow('Unsupported event definition type');

    expect(active.elements.get('Task_Unrelated')?.name).toBe('Review request');
    expect(await canonicalXml(await engine.exportXml(active.id))).toBe(await canonicalXml(before));
    expect(await canonicalXml(await fs.readFile(join(directory, active.filename!), 'utf8')))
      .toBe(await canonicalXml(before));
  });
});
