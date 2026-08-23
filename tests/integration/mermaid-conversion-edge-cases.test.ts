import BpmnModdle from 'bpmn-moddle';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';
import type { BpmnRequestHandler } from '../../src/server/handlers.js';
import {
  createTempDiagramsSandbox,
  snapshotDefaultDiagramsDirectory,
  type TempHandlerSandbox
} from '../helpers/tempDiagrams.js';

const entryPoints = ['new_from_mermaid', 'open_mermaid_file'] as const;
type MermaidEntryPoint = typeof entryPoints[number];

interface FlowElement {
  $type: string;
  id: string;
  name?: string;
  sourceRef?: { id: string };
  targetRef?: { id: string };
}

async function prepareInvocation(
  handler: BpmnRequestHandler,
  sandbox: TempHandlerSandbox,
  entryPoint: MermaidEntryPoint,
  mermaidCode: string
): Promise<() => ReturnType<BpmnRequestHandler['handleRequest']>> {
  if (entryPoint === 'new_from_mermaid') {
    return () => handler.handleRequest(entryPoint, {
      name: 'Edge case conversion',
      mermaidCode
    });
  }

  const filename = sandbox.uniqueFilename('edge-case').replace(/\.bpmn$/, '.mmd');
  await writeFile(join(sandbox.directory, filename), mermaidCode, 'utf8');
  return () => handler.handleRequest(entryPoint, { filename });
}

async function snapshotFiles(directory: string): Promise<Record<string, string>> {
  const filenames = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(filenames.map(async filename => [
    filename,
    await readFile(join(directory, filename), 'utf8')
  ])));
}

async function parseActiveFlowElements(): Promise<FlowElement[]> {
  const parsed = await new BpmnModdle().fromXML(diagramContext.getCurrent().xml!);
  expect(parsed.warnings).toEqual([]);
  const process = parsed.rootElement.rootElements.find(
    (element: FlowElement) => element.$type === 'bpmn:Process'
  );
  if (!process) throw new Error('Expected converted BPMN process');
  return process.flowElements as FlowElement[];
}

