import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import BpmnModdle from 'bpmn-moddle';
import type { MermaidAST } from '../../src/converters/ASTTypes.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { SimpleBpmnGenerator } from '../../src/core/SimpleBpmnGenerator.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

const injection = `& < > " ' Zürich Ω 🚀\nsecond line\n" injected="true"><bpmn:scriptTask id="Injected_Element" name="owned" />`;

function rootOfType(definitions: any, type: string): any {
  return definitions.rootElements.find((root: any) => root.$type === type);
}

function assertNoInjectedStructure(parsed: any): void {
  expect(parsed.elementsById.Injected_Element).toBeUndefined();
  for (const element of Object.values(parsed.elementsById) as any[]) {
    expect(element.injected).toBeUndefined();
    expect(element.$attrs?.injected).toBeUndefined();
  }
}

describe('schema-aware XML serialization', () => {
  const moddle = new BpmnModdle();

  it('round-trips engine-created and updated values without adding XML structure', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-xml-serialization-'));
    IdGenerator.reset();

    try {
      const engine = new SimpleBpmnEngine(directory);
      const processName = `Process ${injection}`;
      const createdName = `Created ${injection}`;
      const updatedName = `Updated ${injection}`;
      const flowLabel = `Flow ${injection}`;
      const conditionBody = `Condition ${injection}`;
      const conditionLanguage = `Language ${injection}`;
      const process = await engine.createProcess(processName);
      const gateway = await engine.createElement(process.id, {
        type: 'bpmn:ExclusiveGateway',
        name: createdName
      });
      const task = await engine.createElement(process.id, {
        type: 'bpmn:Task',
        name: 'Before update'
      });
      const flow = await engine.connect(process.id, gateway.id, task.id, flowLabel, {
        condition: conditionBody,
        conditionLanguage
      });
      await engine.updateElement(process.id, task.id, { name: updatedName });

      const parsedProcess = await moddle.fromXML(await engine.exportXml(process.id));
      expect(parsedProcess.warnings).toHaveLength(0);
      const processRoot = rootOfType(parsedProcess.rootElement, 'bpmn:Process');
      expect(processRoot.name).toBe(processName);
      expect(parsedProcess.elementsById[gateway.id].name).toBe(createdName);
      expect(parsedProcess.elementsById[task.id].name).toBe(updatedName);
      expect(parsedProcess.elementsById[flow.id].name).toBe(flowLabel);
      expect(parsedProcess.elementsById[flow.id].conditionExpression.body).toBe(conditionBody);
      expect(parsedProcess.elementsById[flow.id].conditionExpression.language).toBe(conditionLanguage);
      expect(processRoot.flowElements).toHaveLength(3);
      assertNoInjectedStructure(parsedProcess);

      const collaborationName = `Collaboration ${injection}`;
      const participantName = `Participant ${injection}`;
      const collaboration = await engine.createProcess(collaborationName, 'collaboration');
      const participant = await engine.createElement(collaboration.id, {
        type: 'bpmn:Participant',
        name: participantName
      });

      const parsedCollaboration = await moddle.fromXML(await engine.exportXml(collaboration.id));
      expect(parsedCollaboration.warnings).toHaveLength(0);
      const collaborationRoot = rootOfType(parsedCollaboration.rootElement, 'bpmn:Collaboration');
      expect(collaborationRoot.name).toBe(collaborationName);
      expect(parsedCollaboration.elementsById[participant.id].name).toBe(participantName);
      expect(collaborationRoot.participants).toHaveLength(1);
      assertNoInjectedStructure(parsedCollaboration);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('round-trips Mermaid names, pool titles, nodes, and flow labels without XML injection', async () => {
    const ast: MermaidAST = {
      type: 'flowchart',
      direction: 'LR',
      nodes: [
        { id: 'BuyerFirst', type: 'process', label: `Buyer first ${injection}` },
        { id: 'BuyerSecond', type: 'process', label: `Buyer second ${injection}` },
        { id: 'SellerFirst', type: 'process', label: `Seller first ${injection}` },
        { id: 'SellerSecond', type: 'process', label: `Seller second ${injection}` }
      ],
      edges: [
        {
          id: 'BuyerInternal', source: 'BuyerFirst', target: 'BuyerSecond',
          type: 'directed', label: `Buyer flow ${injection}`
        },
        {
          id: 'Message', source: 'BuyerSecond', target: 'SellerFirst',
          type: 'directed', label: `Message flow ${injection}`
        },
        {
          id: 'SellerInternal', source: 'SellerFirst', target: 'SellerSecond',
          type: 'directed', label: `Seller flow ${injection}`
        }
      ],
      subgraphs: [
        {
          id: 'Buyer',
          title: `Buyer pool ${injection}`,
          nodes: ['BuyerFirst', 'BuyerSecond']
        },
        {
          id: 'Seller',
          title: `Seller pool ${injection}`,
          nodes: ['SellerFirst', 'SellerSecond']
        }
      ]
    };
    const collaborationName = `Mermaid collaboration ${injection}`;

    const result = await new SimpleBpmnGenerator().generateBpmn(ast, collaborationName);
    const parsed = await moddle.fromXML(result.xml);
    expect(parsed.warnings).toHaveLength(0);
    const collaboration = rootOfType(parsed.rootElement, 'bpmn:Collaboration');
    const processes = parsed.rootElement.rootElements.filter(
      (root: any) => root.$type === 'bpmn:Process'
    );

    expect(collaboration.name).toBe(collaborationName);
    expect(collaboration.participants.map((participant: any) => participant.name)).toEqual([
      `Buyer pool ${injection}`,
      `Seller pool ${injection}`
    ]);
    expect(processes.map((process: any) => process.name)).toEqual([
      `Buyer pool ${injection}`,
      `Seller pool ${injection}`
    ]);
    expect([
      parsed.elementsById.Task_BuyerFirst.name,
      parsed.elementsById.Task_BuyerSecond.name,
      parsed.elementsById.Task_SellerFirst.name,
      parsed.elementsById.Task_SellerSecond.name
    ]).toEqual(ast.nodes.map(node => node.label));
    expect(processes.flatMap((process: any) => process.flowElements)
      .filter((element: any) => element.$type === 'bpmn:SequenceFlow')
      .map((flow: any) => flow.name)).toEqual([
      `Buyer flow ${injection}`,
      `Seller flow ${injection}`
    ]);
    expect(collaboration.messageFlows.map((flow: any) => flow.name)).toEqual([
      `Message flow ${injection}`
    ]);
    expect(processes.flatMap((process: any) => process.flowElements)).toHaveLength(6);
    expect(collaboration.messageFlows).toHaveLength(1);
    assertNoInjectedStructure(parsed);
  });
});
