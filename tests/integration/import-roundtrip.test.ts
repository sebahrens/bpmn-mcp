import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { BpmnValidator } from '../../src/core/BpmnValidator.js';

const fixturePath = join(
  process.cwd(),
  'tests',
  'fixtures',
  'import-roundtrip',
  'full-semantics-di.bpmn'
);

const realToolFixtureDirectory = join(process.cwd(), 'tests', 'fixtures', 'real-tools');

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


/**
 * Files produced by real modeling tools (mcp-bpmn-5e7.12).
 *
 * Every other fixture in this repository is hand-written in this server's own
 * house style, so nothing pinned what happens to the things real exporters put
 * in a file: their `exporter` attributes, their extension namespaces, their DI
 * id conventions, and the semantic corners (call activity expressions, data
 * associations, event subprocesses, compensation boundaries) that only appear
 * once a person has actually drawn a process. These four fixtures are written
 * to match what those tools emit, and are driven through the same open -> edit
 * -> export cycle an agent performs.
 */
describe('imported exports from real modeling tools', () => {
  interface DiagramInterchange {
    shapes: Map<string, { bounds: Record<string, number>; hasLabel: boolean }>;
    edges: Map<string, { waypoints: Array<{ x: number; y: number }> }>;
  }

  async function readDiagramInterchange(xml: string): Promise<DiagramInterchange> {
    const parsed = await new BpmnModdle().fromXML(xml);
    const shapes = new Map<string, { bounds: Record<string, number>; hasLabel: boolean }>();
    const edges = new Map<string, { waypoints: Array<{ x: number; y: number }> }>();
    for (const diagram of (parsed.rootElement as any).diagrams ?? []) {
      for (const element of diagram.plane?.planeElement ?? []) {
        if (element.$type === 'bpmndi:BPMNShape') {
          shapes.set(element.id, {
            bounds: {
              x: element.bounds.x,
              y: element.bounds.y,
              width: element.bounds.width,
              height: element.bounds.height
            },
            hasLabel: Boolean(element.label)
          });
        } else if (element.$type === 'bpmndi:BPMNEdge') {
          edges.set(element.id, {
            waypoints: element.waypoint.map((point: any) => ({ x: point.x, y: point.y }))
          });
        }
      }
    }
    return { shapes, edges };
  }

  async function semanticIds(xml: string): Promise<string[]> {
    const parsed = await new BpmnModdle().fromXML(xml);
    return Object.keys(parsed.elementsById).sort();
  }

  interface RealToolFixture {
    name: string;
    file: string;
    exporter: string;
    exporterVersion: string;
    /** Namespace declarations the export must still carry, by prefix. */
    namespaces: Record<string, string>;
    /** An element to rename, and the name it starts with. */
    editId: string;
    editFrom: string;
  }

  const fixtures: RealToolFixture[] = [
    {
      name: 'Camunda Modeler 5 / Camunda Platform 7',
      file: 'camunda-modeler-c7.bpmn',
      exporter: 'Camunda Modeler',
      exporterVersion: '5.19.0',
      namespaces: {
        camunda: 'http://camunda.org/schema/1.0/bpmn',
        modeler: 'http://camunda.org/schema/modeler/1.0'
      },
      editId: 'Activity_0review',
      editFrom: 'Review invoice'
    },
    {
      name: 'Camunda Modeler 5 / Camunda 8 (Zeebe)',
      file: 'camunda-modeler-c8.bpmn',
      exporter: 'Camunda Modeler',
      exporterVersion: '5.22.0',
      namespaces: {
        zeebe: 'http://camunda.org/schema/zeebe/1.0',
        modeler: 'http://camunda.org/schema/modeler/1.0'
      },
      editId: 'Activity_0score',
      editFrom: 'Score applicant'
    },
    {
      name: 'bpmn-js (demo.bpmn.io)',
      file: 'bpmn-js-demo-collaboration.bpmn',
      exporter: 'bpmn-js (https://demo.bpmn.io)',
      exporterVersion: '17.11.1',
      namespaces: {},
      editId: 'Activity_0place',
      editFrom: 'Place order'
    },
    {
      name: 'Eclipse BPMN2 Modeler (non-bpmn.io)',
      file: 'eclipse-bpmn2-modeler.bpmn',
      exporter: 'org.eclipse.bpmn2.modeler.core',
      exporterVersion: '1.5.3.Final-v20180418-1358-B1',
      namespaces: {},
      editId: 'Task_1',
      editFrom: 'Assess claim'
    }
  ];

  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-real-tools-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(fixtures)(
    'preserves ids, namespaces and DI from $name across open, edit and export',
    async ({ file, exporter, exporterVersion, namespaces, editId, editFrom }) => {
      const source = await fs.readFile(join(realToolFixtureDirectory, file), 'utf8');
      const sourceIds = await semanticIds(source);
      const sourceDi = await readDiagramInterchange(source);
      expect(sourceDi.shapes.size).toBeGreaterThan(0);
      expect(sourceDi.edges.size).toBeGreaterThan(0);

      const engine = new SimpleBpmnEngine(directory);
      const context = await engine.importXml(source);
      await engine.updateElement(context.id, editId, { name: 'Edited by the server' });
      await engine.save(context.id);

      // Reopening from disk is the path an agent actually takes, so the
      // assertions below run against a file that has been through the whole
      // parse -> mutate -> serialize -> parse cycle.
      const reopenedEngine = new SimpleBpmnEngine(directory);
      const reopened = await reopenedEngine.loadDiagram(context.filename!);
      const exported = await reopenedEngine.exportXml(reopened.id);
      const parsed = await new BpmnModdle().fromXML(exported);

      expect(parsed.warnings).toEqual([]);
      // 1. The exporter provenance is retained, not rewritten to this server.
      expect(parsed.rootElement).toMatchObject({ exporter, exporterVersion });
      // 2. Not one id is renamed, dropped, or invented.
      expect(await semanticIds(exported)).toEqual(sourceIds);
      // 3. Every extension namespace the tool declared is still declared, under
      //    the same prefix, on the definitions element.
      for (const [prefix, uri] of Object.entries(namespaces)) {
        expect(exported).toContain(`xmlns:${prefix}="${uri}"`);
      }
      // 4. Every BPMNShape and BPMNEdge keeps its id and its geometry.
      const exportedDi = await readDiagramInterchange(exported);
      expect([...exportedDi.shapes.keys()].sort()).toEqual([...sourceDi.shapes.keys()].sort());
      expect([...exportedDi.edges.keys()].sort()).toEqual([...sourceDi.edges.keys()].sort());
      for (const [id, shape] of sourceDi.shapes) {
        expect(exportedDi.shapes.get(id)!.bounds).toEqual(shape.bounds);
      }
      for (const [id, edge] of sourceDi.edges) {
        expect(exportedDi.edges.get(id)!.waypoints).toEqual(edge.waypoints);
      }
      // 5. The one requested edit landed, and nothing else claims the old name.
      expect(parsed.elementsById[editId].name).toBe('Edited by the server');
      expect(exported).not.toContain(editFrom);
    }
  );

  it('keeps Camunda Platform 7 execution semantics that only a modeler emits', async () => {
    const source = await fs.readFile(
      join(realToolFixtureDirectory, 'camunda-modeler-c7.bpmn'),
      'utf8'
    );
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(source);
    await engine.updateElement(context.id, 'Activity_1archive', { name: 'Archive it' });
    const parsed = await new BpmnModdle().fromXML(await engine.exportXml(context.id));
    const byId = parsed.elementsById as Record<string, any>;

    expect((parsed.rootElement as any).$attrs).toMatchObject({
      'modeler:executionPlatform': 'Camunda Platform',
      'modeler:executionPlatformVersion': '7.20.0'
    });
    // camunda: attributes on the process and on tasks. This test parses with a
    // plain bpmn-moddle, so camunda attributes land in $attrs rather than as
    // typed properties; that is exactly the view a foreign consumer gets.
    expect(byId.Process_Invoice.$attrs['camunda:historyTimeToLive']).toBe('180');
    expect(byId.Activity_0review.$attrs).toMatchObject({
      'camunda:assignee': 'demo',
      'camunda:formKey': 'embedded:app:forms/review.html'
    });
    expect(byId.Activity_0review.extensionElements.values.map((value: any) => value.$type))
      .toEqual(['camunda:properties', 'camunda:taskListener']);
    // A call activity whose calledElement is an expression, not a literal key.
    expect(byId.Activity_1archive).toMatchObject({
      $type: 'bpmn:CallActivity',
      name: 'Archive it',
      calledElement: '${archiveProcessKey}'
    });
    expect(byId.Activity_1archive.$attrs['camunda:calledElementVersion']).toBe('');
    // camunda-bpmn-moddle declares calledElementBinding with default "latest",
    // and moddle never writes an attribute that equals its declared default, so
    // this one attribute is elided on the way out. The binding is semantically
    // unchanged; if a future moddle keeps it, tighten this expectation rather
    // than dropping it.
    expect(source).toContain('camunda:calledElementBinding="latest"');
    expect(await engine.exportXml(context.id)).not.toContain('calledElementBinding');
    expect(byId.Activity_1archive.extensionElements.values.map((value: any) => value.$type))
      .toEqual(['camunda:in', 'camunda:out']);
    // Data associations survive with both their endpoints.
    expect(byId.DataInputAssociation_0review.sourceRef.map((ref: any) => ref.id))
      .toEqual(['DataObjectReference_Invoice']);
    expect(byId.DataInputAssociation_0review.targetRef.id).toBe('Property_0review');
    expect(byId.DataOutputAssociation_0review.targetRef.id).toBe('DataObjectReference_Invoice');
    expect(byId.DataObjectReference_Invoice.dataObjectRef.id).toBe('DataObject_Invoice');
    // An event subprocess keeps triggeredByEvent and its message start event.
    expect(byId.Activity_3escalation).toMatchObject({
      $type: 'bpmn:SubProcess',
      triggeredByEvent: true
    });
    expect(byId.Event_1escalated.eventDefinitions[0]).toMatchObject({
      $type: 'bpmn:MessageEventDefinition'
    });
    expect(byId.Event_1escalated.eventDefinitions[0].messageRef.id).toBe('Message_0escalated');
    expect(byId.Activity_4notify.$type).toBe('bpmn:SendTask');
    // The compensation handler and its boundary event keep their wiring.
    expect(byId.Activity_2undo.isForCompensation).toBe(true);
    expect(byId.Event_0compensate.attachedToRef.id).toBe('Activity_0review');
    expect(byId.Event_0compensate.eventDefinitions[0].$type)
      .toBe('bpmn:CompensateEventDefinition');
    expect(byId.Association_0compensate).toMatchObject({ associationDirection: 'One' });
  });

  it('flags the interrupting compensation boundary every bpmn.io tool emits', async () => {
    // bpmn-js creates a compensation boundary event with cancelActivity true,
    // which is the moddle default and therefore never written to the file
    // (mcp-bpmn-a3j.19). The validator judges the attribute the author actually
    // wrote, so an untouched export validates clean while a file that really
    // does declare an interrupting compensation boundary is still rejected.
    const source = await fs.readFile(
      join(realToolFixtureDirectory, 'camunda-modeler-c7.bpmn'),
      'utf8'
    );
    const parsed = await new BpmnModdle().fromXML(source);

    // The attribute is absent from the file and defaults to true on parse.
    expect(/id="Event_0compensate"[^>]*cancelActivity/u.test(source)).toBe(false);
    expect((parsed.elementsById as any).Event_0compensate.cancelActivity).toBe(true);
    const result = await new BpmnValidator().validate(source, 'semantic');
    expect(result.errors).toEqual([]);

    // Writing the attribute explicitly is a real authoring mistake and is
    // still reported against the element that carries it.
    const declared = source.replace(
      '<bpmn:boundaryEvent id="Event_0compensate"',
      '<bpmn:boundaryEvent id="Event_0compensate" cancelActivity="true"'
    );
    expect(declared).not.toBe(source);
    const declaredResult = await new BpmnValidator().validate(declared, 'semantic');
    expect(declaredResult.errors).toEqual([
      expect.objectContaining({
        code: 'BPMN_INVALID_BOUNDARY_INTERRUPTION',
        elementId: 'Event_0compensate'
      })
    ]);
  });

  it('keeps Zeebe execution semantics through an edit', async () => {
    const source = await fs.readFile(
      join(realToolFixtureDirectory, 'camunda-modeler-c8.bpmn'),
      'utf8'
    );
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(source);
    await engine.updateElement(context.id, 'Activity_1approve', { name: 'Approve it' });
    const parsed = await new BpmnModdle().fromXML(await engine.exportXml(context.id));
    const byId = parsed.elementsById as Record<string, any>;

    expect((parsed.rootElement as any).$attrs).toMatchObject({
      'modeler:executionPlatform': 'Camunda Cloud',
      'modeler:executionPlatformVersion': '8.5.0'
    });
    // zeebe: extension elements are not in this server's moddle registry, so
    // they round-trip as generic elements; their names and attributes must
    // still survive verbatim.
    const scoreExtensions = byId.Activity_0score.extensionElements.values;
    expect(scoreExtensions.map((value: any) => value.$type ?? value.name))
      .toEqual(['zeebe:taskDefinition', 'zeebe:ioMapping']);
    const exported = await engine.exportXml(context.id);
    expect(exported).toContain('<zeebe:taskDefinition type="score-applicant" retries="3" />');
    expect(exported).toContain('<zeebe:input source="=applicant" target="applicant" />');
    expect(exported).toContain('formId="approval-form"');
    // Conditional flow, gateway default, and non-interrupting boundary timer.
    expect(byId.Flow_2approve.conditionExpression.body).toBe('=creditScore > 700');
    expect(byId.Gateway_0decide.default.id).toBe('Flow_3reject');
    expect(byId.Event_2timeout).toMatchObject({ cancelActivity: false });
    expect(byId.Event_2timeout.eventDefinitions[0].timeDuration.body).toBe('P2D');
    expect(byId.Activity_1approve.name).toBe('Approve it');
  });

  it('keeps bpmn-js collaboration structure, lanes and the message flow', async () => {
    const source = await fs.readFile(
      join(realToolFixtureDirectory, 'bpmn-js-demo-collaboration.bpmn'),
      'utf8'
    );
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(source);
    await engine.updateElement(context.id, 'Activity_1track', { name: 'Track it' });
    const parsed = await new BpmnModdle().fromXML(await engine.exportXml(context.id));
    const byId = parsed.elementsById as Record<string, any>;

    expect(byId.Participant_Customer.processRef.id).toBe('Process_Customer');
    expect(byId.Participant_Supplier.processRef.id).toBe('Process_Supplier');
    expect(byId.Lane_Sales.flowNodeRef.map((ref: any) => ref.id))
      .toEqual(['StartEvent_1', 'Activity_0place', 'Event_0done']);
    expect(byId.Lane_Operations.flowNodeRef.map((ref: any) => ref.id)).toEqual(['Activity_1track']);
    expect(byId.Flow_Order).toMatchObject({ $type: 'bpmn:MessageFlow', name: 'Purchase order' });
    expect(byId.Flow_Order.sourceRef.id).toBe('Activity_0place');
    expect(byId.Flow_Order.targetRef.id).toBe('Event_1received');
    expect(byId.TextAnnotation_0sla.text).toBe('Orders must be placed before 16:00');
    expect(byId.Association_0sla.targetRef.id).toBe('TextAnnotation_0sla');
    expect(byId.Event_1received.eventDefinitions[0].$type).toBe('bpmn:MessageEventDefinition');
    expect(byId.Activity_1track.name).toBe('Track it');
  });

  it('keeps the non-bpmn.io Eclipse dialect, including its DI cross-references', async () => {
    const source = await fs.readFile(
      join(realToolFixtureDirectory, 'eclipse-bpmn2-modeler.bpmn'),
      'utf8'
    );
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(source);
    await engine.updateElement(context.id, 'Task_1', { name: 'Assess it' });
    const exported = await engine.exportXml(context.id);
    const parsed = await new BpmnModdle().fromXML(exported);
    const byId = parsed.elementsById as Record<string, any>;

    expect(exported).toContain('targetNamespace="http://org.eclipse.bpmn2/default/process"');
    // Eclipse ties each BPMNEdge back to the shapes it connects; bpmn.io never
    // writes these, so they are the clearest signal that a foreign DI graph is
    // being carried rather than regenerated.
    expect(byId.BPMNEdge_SequenceFlow_1.sourceElement.id).toBe('BPMNShape_StartEvent_2');
    expect(byId.BPMNEdge_SequenceFlow_1.targetElement.id).toBe('BPMNShape_Task_1');
    // Its labels carry their own ids, which bpmn.io also omits.
    expect(byId.BPMNShape_Task_1.label.id).toBe('BPMNLabel_2');
    expect(byId.BPMNEdge_SequenceFlow_2.label.bounds).toMatchObject({
      x: 327, y: 130, width: 80, height: 20
    });
    expect(byId.Process_1.documentation[0].text)
      .toBe('Exported from the Eclipse BPMN2 Modeler.');
    expect(byId.Task_1.name).toBe('Assess it');
    // The redundant xsi:type on each waypoint is dropped by bpmn-moddle because
    // dc:Point is already the declared type; the coordinates themselves are the
    // contract and they are unchanged.
    expect(byId.BPMNEdge_SequenceFlow_1.waypoint.map((point: any) => ({
      x: point.x,
      y: point.y
    }))).toEqual([{ x: 168, y: 150 }, { x: 228, y: 150 }]);
  });
});

