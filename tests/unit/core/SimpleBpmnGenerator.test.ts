import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import BpmnModdle from 'bpmn-moddle';
import { SimpleBpmnGenerator } from '../../../src/core/SimpleBpmnGenerator.js';
import { MermaidConverter } from '../../../src/converters/MermaidConverter.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import type { MermaidAST } from '../../../src/converters/ASTTypes.js';

describe('SimpleBpmnGenerator collaboration semantics', () => {
  const moddle = new BpmnModdle();

  const twoSubgraphAst = (): MermaidAST => ({
    type: 'flowchart',
    direction: 'LR',
    nodes: [
      { id: 'BuyerStart', type: 'start', label: 'Start' },
      { id: 'BuyerSend', type: 'process', label: 'Send order' },
      { id: 'SellerReceive', type: 'process', label: 'Receive order' },
      { id: 'SellerEnd', type: 'end', label: 'End' }
    ],
    edges: [
      { id: 'BuyerInternal', source: 'BuyerStart', target: 'BuyerSend', type: 'directed' },
      { id: 'OrderMessage', source: 'BuyerSend', target: 'SellerReceive', type: 'directed' },
      { id: 'SellerInternal', source: 'SellerReceive', target: 'SellerEnd', type: 'directed' }
    ],
    subgraphs: [
      { id: 'Buyer', title: 'Buyer', nodes: ['BuyerStart', 'BuyerSend'] },
      { id: 'Seller', title: 'Seller', nodes: ['SellerReceive', 'SellerEnd'] }
    ]
  });

  it('round-trips two subgraphs as distinct processes with scoped sequence and message flows', async () => {
    const result = await new SimpleBpmnGenerator().generateBpmn(twoSubgraphAst(), 'Order handling');
    const definitions = (await moddle.fromXML(result.xml)).rootElement;
    const collaboration = definitions.rootElements.find((root: any) => root.$type === 'bpmn:Collaboration');
    const processes = definitions.rootElements.filter((root: any) => root.$type === 'bpmn:Process');

    expect(result.processId).toBe(collaboration.id);
    expect(processes).toHaveLength(2);
    expect(collaboration.participants.map((participant: any) => participant.processRef.id)).toEqual(
      processes.map((process: any) => process.id)
    );
    expect(new Set(collaboration.participants.map((participant: any) => participant.processRef.id)).size).toBe(2);
    expect(processes.map((process: any) => process.flowElements.filter(
      (element: any) => element.$type === 'bpmn:SequenceFlow'
    ).length)).toEqual([1, 1]);
    expect(collaboration.messageFlows).toHaveLength(1);
    expect(collaboration.messageFlows[0].sourceRef.id).toBe('Task_BuyerSend');
    expect(collaboration.messageFlows[0].targetRef.id).toBe('Task_SellerReceive');
    expect(definitions.diagrams[0].plane.bpmnElement.id).toBe(collaboration.id);

    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-generator-'));
    try {
      const engine = new SimpleBpmnEngine(directory);
      const imported = await engine.importXml(result.xml);
      const roundTripped = (await moddle.fromXML(await engine.exportXml(imported.id))).rootElement;
      const roundTripCollaboration = roundTripped.rootElements.find(
        (root: any) => root.$type === 'bpmn:Collaboration'
      );
      expect(roundTripCollaboration.participants.map((participant: any) => participant.processRef.id)).toEqual(
        collaboration.participants.map((participant: any) => participant.processRef.id)
      );
      expect(roundTripCollaboration.messageFlows).toHaveLength(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes Mermaid data nodes as resolved data-object pairs, never tasks', async () => {
    const ast: MermaidAST = {
      type: 'flowchart',
      direction: 'TD',
      nodes: [{ id: 'Record', type: 'data', label: 'Customer record' }],
      edges: [],
      subgraphs: []
    };
    const result = await new SimpleBpmnGenerator().generateBpmn(ast, 'Data semantics');
    const parsed = await moddle.fromXML(result.xml);
    const process = parsed.rootElement.rootElements.find(
      (root: any) => root.$type === 'bpmn:Process'
    );
    const dataObject = parsed.elementsById.DataObject_Record;
    const reference = parsed.elementsById.DataObjectReference_Record;

    expect(dataObject.$type).toBe('bpmn:DataObject');
    expect(reference).toMatchObject({
      $type: 'bpmn:DataObjectReference',
      dataObjectRef: dataObject
    });
    expect(process.flowElements.some((element: any) => element.$type === 'bpmn:Task')).toBe(false);
    expect(parsed.elementsById.DataObjectReference_Record_di.bpmnElement).toBe(reference);
  });

  it.each([
    ['start', 'Order Started', 'Order Started'],
    ['start', 'Restart', 'Restart'],
    ['start', 'Start', undefined],
    ['start', '  BEGIN  ', undefined],
    ['end', 'Send Invoice', 'Send Invoice'],
    ['end', 'Pending', 'Pending'],
    ['end', 'End', undefined],
    ['end', 'finish', undefined]
  ] as Array<['start' | 'end', string, string | undefined]>)(
    'names a %s event from the label %p',
    async (type, label, expectedName) => {
      const ast: MermaidAST = {
        type: 'flowchart',
        direction: 'TD',
        nodes: [{ id: 'N', type, label }],
        edges: [],
        subgraphs: []
      };
      const result = await new SimpleBpmnGenerator().generateBpmn(ast, 'Event naming');
      const parsed = await moddle.fromXML(result.xml);
      const elementId = type === 'start' ? 'StartEvent_N' : 'EndEvent_N';

      expect(parsed.warnings).toEqual([]);
      expect(parsed.elementsById[elementId].$type).toBe(
        type === 'start' ? 'bpmn:StartEvent' : 'bpmn:EndEvent'
      );
      expect(parsed.elementsById[elementId].name).toBe(expectedName);
    }
  );

  it('rejects subgraph diagrams with missing or ambiguous node ownership', async () => {
    const missingOwner = twoSubgraphAst();
    missingOwner.subgraphs[1].nodes = ['SellerReceive'];
    await expect(new SimpleBpmnGenerator().generateBpmn(missingOwner, 'Missing owner'))
      .rejects.toThrow('not owned by a subgraph');

    const ambiguousOwner = twoSubgraphAst();
    ambiguousOwner.subgraphs[1].nodes.push('BuyerSend');
    await expect(new SimpleBpmnGenerator().generateBpmn(ambiguousOwner, 'Ambiguous owner'))
      .rejects.toThrow('belongs to multiple subgraphs');

    const duplicateSubgraph = twoSubgraphAst();
    duplicateSubgraph.subgraphs[1].id = duplicateSubgraph.subgraphs[0].id;
    await expect(new SimpleBpmnGenerator().generateBpmn(duplicateSubgraph, 'Duplicate subgraph'))
      .rejects.toThrow('Duplicate Mermaid subgraph ID');
  });
});

describe('SimpleBpmnGenerator subtype steering (mcp-bpmn-j21.12)', () => {
  const converter = new MermaidConverter();

  const typeOf = (
    conversion: { elements: Array<{ id: string; type: string }> },
    mermaidId: string
  ): string | undefined =>
    conversion.elements.find(element => element.id.endsWith(`_${mermaidId}`))?.type;

  it.each([
    ['user', 'bpmn:UserTask'],
    ['service', 'bpmn:ServiceTask'],
    ['script', 'bpmn:ScriptTask'],
    ['businessRule', 'bpmn:BusinessRuleTask'],
    ['manual', 'bpmn:ManualTask'],
    ['receive', 'bpmn:ReceiveTask'],
    ['send', 'bpmn:SendTask']
  ])('converts a task refined with :::%s to %s', async (subtype, bpmnType) => {
    const conversion = await converter.convert(
      `flowchart TD\n  S((Start)) --> A[Do it]:::${subtype} --> E((End))`,
      { autoLayout: false }
    );

    const localName = bpmnType.slice('bpmn:'.length);
    expect(typeOf(conversion, 'A')).toBe(bpmnType);
    expect(conversion.xml)
      .toContain(`<bpmn:${localName[0].toLowerCase()}${localName.slice(1)}`);
  });

  it.each([
    ['parallel', 'bpmn:ParallelGateway'],
    ['inclusive', 'bpmn:InclusiveGateway'],
    ['eventBased', 'bpmn:EventBasedGateway'],
    ['complex', 'bpmn:ComplexGateway']
  ])('converts a gateway refined with :::%s to %s', async (subtype, bpmnType) => {
    const conversion = await converter.convert(
      `flowchart TD\n  S((Start)) --> G{Which?}:::${subtype}\n  G --> A[One]\n  G --> B[Two]`,
      { autoLayout: false }
    );

    expect(typeOf(conversion, 'G')).toBe(bpmnType);
  });

  it('leaves an unrefined shape on its default BPMN type', async () => {
    const conversion = await converter.convert(
      'flowchart TD\n  S((Start)) --> A[Do it] --> G{Which?}\n  G --> E((End))',
      { autoLayout: false }
    );

    expect(typeOf(conversion, 'A')).toBe('bpmn:Task');
    expect(typeOf(conversion, 'G')).toBe('bpmn:ExclusiveGateway');
  });

  it.each([
    ['message', 'bpmn:messageEventDefinition'],
    ['timer', 'bpmn:timerEventDefinition'],
    ['signal', 'bpmn:signalEventDefinition'],
    ['conditional', 'bpmn:conditionalEventDefinition']
  ])('gives a start event refined with :::%s the %s', async (subtype, definition) => {
    const conversion = await converter.convert(
      `flowchart TD\n  S((Order placed)):::${subtype} --> A[Work] --> E((End))`,
      { autoLayout: false }
    );

    expect(typeOf(conversion, 'S')).toBe('bpmn:StartEvent');
    expect(conversion.xml).toMatch(new RegExp(`<bpmn:startEvent[^>]*>[\\s\\S]*?<${definition}`));
  });

  it.each([
    ['error', 'bpmn:errorEventDefinition'],
    ['terminate', 'bpmn:terminateEventDefinition'],
    ['escalation', 'bpmn:escalationEventDefinition'],
    ['cancel', 'bpmn:cancelEventDefinition']
  ])('gives an end event refined with :::%s the %s', async (subtype, definition) => {
    const conversion = await converter.convert(
      `flowchart TD\n  S((Start)) --> A[Work] --> E((Stopped)):::${subtype}`,
      { autoLayout: false }
    );

    expect(typeOf(conversion, 'E')).toBe('bpmn:EndEvent');
    expect(conversion.xml).toMatch(new RegExp(`<bpmn:endEvent[^>]*>[\\s\\S]*?<${definition}`));
  });

  it.each([
    ['message', 'bpmn:IntermediateCatchEvent'],
    ['timer', 'bpmn:IntermediateCatchEvent'],
    ['conditional', 'bpmn:IntermediateCatchEvent'],
    ['signal', 'bpmn:IntermediateCatchEvent'],
    ['escalation', 'bpmn:IntermediateThrowEvent'],
    ['compensation', 'bpmn:IntermediateThrowEvent']
  ])('makes an intermediate event refined with :::%s a %s', async (subtype, bpmnType) => {
    const conversion = await converter.convert(
      `flowchart TD\n  S((Start)) --> W((Wait)):::${subtype} --> E((End))`,
      { autoLayout: false }
    );

    expect(typeOf(conversion, 'W')).toBe(bpmnType);
  });

  it('leaves an unrefined intermediate event a throw event with no definition', async () => {
    const conversion = await converter.convert(
      'flowchart TD\n  S((Start)) --> W((Wait)) --> E((End))',
      { autoLayout: false }
    );

    expect(typeOf(conversion, 'W')).toBe('bpmn:IntermediateThrowEvent');
    expect(conversion.xml).not.toContain('EventDefinition');
  });

  it('counts refined activities, gateways and events in the conversion statistics', async () => {
    const conversion = await converter.convert([
      'flowchart TD',
      '  S((Order placed)):::message --> A[Approve]:::user',
      '  A --> G{Split}:::parallel',
      '  G --> B[Charge]:::service',
      '  G --> W((Await shipment)):::timer',
      '  B --> E((Done)):::terminate',
      '  W --> E'
    ].join('\n'), { autoLayout: false });

    expect(conversion.warnings).toEqual([]);
    expect(conversion.statistics).toMatchObject({
      totalElements: 6,
      tasks: 2,
      gateways: 1,
      events: 3
    });
  });
});
