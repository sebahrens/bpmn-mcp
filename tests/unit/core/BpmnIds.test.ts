import BpmnModdle from 'bpmn-moddle';
import { config } from '../../../src/config/index.js';
import {
  BpmnDocumentSerializer,
  createBpmnDocument,
  synchronizeDiagramInterchange
} from '../../../src/core/BpmnDocument.js';
import { BpmnValidator } from '../../../src/core/BpmnValidator.js';
import type {
  BpmnDocument,
  EventDefinitionPayload
} from '../../../src/types/index.js';

function completeDocument(): BpmnDocument {
  const document = createBpmnDocument('Process_A', 'IDs', 'process');
  document.collaborations.set('Collaboration_A', { id: 'Collaboration_A', name: 'Collaboration' });
  document.itemDefinitions.add('ItemDefinition_A');
  document.dataObjects.set('DataObject_A', {
    id: 'DataObject_A',
    ownerId: 'Process_A',
    scopeId: 'Process_A',
    itemSubjectRef: 'ItemDefinition_A'
  });
  document.elements.set('Task_A', {
    kind: 'flowNode', id: 'Task_A', type: 'bpmn:Task', ownerId: 'Process_A', scopeId: 'Process_A',
    position: { x: 100, y: 100 }, size: { width: 100, height: 80 }, properties: {}
  });
  document.elements.set('Task_B', {
    kind: 'flowNode', id: 'Task_B', type: 'bpmn:Task', ownerId: 'Process_A', scopeId: 'Process_A',
    position: { x: 300, y: 100 }, size: { width: 100, height: 80 }, properties: {}
  });
  document.elements.set('Event_A', {
    kind: 'flowNode', id: 'Event_A', type: 'bpmn:StartEvent', ownerId: 'Process_A', scopeId: 'Process_A',
    position: { x: 20, y: 100 }, size: { width: 36, height: 36 },
    properties: {
      eventDefinition: 'message',
      eventDefinitionPayload: {
        definitionId: 'MessageEventDefinition_A',
        reference: { id: 'Message_A' }
      }
    }
  });
  document.connections.set('Flow_A', {
    id: 'Flow_A', type: 'bpmn:SequenceFlow', source: 'Task_A', target: 'Task_B',
    ownerId: 'Process_A', scopeId: 'Process_A', waypoints: [{ x: 200, y: 140 }, { x: 300, y: 140 }],
    properties: {}
  });
  document.laneSets.set('LaneSet_A', {
    id: 'LaneSet_A', processId: 'Process_A', laneIds: ['Lane_A']
  });
  document.lanes.set('Lane_A', {
    id: 'Lane_A', processId: 'Process_A', laneSetId: 'LaneSet_A', flowNodeRefs: ['Task_A'],
    position: { x: 0, y: 0 }, size: { width: 500, height: 200 }
  });
  synchronizeDiagramInterchange(document);
  return document;
}

function eventPayload(document: BpmnDocument): EventDefinitionPayload {
  return document.elements.get('Event_A')!.properties.eventDefinitionPayload as EventDefinitionPayload;
}

