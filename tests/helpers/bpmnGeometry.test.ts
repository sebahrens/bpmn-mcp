import { promises as fs } from 'fs';
import { join } from 'path';
import {
  BpmnGeometry,
  formatGeometryDiagnostics,
  normalizeGeometry,
  validateBpmnGeometry
} from './bpmnGeometry.js';

const fixture = (name: string): Promise<string> =>
  fs.readFile(join(process.cwd(), 'tests', 'fixtures', name), 'utf8');

describe('BPMN geometry oracle', () => {
  it('reports invalid XML and semantic BPMN without DI as diagnostic failures', async () => {
    const invalid = await validateBpmnGeometry('<bpmn:definitions');
    const missingDi = await validateBpmnGeometry(
      await fs.readFile(join(process.cwd(), 'tests', 'fixtures', 'layout', 'sequential.bpmn'), 'utf8')
    );

    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.map(item => item.code)).toContain('INVALID_XML');
    expect(missingDi.valid).toBe(false);
    expect(missingDi.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_DI' })
    ]));
  });

  it('accepts complete DI with docked endpoints and legal endpoint intersections', async () => {
    const report = await validateBpmnGeometry(await fixture('simple-process.bpmn'));

    expect(formatGeometryDiagnostics(report)).toBe('valid geometry');
    expect(report.valid).toBe(true);
    expect(report.geometry?.shapes.map(shape => shape.id)).toEqual([
      'StartEvent_1',
      'Task_1',
      'EndEvent_1'
    ]);
  });

  it('reports missing per-element shapes and edges', async () => {
    const xml = (await fixture('simple-process.bpmn'))
      .replace(/      <bpmndi:BPMNShape id="Task_1_di"[\s\S]*?      <\/bpmndi:BPMNShape>\n/, '')
      .replace(/      <bpmndi:BPMNEdge id="Flow_2_di"[\s\S]*?      <\/bpmndi:BPMNEdge>\n/, '');
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_SHAPE', ids: ['Task_1'] }),
      expect.objectContaining({ code: 'MISSING_EDGE', ids: ['Flow_2'] })
    ]));
  });

  it('reports non-finite bounds, endpoint gaps, and shape overlaps with offending IDs', async () => {
    const xml = await fixture('simple-process.bpmn');
    const invalidGeometry = xml
      .replace('x="152" y="102" width="36"', 'x="NaN" y="102" width="36"')
      .replace('x="240" y="80" width="100"', 'x="380" y="80" width="100"')
      .replace('x="188" y="120"', 'x="210" y="120"');
    const report = await validateBpmnGeometry(invalidGeometry);

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NON_FINITE_GEOMETRY', ids: ['StartEvent_1'] }),
      expect.objectContaining({ code: 'ENDPOINT_GAP', ids: ['Flow_1', 'Task_1'] }),
      expect.objectContaining({ code: 'SHAPE_OVERLAP', ids: ['EndEvent_1', 'Task_1'] })
    ]));
    expect(formatGeometryDiagnostics(report)).toContain('Flow_1');
  });

  it('reports expanded subprocess containment failures', async () => {
    const xml = (await fixture('engine-contract/hierarchy-extensions-labels-di.bpmn'))
      .replace('x="280" y="130" width="100"', 'x="700" y="130" width="100"');
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'CONTAINMENT_FAILURE',
        ids: ['Task_Nested', 'SubProcess_ContractFixture']
      })
    ]));
  });

  it('reports edge-to-unrelated-shape collisions while allowing source and target docking', async () => {
    const xml = (await fixture('simple-process.bpmn'))
      .replace(
        '<di:waypoint x="188" y="120" />\n        <di:waypoint x="240" y="120" />',
        '<di:waypoint x="188" y="120" />\n        <di:waypoint x="410" y="120" />\n        <di:waypoint x="240" y="120" />'
      );
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'EDGE_SHAPE_COLLISION',
        ids: ['Flow_1', 'EndEvent_1']
      })
    ]));
  });

  it('does not exempt an unrelated subprocess from edge collision checks', async () => {
    const xml = (await fixture('simple-process.bpmn'))
      .replace(
        '    <bpmn:endEvent id="EndEvent_1"',
        '    <bpmn:subProcess id="SubProcess_Unrelated" />\n    <bpmn:endEvent id="EndEvent_1"'
      )
      .replace(
        '      <bpmndi:BPMNShape id="EndEvent_1_di"',
        '      <bpmndi:BPMNShape id="SubProcess_Unrelated_di" bpmnElement="SubProcess_Unrelated">\n        <dc:Bounds x="200" y="90" width="30" height="60" />\n      </bpmndi:BPMNShape>\n      <bpmndi:BPMNShape id="EndEvent_1_di"'
      );
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'EDGE_SHAPE_COLLISION',
        ids: ['Flow_1', 'SubProcess_Unrelated']
      })
    ]));
  });

  it('reports connector crossings once with both edge IDs', async () => {
    const xml = (await fixture('simple-process.bpmn'))
      .replace(
        '<di:waypoint x="188" y="120" />\n        <di:waypoint x="240" y="120" />',
        '<di:waypoint x="200" y="200" />\n        <di:waypoint x="300" y="300" />'
      )
      .replace(
        '<di:waypoint x="340" y="120" />\n        <di:waypoint x="392" y="120" />',
        '<di:waypoint x="200" y="300" />\n        <di:waypoint x="300" y="200" />'
      );
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics.filter(item => item.code === 'EDGE_EDGE_CROSSING')).toEqual([
      expect.objectContaining({ ids: ['Flow_1', 'Flow_2'] })
    ]);
  });

  it('does not report connectors that only meet at a shared waypoint', async () => {
    const xml = (await fixture('simple-process.bpmn')).replace(
      '<di:waypoint x="340" y="120" />',
      '<di:waypoint x="240" y="120" />'
    );
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics.map(item => item.code)).not.toContain('EDGE_EDGE_CROSSING');
  });

  it('extracts label bounds and reports label-to-shape overlap', async () => {
    const xml = (await fixture('simple-process.bpmn')).replace(
      '        <di:waypoint x="240" y="120" />\n      </bpmndi:BPMNEdge>',
      '        <di:waypoint x="240" y="120" />\n        <bpmndi:BPMNLabel id="Flow_1_label">\n          <dc:Bounds x="245" y="90" width="80" height="30" />\n        </bpmndi:BPMNLabel>\n      </bpmndi:BPMNEdge>'
    );
    const report = await validateBpmnGeometry(xml);

    expect(report.geometry?.labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'Flow_1_label', ownerId: 'Flow_1' })
    ]));
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LABEL_OVERLAP', ids: ['Flow_1', 'Task_1'] })
    ]));
  });

  it('reports overlapping labels with both owner IDs', async () => {
    const xml = (await fixture('simple-process.bpmn'))
      .replace(
        '        <di:waypoint x="240" y="120" />\n      </bpmndi:BPMNEdge>',
        '        <di:waypoint x="240" y="120" />\n        <bpmndi:BPMNLabel id="Flow_1_label">\n          <dc:Bounds x="250" y="180" width="80" height="30" />\n        </bpmndi:BPMNLabel>\n      </bpmndi:BPMNEdge>'
      )
      .replace(
        '        <di:waypoint x="392" y="120" />\n      </bpmndi:BPMNEdge>',
        '        <di:waypoint x="392" y="120" />\n        <bpmndi:BPMNLabel id="Flow_2_label">\n          <dc:Bounds x="300" y="190" width="80" height="30" />\n        </bpmndi:BPMNLabel>\n      </bpmndi:BPMNEdge>'
      );
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LABEL_OVERLAP', ids: ['Flow_1', 'Flow_2'] })
    ]));
  });

  it('does not report overlapping labels on different DI planes', async () => {
    const xml = (await fixture('simple-process.bpmn'))
      .replace(
        '        <di:waypoint x="240" y="120" />\n      </bpmndi:BPMNEdge>',
        '        <di:waypoint x="240" y="120" />\n        <bpmndi:BPMNLabel id="Flow_1_label">\n          <dc:Bounds x="250" y="180" width="80" height="30" />\n        </bpmndi:BPMNLabel>\n      </bpmndi:BPMNEdge>'
      )
      .replace(
        '  </bpmndi:BPMNDiagram>\n</bpmn:definitions>',
        '  </bpmndi:BPMNDiagram>\n  <bpmndi:BPMNDiagram id="BPMNDiagram_2">\n    <bpmndi:BPMNPlane id="BPMNPlane_2" bpmnElement="Process_test">\n      <bpmndi:BPMNEdge id="Flow_2_di_plane_2" bpmnElement="Flow_2">\n        <di:waypoint x="340" y="120" />\n        <di:waypoint x="392" y="120" />\n        <bpmndi:BPMNLabel id="Flow_2_label">\n          <dc:Bounds x="250" y="180" width="80" height="30" />\n        </bpmndi:BPMNLabel>\n      </bpmndi:BPMNEdge>\n    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n</bpmn:definitions>'
      );
    const report = await validateBpmnGeometry(xml);

    expect(report.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LABEL_OVERLAP', ids: ['Flow_1', 'Flow_2'] })
    ]));
  });

  it('normalizes translated and sub-tolerance geometry identically', () => {
    const createGeometry = (offsetX: number, offsetY: number, noise: number): BpmnGeometry => ({
      shapes: [{
        id: 'Task_A',
        diId: 'Task_A_di',
        type: 'bpmn:Task',
        planeId: 'Plane_1',
        bounds: { x: 100 + offsetX + noise, y: 50 + offsetY, width: 100, height: 80 }
      }],
      edges: [{
        id: 'Flow_A',
        diId: 'Flow_A_di',
        type: 'bpmn:SequenceFlow',
        planeId: 'Plane_1',
        sourceId: 'Task_A',
        targetId: 'Task_A',
        waypoints: [
          { x: 200 + offsetX + noise, y: 90 + offsetY },
          { x: 100 + offsetX + noise, y: 90 + offsetY }
        ]
      }],
      labels: []
    });

    expect(normalizeGeometry(createGeometry(0, 0, 0), 0.5)).toEqual(
      normalizeGeometry(createGeometry(1000, -200, 0.1), 0.5)
    );
  });

  it('normalizes more waypoints than can be passed as function arguments', () => {
    const waypointCount = 150_000;
    const geometry: BpmnGeometry = {
      shapes: [],
      edges: [{
        id: 'Flow_large',
        diId: 'Flow_large_di',
        type: 'bpmn:SequenceFlow',
        planeId: 'Plane_1',
        waypoints: Array.from({ length: waypointCount }, (_, index) => ({
          x: index + 100,
          y: waypointCount - index + 100
        }))
      }],
      labels: []
    };

    const normalized = normalizeGeometry(geometry);

    expect(normalized.edges[0].waypoints[0]).toEqual({ x: 0, y: waypointCount - 1 });
    expect(normalized.edges[0].waypoints[waypointCount - 1]).toEqual({
      x: waypointCount - 1,
      y: 0
    });
  });
});
