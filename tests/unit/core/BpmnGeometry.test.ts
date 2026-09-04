import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { validateBpmnGeometry } from '../../../src/core/BpmnGeometry.js';

const fixture = (): Promise<string> => fs.readFile(
  join(process.cwd(), 'tests', 'fixtures', 'simple-process.bpmn'),
  'utf8'
);

const collaborationFixture = (): Promise<string> => fs.readFile(
  join(process.cwd(), 'tests', 'fixtures', 'agent-geometry', 'laid-out-collaboration.bpmn'),
  'utf8'
);

const MESSAGE_FLOW_ROUTE = [
  '        <di:waypoint x="580" y="202" />',
  '        <di:waypoint x="580" y="440" />',
  '        <di:waypoint x="450" y="440" />',
  '        <di:waypoint x="450" y="470" />'
].join('\n');

describe('production BPMN geometry analysis', () => {
  it('returns severity-coded diagnostics and stable summary counts', async () => {
    const xml = (await fixture()).replace('width="100" height="80"', 'width="0" height="80"');

    const first = await validateBpmnGeometry(xml);
    const second = await validateBpmnGeometry(xml);

    expect(first).toEqual(second);
    expect(first.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'INVALID_BOUNDS',
        severity: 'error',
        ids: ['Task_1']
      })
    ]));
    expect(first.summary).toEqual({
      total: first.diagnostics.length,
      errors: first.diagnostics.filter(item => item.severity === 'error').length,
      warnings: first.diagnostics.filter(item => item.severity === 'warning').length,
      byCode: expect.objectContaining({ INVALID_BOUNDS: 1 })
    });
  });

  it('detects malformed bounds and both missing and non-finite waypoints', async () => {
    const xml = (await fixture())
      .replace('<di:waypoint x="392" y="120" />', '')
      .replace('<di:waypoint x="188" y="120" />', '<di:waypoint x="NaN" y="120" />');

    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INSUFFICIENT_WAYPOINTS', ids: ['Flow_2'] }),
      expect.objectContaining({ code: 'NON_FINITE_GEOMETRY', ids: ['Flow_1'] })
    ]));
  });

  it('filters diagnostics and returned geometry to selected elements with related context', async () => {
    const xml = (await fixture())
      .replace('x="240" y="80" width="100"', 'x="380" y="80" width="100"')
      .replace('x="188" y="120"', 'x="210" y="120"');

    const report = await validateBpmnGeometry(xml, { elementIds: ['EndEvent_1'] });

    expect(report.diagnostics.every(item =>
      item.ids.length === 0 || item.ids.includes('EndEvent_1')
    )).toBe(true);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SHAPE_OVERLAP', ids: ['EndEvent_1', 'Task_1'] })
    ]));
    expect(report.geometry?.shapes.map(shape => shape.id).sort()).toEqual([
      'EndEvent_1',
      'Task_1'
    ]);
    expect(report.geometry?.edges).toEqual([]);
  });

  it('reports selected unknown IDs without leaking unrelated diagnostics', async () => {
    const report = await validateBpmnGeometry(await fixture(), {
      elementIds: ['Missing_Element'],
      connectionIds: ['Missing_Connection']
    });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_CONNECTION_ID', ids: ['Missing_Connection'] }),
      expect.objectContaining({ code: 'UNKNOWN_ELEMENT_ID', ids: ['Missing_Element'] })
    ]);
    expect(report.geometry).toEqual({ shapes: [], edges: [], labels: [] });
  });

  it('supports connection-only scopes', async () => {
    const report = await validateBpmnGeometry(await fixture(), {
      connectionIds: ['Flow_1']
    });

    expect(report.diagnostics).toEqual([]);
    expect(report.geometry?.shapes.map(shape => shape.id).sort()).toEqual([
      'StartEvent_1',
      'Task_1'
    ]);
    expect(report.geometry).toMatchObject({ labels: [] });
    expect(report.geometry?.edges.map(edge => edge.id)).toEqual(['Flow_1']);
  });

  it('reports minimum clearance and optional non-orthogonal routes as warnings', async () => {
    const xml = (await fixture())
      .replace('x="392" y="102" width="36"', 'x="344" y="102" width="36"')
      .replace('x="392" y="120"', 'x="344" y="120"')
      .replace('x="188" y="120"', 'x="220" y="140"');
    const report = await validateBpmnGeometry(xml, {
      clearance: 5,
      tolerance: 0.5,
      requireOrthogonal: true
    });

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MINIMUM_CLEARANCE',
        severity: 'warning',
        ids: ['EndEvent_1', 'Task_1']
      }),
      expect.objectContaining({
        code: 'NON_ORTHOGONAL_ROUTE',
        severity: 'warning',
        ids: ['Flow_1']
      })
    ]));
    expect(report.summary.warnings).toBeGreaterThanOrEqual(2);
  });

  it('reports edge-to-edge minimum-clearance violations away from a shared dock', async () => {
    const xml = (await fixture())
      .replace('<di:waypoint x="340" y="120" />', '<di:waypoint x="188" y="123" />')
      .replace('<di:waypoint x="392" y="120" />', '<di:waypoint x="240" y="123" />');

    const report = await validateBpmnGeometry(xml, { clearance: 5, tolerance: 0.5 });

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MINIMUM_CLEARANCE',
        severity: 'warning',
        ids: ['Flow_1', 'Flow_2']
      })
    ]));
  });

  it('accepts shapes and labels that sit inside their own pool, lane, and subprocess', async () => {
    const report = await validateBpmnGeometry(await collaborationFixture());

    expect(report.diagnostics).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('still reports shapes and labels that overlap a container they do not belong to', async () => {
    const xml = (await collaborationFixture())
      .replace('x="160" y="410" width="760" height="200"', 'x="160" y="170" width="760" height="200"');

    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SHAPE_OVERLAP', ids: ['Participant_1', 'Participant_2'] }),
      expect.objectContaining({ code: 'SHAPE_OVERLAP', ids: ['Participant_2', 'StartEvent_1'] }),
      expect.objectContaining({ code: 'LABEL_OVERLAP', ids: ['StartEvent_1', 'Participant_2'] })
    ]));
  });

  it('does not require a BPMNShape for a non-rendered bpmn:DataObject', async () => {
    const xml = (await fixture()).replace(
      '    <bpmn:endEvent id="EndEvent_1"',
      '    <bpmn:dataObject id="DataObject_1" name="Payload" />\n    <bpmn:endEvent id="EndEvent_1"'
    );

    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('reports a message flow that runs along a sequence flow it does not dock with', async () => {
    const xml = (await collaborationFixture()).replace(
      MESSAGE_FLOW_ROUTE,
      [
        '        <di:waypoint x="580" y="202" />',
        '        <di:waypoint x="580" y="510" />',
        '        <di:waypoint x="500" y="510" />'
      ].join('\n')
    );

    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'EDGE_EDGE_CROSSING',
        severity: 'error',
        ids: ['Flow_4', 'MessageFlow_1']
      })
    ]));
  });

  it('still exempts same-kind connectors that leave one element at a shared dock', async () => {
    const report = await validateBpmnGeometry(gatewayFanOutXml());

    expect(report.diagnostics.map(item => item.code)).not.toContain('EDGE_EDGE_CROSSING');
  });

  it('stops before quadratic checks when production item limits are exceeded', async () => {
    const report = await validateBpmnGeometry(await fixture(), { maxShapes: 2, maxEdges: 2 });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', ids: [] })
    ]);
    expect(report.valid).toBe(false);
    expect(report.geometry).toBeUndefined();
  });

  it('bounds returned diagnostics while reporting deterministic truncation', async () => {
    const xml = (await fixture())
      .replace('x="152" y="102" width="36"', 'x="NaN" y="102" width="36"')
      .replace('x="240" y="80" width="100"', 'x="380" y="80" width="100"')
      .replace('x="188" y="120"', 'x="210" y="120"');

    const report = await validateBpmnGeometry(xml, { maxDiagnostics: 2 });

    expect(report.diagnostics).toHaveLength(3);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DIAGNOSTICS_TRUNCATED', severity: 'warning', ids: [] })
    ]));
    expect(report.summary.total).toBe(3);
  });
});

/** Two sequence flows that leave one gateway share their first segment. */
function gatewayFanOutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  id="Definitions_FanOut" targetNamespace="urn:mcp-bpmn:test">
  <bpmn:process id="Process_FanOut" isExecutable="true">
    <bpmn:exclusiveGateway id="Gateway_1" />
    <bpmn:task id="Task_1" />
    <bpmn:task id="Task_2" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Gateway_1" targetRef="Task_2" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_FanOut">
    <bpmndi:BPMNPlane id="Plane_FanOut" bpmnElement="Process_FanOut">
      <bpmndi:BPMNShape id="Gateway_1_di" bpmnElement="Gateway_1">
        <dc:Bounds x="100" y="100" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1">
        <dc:Bounds x="300" y="60" width="100" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_2_di" bpmnElement="Task_2">
        <dc:Bounds x="300" y="180" width="100" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="150" y="125" />
        <di:waypoint x="250" y="125" />
        <di:waypoint x="250" y="90" />
        <di:waypoint x="300" y="90" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="150" y="125" />
        <di:waypoint x="250" y="125" />
        <di:waypoint x="250" y="210" />
        <di:waypoint x="300" y="210" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}