describe('schema-valid data object reference variants', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-dataobject-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const withProcess = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_DataVariants" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_DataVariants" isExecutable="true">${body}
  </bpmn:process>
</bpmn:definitions>`;

  // dataObjectRef is use="optional" in the BPMN XSD: a reference with none is
  // an opaque handle the model does not manage, and rejecting it made whole
  // files unopenable.
  const absentRef = withProcess(`
    <bpmn:dataObjectReference id="DataRef_Opaque" name="Opaque" />
    <bpmn:task id="Task_DataVariants" name="Work" />`);

  // A DataObject is visible to every nested scope of the process that declares
  // it, so a reference inside a subprocess may point at one declared outside.
  const enclosingScopeRef = withProcess(`
    <bpmn:dataObject id="DataObject_Shared" name="Shared" />
    <bpmn:subProcess id="SubProcess_Scoped">
      <bpmn:dataObjectReference id="DataRef_Scoped" name="Shared"
        dataObjectRef="DataObject_Shared" />
      <bpmn:task id="Task_Scoped" name="Use it" />
    </bpmn:subProcess>`);

  it('imports a data object reference with no dataObjectRef and keeps it opaque', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(absentRef);
    await engine.updateElement(context.id, 'Task_DataVariants', { name: 'Work harder' });
    const exported = await engine.exportXml(context.id);
    const byId = (await new BpmnModdle().fromXML(exported)).elementsById as Record<string, any>;

    expect(byId.DataRef_Opaque.$type).toBe('bpmn:DataObjectReference');
    expect(byId.DataRef_Opaque.name).toBe('Opaque');
    expect(byId.DataRef_Opaque.dataObjectRef).toBeUndefined();
    expect(exported).not.toContain('dataObjectRef=');
  });

  it('imports a data object reference whose data object lives in an enclosing scope',
    async () => {
      const engine = new SimpleBpmnEngine(directory);
      const context = await engine.importXml(enclosingScopeRef);
      await engine.updateElement(context.id, 'Task_Scoped', { name: 'Use it twice' });
      const exported = await engine.exportXml(context.id);
      const byId = (await new BpmnModdle().fromXML(exported)).elementsById as Record<string, any>;

      expect(byId.DataRef_Scoped.dataObjectRef.id).toBe('DataObject_Shared');
      // The data object stays in the scope that declared it.
      expect(byId.Process_DataVariants.flowElements.map((item: any) => item.id))
        .toContain('DataObject_Shared');
      expect(byId.SubProcess_Scoped.flowElements.map((item: any) => item.id))
        .toEqual(expect.arrayContaining(['DataRef_Scoped', 'Task_Scoped']));
    });

  it('still rejects a data object reference that reaches into a sibling scope', async () => {
    const siblingScopeRef = withProcess(`
      <bpmn:subProcess id="SubProcess_Owner">
        <bpmn:dataObject id="DataObject_Private" name="Private" />
        <bpmn:task id="Task_Owner" name="Own it" />
      </bpmn:subProcess>
      <bpmn:subProcess id="SubProcess_Peer">
        <bpmn:dataObjectReference id="DataRef_Peer" name="Private"
          dataObjectRef="DataObject_Private" />
        <bpmn:task id="Task_Peer" name="Peek" />
      </bpmn:subProcess>`);
    const engine = new SimpleBpmnEngine(directory);

    await expect(engine.importXml(siblingScopeRef))
      .rejects.toThrow('crosses data object scope');
  });
});