describe('Mermaid conversion handler edge cases', () => {
  let handler: BpmnRequestHandler;
  let sandbox: TempHandlerSandbox | undefined;
  let defaultDiagramsSnapshot: string;

  beforeAll(async () => {
    defaultDiagramsSnapshot = await snapshotDefaultDiagramsDirectory();
  });

  beforeEach(async () => {
    IdGenerator.reset();
    diagramContext.clear();
    sandbox = await createTempDiagramsSandbox('mermaid-edge-cases');
    handler = sandbox.handler;
  });

  afterEach(async () => {
    diagramContext.clear();
    await sandbox?.cleanup();
    sandbox = undefined;
  });

  afterAll(async () => {
    expect(await snapshotDefaultDiagramsDirectory()).toBe(defaultDiagramsSnapshot);
  });

  it.each(entryPoints.flatMap(entryPoint => [
    [entryPoint, 'empty input', ''],
    [entryPoint, 'malformed syntax', 'flowchart TD\n  A[Unclosed label']
  ] as const))(
    '%s rejects %s without replacing the active context or changing files',
    async (entryPoint, _caseName, mermaidCode) => {
      await handler.handleRequest('new_bpmn', { name: 'Keep active' });
      const invoke = await prepareInvocation(handler, sandbox!, entryPoint, mermaidCode);
      const activeContext = diagramContext.getCurrent();
      const activeInfo = diagramContext.getCurrentInfo();
      const filesBefore = await snapshotFiles(sandbox!.directory);

      const result = await invoke();

      expect(result.isError).toBe(true);
      expect(diagramContext.getCurrent()).toBe(activeContext);
      expect(diagramContext.getCurrentInfo()).toEqual(activeInfo);
      await expect(snapshotFiles(sandbox!.directory)).resolves.toEqual(filesBefore);
    }
  );

  it.each(entryPoints)(
    '%s round-trips XML-sensitive and Unicode labels through BPMN moddle',
    async entryPoint => {
      const startName = 'Launch & "go" <now>';
      const taskName = 'Review <R&D> "Zürich"';
      const endName = 'Finish > later & done';
      const flowName = 'approved & "signed" <today>';
      const source = [
        'flowchart TD',
        `  S((${startName})) -->|${flowName}| T[${taskName}]`,
        `  T --> E((${endName}))`
      ].join('\n');
      const invoke = await prepareInvocation(handler, sandbox!, entryPoint, source);

      const result = await invoke();
      const flowElements = await parseActiveFlowElements();
      const byId = new Map(flowElements.map(element => [element.id, element]));
      const sequenceFlows = flowElements.filter(
        element => element.$type === 'bpmn:SequenceFlow'
      );

      expect(result.isError).toBeUndefined();
      expect(byId.get('StartEvent_S')?.name).toBe(startName);
      expect(byId.get('Task_T')?.name).toBe(taskName);
      expect(byId.get('EndEvent_E')?.name).toBe(endName);
      expect(sequenceFlows.map(flow => flow.name).filter(Boolean)).toEqual([flowName]);
    }
  );

  it.each(entryPoints)(
    '%s upgrades a prior implicit endpoint in conversion output and statistics',
    async entryPoint => {
      const source = [
        'flowchart TD',
        '  A --> E((End))',
        '  A[Actual label]:::highlighted'
      ].join('\n');
      const invoke = await prepareInvocation(handler, sandbox!, entryPoint, source);

      const result = await invoke();
      const xml = diagramContext.getCurrent().xml!;
      const flowElements = await parseActiveFlowElements();
      const byId = new Map(flowElements.map(element => [element.id, element]));

      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Elements: 2 nodes, 1 flows')
      });
      expect(byId.get('Task_A')).toMatchObject({
        $type: 'bpmn:Task',
        name: 'Actual label'
      });
      expect(flowElements.filter(element => element.id === 'Task_A')).toHaveLength(1);

      const moddle = new BpmnModdle();
      const parsed = await moddle.fromXML(xml);
      const roundTrippedXml = (await moddle.toXML(parsed.rootElement)).xml;
      const reparsed = await moddle.fromXML(roundTrippedXml);
      const process = reparsed.rootElement.rootElements.find(
        (element: FlowElement) => element.$type === 'bpmn:Process'
      );

      expect(parsed.warnings).toEqual([]);
      expect(reparsed.warnings).toEqual([]);
      expect(process.flowElements.filter(
        (element: FlowElement) => element.$type !== 'bpmn:SequenceFlow'
      ).map((element: FlowElement) => ({ id: element.id, type: element.$type, name: element.name })))
        .toEqual([
          { id: 'Task_A', type: 'bpmn:Task', name: 'Actual label' },
          { id: 'EndEvent_E', type: 'bpmn:EndEvent', name: undefined }
        ]);
    }
  );

  it.each(entryPoints)(
    '%s terminates on a cycle and preserves every node and flow',
    async entryPoint => {
      const source = [
        'flowchart LR',
        '  S((Start)) --> A[Review]',
        '  A --> B{Retry?}',
        '  B -->|retry| A',
        '  B --> E((End))'
      ].join('\n');
      const invoke = await prepareInvocation(handler, sandbox!, entryPoint, source);

      const result = await invoke();
      const flowElements = await parseActiveFlowElements();
      const nodes = flowElements.filter(element => element.$type !== 'bpmn:SequenceFlow');
      const sequenceFlows = flowElements.filter(
        element => element.$type === 'bpmn:SequenceFlow'
      );
      const endpoints = sequenceFlows.map(
        flow => `${flow.sourceRef?.id}->${flow.targetRef?.id}`
      ).sort();

      expect(result.isError).toBeUndefined();
      expect(nodes.map(node => node.id).sort()).toEqual([
        'EndEvent_E',
        'Gateway_B',
        'StartEvent_S',
        'Task_A'
      ]);
      expect(endpoints).toEqual([
        'Gateway_B->EndEvent_E',
        'Gateway_B->Task_A',
        'StartEvent_S->Task_A',
        'Task_A->Gateway_B'
      ]);
    },
    15_000
  );

  it.each(entryPoints)(
    '%s converts a 60-node graph within the documented integration ceiling',
    async entryPoint => {
      const nodeCount = 60;
      const sourceLines = ['flowchart LR'];
      for (let index = 0; index < nodeCount - 1; index++) {
        const sourceNode = index === 0 ? 'N0((Start))' : `N${index}`;
        const targetNode = index === nodeCount - 2
          ? `N${index + 1}((End))`
          : `N${index + 1}[Step ${index + 1}]`;
        sourceLines.push(`  ${sourceNode} --> ${targetNode}`);
      }
      const invoke = await prepareInvocation(
        handler,
        sandbox!,
        entryPoint,
        sourceLines.join('\n')
      );
      const startedAt = Date.now();

      const result = await invoke();
      const elapsedMs = Date.now() - startedAt;
      const flowElements = await parseActiveFlowElements();
      const nodes = flowElements.filter(element => element.$type !== 'bpmn:SequenceFlow');
      const sequenceFlows = flowElements.filter(
        element => element.$type === 'bpmn:SequenceFlow'
      );

      expect(result.isError).toBeUndefined();
      expect(nodes).toHaveLength(nodeCount);
      expect(sequenceFlows).toHaveLength(nodeCount - 1);
      // This is twice the production layout timeout: a broad regression bound,
      // not a microbenchmark of local layout speed.
      expect(elapsedMs).toBeLessThan(10_000);
    },
    25_000
  );
});
