import BpmnModdle from 'bpmn-moddle';
import { MermaidConverter } from '../../src/converters/MermaidConverter.js';
import { BpmnDocumentSerializer } from '../../src/core/BpmnDocument.js';
import { config } from '../../src/config/index.js';
import { BpmnValidator } from '../../src/core/BpmnValidator.js';

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

  it('reports lossy Mermaid constructs and emits only the semantics it claims', async () => {
    const source = 'flowchart TD\n  A((Start)) -.-> B((End))\n  style A fill:#fff';
    const conversion = await converter.convert(source, { autoLayout: false });

    expect(conversion.warnings).toEqual([
      '2:14 [UNSUPPORTED_EDGE_STYLE] Dotted Mermaid edge A_to_B is converted without dotted styling',
      '3:3 [UNSUPPORTED_DIRECTIVE] Unsupported Mermaid directive "style"; ignored'
    ]);
    expect(conversion.elements.map(element => element.type).sort())
      .toEqual(['bpmn:EndEvent', 'bpmn:StartEvent']);
    expect(conversion.flows).toHaveLength(1);
    expect(conversion.pools).toEqual([]);
  });

  it('reports standalone data semantics without claiming tasks or swimlanes', async () => {
    const source = 'flowchart TD\n  Record[[Customer record]]';
    const conversion = await converter.convert(source, { autoLayout: false });

    expect(conversion.elements.map(element => element.type))
      .toEqual(['bpmn:DataObjectReference']);
    expect(conversion.flows).toEqual([]);
    expect(conversion.pools).toEqual([]);
  });

  it.each([
    [
      'trailing keywords',
      'flowchart TD\n  A((Order Started)) --> B[Pack] --> C((Send Invoice))',
      'Order Started',
      'Send Invoice',
      'Order Started'
    ],
    [
      'leading keywords',
      'flowchart TD\n  A((Start Order)) --> B[Pack] --> C((Order Ended))',
      'Start Order',
      'Order Ended',
      'Start Order'
    ],
    [
      'exact keywords',
      'flowchart TD\n  A((Start)) --> B[Pack] --> C((End))',
      undefined,
      undefined,
      'Converted Process'
    ]
  ])(
    'keeps event names and the process name for %s',
    async (_name, source, startName, endName, processName) => {
      const result = await converter.convert(source, { autoLayout: false });
      const parsed = await moddle.fromXML(result.xml);
      const process = parsed.rootElement.rootElements.find(
        (root: any) => root.$type === 'bpmn:Process'
      );

      expect(parsed.warnings).toEqual([]);
      expect(parsed.elementsById.StartEvent_A.name).toBe(startName);
      expect(parsed.elementsById.EndEvent_C.name).toBe(endName);
      expect(parsed.elementsById.Task_B.name).toBe('Pack');
      expect(process.name).toBe(processName);
    }
  );

  it('converts a semicolon-terminated diagram exactly like its newline form', async () => {
    const semicolons = await converter.convert(
      'graph TD; A((Start)) --> B[Pack]; B --> C((End));',
      { autoLayout: false }
    );
    const newlines = await converter.convert(
      'graph TD\n  A((Start)) --> B[Pack]\n  B --> C((End))',
      { autoLayout: false }
    );

    expect(semicolons.xml).toBe(newlines.xml);
    expect(semicolons.stats).toEqual({ nodeCount: 3, edgeCount: 2 });
  });

  it('rejects a cross-subgraph gateway edge with the author Mermaid ids, not BPMN ids', async () => {
    const source = [
      'flowchart TD',
      'subgraph a[A]',
      '  S((Start)) --> T[Task] --> G{Which?}',
      'end',
      'subgraph b[B]',
      '  U[Work] --> E((End))',
      'end',
      'G --> U'
    ].join('\n');

    await expect(converter.convert(source)).rejects.toThrow(
      /8:3 \[UNSUPPORTED_EDGE_ENDPOINT\].*Mermaid node G is a gateway/
    );
    await expect(converter.convert(source)).rejects.not.toThrow(/Gateway_G|MessageFlow_/);
  });

  it('names BPMN elements with the quoted label, not with the quotes (mcp-bpmn-j21.4)', async () => {
    const source = [
      'flowchart LR',
      '  subgraph cust ["Customer Side"]',
      '    S((Start)) --> T["Review (draft) [urgent]"]',
      '    T --> E((End))',
      '  end'
    ].join('\n');
    const result = await converter.convert(source, { autoLayout: false });
    const parsed = await moddle.fromXML(result.xml);
    const collaboration = parsed.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Collaboration'
    );

    expect(parsed.warnings).toEqual([]);
    expect(result.xml).not.toContain('&#34;');
    expect(parsed.elementsById.Task_T.name).toBe('Review (draft) [urgent]');
    expect(collaboration.participants[0].name).toBe('Customer Side');
  });

  it('converts the primary Mermaid edge and subgraph forms end to end (mcp-bpmn-j21.6, j21.7)', async () => {
    const source = [
      'graph LR',
      '  subgraph Customer Side',
      '    S((Start)) -- submit --> T[Review]',
      '    T ==> U[Approve]',
      '    U --- E((End))',
      '  end'
    ].join('\n');
    const result = await converter.convert(source, { autoLayout: false });
    const parsed = await moddle.fromXML(result.xml);
    const collaboration = parsed.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Collaboration'
    );
    const process = parsed.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Process'
    );
    const sequenceFlows = process.flowElements.filter(
      (element: any) => element.$type === 'bpmn:SequenceFlow'
    );

    expect(parsed.warnings).toEqual([]);
    expect(collaboration.participants[0].name).toBe('Customer Side');
    expect(sequenceFlows).toHaveLength(3);
    expect(sequenceFlows.map((flow: any) => flow.name)).toEqual(['submit', undefined, undefined]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('[UNSUPPORTED_EDGE_STYLE] Thick Mermaid edge T_to_U'),
      expect.stringContaining('[UNSUPPORTED_EDGE_STYLE] Undirected Mermaid edge U_to_E')
    ]));
  });

  it('reports an implicit parallel split without changing the conversion (mcp-bpmn-j21.8)', async () => {
    const source = [
      'flowchart TD',
      '  A[Check] -->|ok| B[Ship]',
      '  A -->|fail| C[Refund]'
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
    expect(sequenceFlows.map((flow: any) => [flow.sourceRef.id, flow.targetRef.id])).toEqual([
      ['Task_A', 'Task_B'],
      ['Task_A', 'Task_C']
    ]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('2:3 [IMPLICIT_PARALLEL_SPLIT] Node "A" has 2 outgoing connections')
    ]));
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

  it('converts a fully steered diagram to valid BPMN (mcp-bpmn-j21.12)', async () => {
    const source = [
      'flowchart TD',
      '  S((Order placed)):::message --> A[Approve]:::user',
      '  A --> G{Split}:::parallel',
      '  G --> B[Charge card]:::service',
      '  G --> W((Await shipment)):::timer',
      '  B --> E((Done)):::terminate',
      '  W --> E'
    ].join('\n');

    const result = await converter.convert(source, { autoLayout: false });
    const validation = await new BpmnValidator().validate(result.xml, 'full');
    const parsed = await moddle.fromXML(result.xml);
    const process = parsed.rootElement.rootElements.find((root: any) => root.$type === 'bpmn:Process');
    const byId = new Map<string, any>(
      process.flowElements.map((element: any) => [element.id, element])
    );

    expect(result.warnings).toEqual([]);
    expect(validation).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(byId.get('Task_A').$type).toBe('bpmn:UserTask');
    expect(byId.get('Task_B').$type).toBe('bpmn:ServiceTask');
    expect(byId.get('Gateway_G').$type).toBe('bpmn:ParallelGateway');
    expect(byId.get('Event_W').$type).toBe('bpmn:IntermediateCatchEvent');
    expect(byId.get('Event_W').eventDefinitions.map((definition: any) => definition.$type))
      .toEqual(['bpmn:TimerEventDefinition']);
    expect(byId.get('StartEvent_S').eventDefinitions.map((definition: any) => definition.$type))
      .toEqual(['bpmn:MessageEventDefinition']);
    expect(byId.get('EndEvent_E').eventDefinitions.map((definition: any) => definition.$type))
      .toEqual(['bpmn:TerminateEventDefinition']);
  });
});