describe('BPMN xsd:ID enforcement', () => {
  const serializer = new BpmnDocumentSerializer();

  it.each<Array<[string, (document: BpmnDocument) => void]>>([
    ['definitions', document => { document.definitionsId = 'a:b'; }],
    ['processes', document => { document.processes.get('Process_A')!.id = 'a:b'; }],
    ['collaborations', document => { document.collaborations.get('Collaboration_A')!.id = 'a:b'; }],
    ['item definitions', document => { document.itemDefinitions.clear(); document.itemDefinitions.add('a:b'); }],
    ['data objects', document => { document.dataObjects.get('DataObject_A')!.id = 'a:b'; }],
    ['lane sets', document => { document.laneSets.get('LaneSet_A')!.id = 'a:b'; }],
    ['lanes', document => { document.lanes.get('Lane_A')!.id = 'a:b'; }],
    ['elements', document => { document.elements.get('Task_A')!.id = 'a:b'; }],
    ['connections', document => { document.connections.get('Flow_A')!.id = 'a:b'; }],
    ['event definitions', document => { eventPayload(document).definitionId = 'a:b'; }],
    ['event root definitions', document => { eventPayload(document).reference!.id = 'a:b'; }],
    ['boundary attachment references', document => { document.elements.get('Event_A')!.properties.attachTo = 'a:b'; }],
    ['data object references', document => { document.elements.get('Task_A')!.properties.dataObjectRef = 'a:b'; }],
    ['item definition references', document => { document.elements.get('Task_A')!.properties.itemSubjectRef = 'a:b'; }],
    ['multi-instance input references', document => {
      document.elements.get('Task_A')!.properties.multiInstance = {
        isSequential: false, loopDataInputRef: 'a:b'
      };
    }],
    ['multi-instance output references', document => {
      document.elements.get('Task_A')!.properties.multiInstance = {
        isSequential: false, loopDataOutputRef: 'a:b'
      };
    }],
    ['BPMN diagrams', document => { document.diagram.id = 'a:b'; }],
    ['BPMN planes', document => { document.diagram.planeId = 'a:b'; }],
    ['BPMN shapes', document => { document.diagram.shapes.values().next().value!.id = 'a:b'; }],
    ['BPMN edges', document => { document.diagram.edges.values().next().value!.id = 'a:b'; }],
    ['BPMN plane references', document => { document.diagram.planeElementId = 'a:b'; }],
    ['BPMN shape references', document => { document.diagram.shapes.values().next().value!.elementId = 'a:b'; }],
    ['BPMN edge references', document => { document.diagram.edges.values().next().value!.connectionId = 'a:b'; }]
  ])('rejects invalid IDs in %s with a stable path before serialization', async (_name, mutate) => {
    const document = completeDocument();
    mutate(document);

    await expect(serializer.serialize(document)).rejects.toThrow(
      /Invalid BPMN xsd:ID at .+: "a:b" is not an XML NCName/
    );
  });

  it('rejects duplicate semantic and DI IDs before serialization', async () => {
    const document = completeDocument();
    document.diagram.id = 'Task_A';

    await expect(serializer.serialize(document)).rejects.toThrow(
      'Duplicate BPMN xsd:ID at diagram.id: "Task_A" is already used at elements["Task_A"].id'
    );
  });

  it.each<Array<[string, (document: BpmnDocument) => void]>>([
    ['item subject references', document => { document.dataObjects.get('DataObject_A')!.itemSubjectRef = ''; }],
    ['parent lane references', document => { document.laneSets.get('LaneSet_A')!.parentLaneId = ''; }],
    ['default flow references', document => { document.elements.get('Task_A')!.defaultFlow = ''; }],
    ['condition type references', document => {
      document.connections.get('Flow_A')!.condition = { body: 'true', evaluatesToTypeRef: '' };
    }]
  ])('rejects present-but-empty optional %s', async (_name, mutate) => {
    const document = completeDocument();
    mutate(document);
    await expect(serializer.serialize(document)).rejects.toThrow(
      /Invalid BPMN xsd:ID at .+: "" is not an XML NCName/
    );
  });

  it.each(['syntax', 'semantic', 'full'] as const)(
    'flags legacy invalid semantic and DI IDs during %s validation',
    async level => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  id="Definitions_Invalid" targetNamespace="http://example.test/bpmn">
  <bpmn:process id="Process_Invalid"><bpmn:task id="Task:Invalid" /></bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_Invalid">
    <bpmndi:BPMNPlane id="Plane_Invalid" bpmnElement="Process_Invalid">
      <bpmndi:BPMNShape id="Shape:Invalid" bpmnElement="Task:Invalid">
        <dc:Bounds x="0" y="0" width="100" height="80" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

      const result = await new BpmnValidator().validate(xml, level);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'BPMN_INVALID_ID', elementId: 'Task:Invalid' }),
        expect.objectContaining({ code: 'BPMN_INVALID_ID', elementId: 'Shape:Invalid' })
      ]));
      expect(result.errors
        .filter(issue => issue.code === 'BPMN_INVALID_ID' && issue.message.includes('.id:'))
        .length).toBeGreaterThanOrEqual(2);
    }
  );

  it('rejects imported invalid IDs without sanitizing them', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Invalid" targetNamespace="http://example.test/bpmn">
  <bpmn:process id="Process_Invalid"><bpmn:task id="a:b" /></bpmn:process>
</bpmn:definitions>`;

    await expect(serializer.parse(xml, config.bpmnImportLimits)).rejects.toThrow(
      /Failed to parse BPMN XML: Invalid BPMN xsd:ID at bpmn:task\[0\]\.id: "a:b"/
    );
  });

  it('rejects authored empty IDs before moddle can default or discard them', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  id="Definitions_A" targetNamespace="urn:test">
  <bpmn:process id="Process_A"><bpmn:task id="" /></bpmn:process>
  <bpmndi:BPMNDiagram id=""><bpmndi:BPMNPlane id="" bpmnElement="Process_A" /></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    await expect(serializer.parse(xml, config.bpmnImportLimits)).rejects.toThrow(
      'Invalid BPMN xsd:ID at bpmn:task[0].id: "" is not an XML NCName'
    );
    const result = await new BpmnValidator().validate(xml, 'syntax');
    expect(result.errors.filter(issue => issue.code === 'BPMN_INVALID_ID')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('bpmn:task[0].id') }),
        expect.objectContaining({ message: expect.stringContaining('bpmndi:BPMNDiagram[0].id') }),
        expect.objectContaining({ message: expect.stringContaining('bpmndi:BPMNPlane[0].id') })
      ])
    );
  });

  it('rejects imported duplicate semantic and DI IDs', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  id="Definitions_A" targetNamespace="urn:test">
  <bpmn:process id="Process_A"><bpmn:task id="Task_A" /></bpmn:process>
  <bpmndi:BPMNDiagram id="Task_A"><bpmndi:BPMNPlane id="Plane_A" bpmnElement="Process_A" /></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    await expect(serializer.parse(xml, config.bpmnImportLimits)).rejects.toThrow(
      /Duplicate BPMN xsd:ID at bpmndi:BPMNDiagram\[0\]\.id: "Task_A"/
    );
    await expect(new BpmnValidator().validate(xml, 'syntax')).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'BPMN_DUPLICATE_ID' })])
    });
  });

  it('serializes a valid complete document for downstream moddle', async () => {
    const xml = await serializer.serialize(completeDocument());
    const parsed = await new BpmnModdle().fromXML(xml);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.elementsById.Task_A.id).toBe('Task_A');
    expect(parsed.elementsById.Task_A_di.bpmnElement.id).toBe('Task_A');
  });
});
