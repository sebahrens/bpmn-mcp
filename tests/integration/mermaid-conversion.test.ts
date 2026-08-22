import BpmnModdle from 'bpmn-moddle';
import { MermaidConverter } from '../../src/converters/MermaidConverter.js';
import { BpmnDocumentSerializer } from '../../src/core/BpmnDocument.js';
import { config } from '../../src/config/index.js';

describe('Mermaid conversion semantics', () => {
  const moddle = new BpmnModdle();
  const converter = new MermaidConverter();

  it('keeps a labeled edge as a sequence-flow name without inventing a condition', async () => {
    const result = await converter.convert(
      'flowchart TD\n  A((Start)) -->|approved & audited| B((End))',
      { autoLayout: false }
    );
    const parsed = await moddle.fromXML(result.xml);
    const process = parsed.rootElement.rootElements.find((root: any) => root.$type === 'bpmn:Process');
    const sequenceFlow = process.flowElements.find((element: any) => element.$type === 'bpmn:SequenceFlow');

    expect(parsed.warnings).toEqual([]);
    expect(sequenceFlow.name).toBe('approved & audited');
    expect(sequenceFlow.conditionExpression).toBeUndefined();
  });

  it('emits a data object reference linked to a backing data object', async () => {
    const result = await converter.convert('flowchart TD\n  Record[[Customer & order]]');
    const parsed = await moddle.fromXML(result.xml);
    const process = parsed.rootElement.rootElements.find((root: any) => root.$type === 'bpmn:Process');
    const dataObject = process.flowElements.find((element: any) => element.$type === 'bpmn:DataObject');
    const reference = process.flowElements.find(
      (element: any) => element.$type === 'bpmn:DataObjectReference'
    );

    expect(parsed.warnings).toEqual([]);
    expect(dataObject).toMatchObject({ id: 'DataObject_Record', name: 'Customer & order' });
    expect(reference).toMatchObject({
      id: 'DataObjectReference_Record',
      name: 'Customer & order',
      dataObjectRef: dataObject
    });
    expect(parsed.rootElement.diagrams[0].plane.planeElement.some(
      (element: any) => element.$type === 'bpmndi:BPMNShape'
        && element.bpmnElement === reference
    )).toBe(true);

    const serializer = new BpmnDocumentSerializer();
    const imported = await serializer.parse(result.xml, config.bpmnImportLimits);
    const roundTripped = await moddle.fromXML(await serializer.serialize(imported.document));
    const roundTripProcess = roundTripped.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Process'
    );
    const roundTripReference = roundTripProcess.flowElements.find(
      (element: any) => element.$type === 'bpmn:DataObjectReference'
    );
    expect(roundTripReference.dataObjectRef.$type).toBe('bpmn:DataObject');
    expect(roundTripReference.dataObjectRef.id).toBe('DataObject_Record');
  });

  it('maps two subgraphs to distinct participant processes and collaboration DI', async () => {
    const source = [
      'flowchart LR',
      '  subgraph buyer[Buyer & requester]',
      '    A((Start)) --> B[Send <order>]',
      '  end',
      '  subgraph seller[Seller & provider]',
      '    C[Receive order] --> D((End))',
      '  end',
      '  B -->|handoff & audit| C'
    ].join('\n');
    const result = await converter.convert(source, { autoLayout: false });
    const parsed = await moddle.fromXML(result.xml);
    const collaboration = parsed.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Collaboration'
    );
    const processes = parsed.rootElement.rootElements.filter(
      (root: any) => root.$type === 'bpmn:Process'
    );

    expect(parsed.warnings).toEqual([]);
    expect(collaboration.participants.map((participant: any) => participant.name)).toEqual([
      'Buyer & requester',
      'Seller & provider'
    ]);
    expect(new Set(collaboration.participants.map(
      (participant: any) => participant.processRef.id
    ))).toEqual(new Set(processes.map((process: any) => process.id)));
    expect(processes).toHaveLength(2);
    expect(processes.map((process: any) => process.flowElements.filter(
      (element: any) => element.$type === 'bpmn:SequenceFlow'
    ).length)).toEqual([1, 1]);
    expect(collaboration.messageFlows).toHaveLength(1);
    expect(collaboration.messageFlows[0].name).toBe('handoff & audit');
    expect(parsed.rootElement.diagrams[0].plane.bpmnElement).toBe(collaboration);
  });

  it('reports lossy Mermaid constructs consistently and advertises only emitted semantics', async () => {
    const source = 'flowchart TD\n  A((Start)) -.-> B((End))\n  style A fill:#fff';
    const conversion = await converter.convert(source, { autoLayout: false });
    const validation = await converter.canConvert(source);
    const analysis = await converter.analyze(source);

    expect(conversion.warnings).toEqual([
      '2:14 [UNSUPPORTED_EDGE_STYLE] Dotted Mermaid edge A_to_B is converted without dotted styling',
      '3:3 [UNSUPPORTED_DIRECTIVE] Unsupported Mermaid directive "style"; ignored'
    ]);
    expect(validation).toMatchObject({
      valid: true,
      warnings: conversion.warnings,
      supportedFeatures: ['Events']
    });
    expect(analysis).toMatchObject({
      warnings: conversion.warnings,
      estimatedBpmnElements: {
        tasks: 0,
        subprocesses: 0,
        dataObjects: 0,
        gateways: 0,
        events: 2,
        pools: 0,
        flows: 1
      }
    });
  });

  it('reports standalone data semantics without claiming tasks or swimlanes', async () => {
    const source = 'flowchart TD\n  Record[[Customer record]]';
    const validation = await converter.canConvert(source);
    const analysis = await converter.analyze(source);

    expect(validation.supportedFeatures).toEqual(['Data objects']);
    expect(validation.supportedFeatures).not.toContain('Tasks');
    expect(validation.supportedFeatures).not.toContain('Pools/Swimlanes');
    expect(analysis.estimatedBpmnElements).toMatchObject({
      tasks: 0,
      subprocesses: 0,
      dataObjects: 1,
      pools: 0
    });
  });

  it('preserves parallel edges and their labels in BPMN conversion', async () => {
    const source = [
      'flowchart TD',
      '  A((Start)) --> B((End))',
      '  A -->|approved| B',
      '  A -.->|retry| B',
      '  A -->|approved| B'
    ].join('\n');
    const result = await converter.convert(source, { autoLayout: false });
    const parsed = await moddle.fromXML(result.xml);
    const process = parsed.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Process'
    );
    const sequenceFlows = process.flowElements.filter(
      (element: any) => element.$type === 'bpmn:SequenceFlow'
    );

    expect(parsed.warnings).toEqual([]);
    expect(result.stats.edgeCount).toBe(4);
    expect(sequenceFlows).toHaveLength(4);
    expect(sequenceFlows.map((flow: any) => flow.name)).toEqual([
      undefined,
      'approved',
      'retry',
      'approved'
    ]);
  });
});
