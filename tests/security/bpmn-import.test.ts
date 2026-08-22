import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BpmnImportLimits } from '../../src/config/index.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';

const generousLimits: BpmnImportLimits = {
  maxBytes: 16 * 1024,
  maxElements: 20,
  maxFlows: 20,
  maxDiElements: 20
};

function resultText(result: CallToolResult): string {
  const item = result.content[0];
  if (!item || item.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return item.text;
}

function processXml(options: {
  id: string;
  elements?: number;
  flows?: number;
  diElements?: number;
  secret?: string;
}): string {
  const elementCount = options.elements ?? 0;
  const flowCount = options.flows ?? 0;
  const diElementCount = options.diElements ?? 0;
  const tasks = Array.from({ length: Math.max(elementCount, flowCount > 0 ? 2 : 0) }, (_, index) =>
    `    <bpmn:task id="Task_${index + 1}" />`
  ).join('\n');
  const flows = Array.from({ length: flowCount }, (_, index) =>
    `    <bpmn:sequenceFlow id="Flow_${index + 1}" sourceRef="Task_1" targetRef="Task_2" />`
  ).join('\n');
  const shapes = Array.from({ length: diElementCount }, (_, index) => `
      <bpmndi:BPMNShape id="Shape_${index + 1}" bpmnElement="Task_${(index % Math.max(elementCount, 1)) + 1}">
        <dc:Bounds x="${100 + index * 120}" y="100" width="100" height="80" />
      </bpmndi:BPMNShape>`).join('');
  const diagram = diElementCount > 0 ? `
  <bpmndi:BPMNDiagram id="Diagram_${options.id}">
    <bpmndi:BPMNPlane id="Plane_${options.id}" bpmnElement="${options.id}">${shapes}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  id="Definitions_${options.id}" targetNamespace="http://mcp-bpmn.test/import">
  <bpmn:process id="${options.id}" name="${options.secret || 'Valid process'}">
${tasks}${tasks && flows ? '\n' : ''}${flows}
  </bpmn:process>${diagram}
</bpmn:definitions>`;
}

function collaborationXml(id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_${id}" targetNamespace="http://mcp-bpmn.test/import">
  <bpmn:process id="Process_${id}" />
  <bpmn:collaboration id="${id}" name="Valid collaboration">
    <bpmn:participant id="Participant_${id}" processRef="Process_${id}" />
  </bpmn:collaboration>
</bpmn:definitions>`;
}

function padToByteLength(xml: string, byteLength: number): string {
  const closingTag = '</bpmn:definitions>';
  const insertionPoint = xml.lastIndexOf(closingTag);
  const missingBytes = byteLength - Buffer.byteLength(xml, 'utf8');
  if (insertionPoint < 0 || missingBytes < 7) {
    throw new Error('Fixture cannot be padded to requested byte length');
  }
  const comment = `<!--${'x'.repeat(missingBytes - 7)}-->`;
  return `${xml.slice(0, insertionPoint)}${comment}${xml.slice(insertionPoint)}`;
}

async function directorySnapshot(directory: string): Promise<Record<string, string>> {
  const filenames = (await fs.readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(filenames.map(async filename => [
    filename,
    await fs.readFile(join(directory, filename), 'utf8')
  ])));
}

describe('bounded BPMN imports', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-import-security-'));
    diagramContext.clear();
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('accepts a file at the exact byte limit and rejects one byte over atomically', async () => {
    const maxBytes = 1024;
    const limits = { ...generousLimits, maxBytes };
    const engine = new SimpleBpmnEngine(directory, limits);
    const exactXml = padToByteLength(processXml({ id: 'Process_Exact' }), maxBytes);
    expect(Buffer.byteLength(exactXml, 'utf8')).toBe(maxBytes);
    await fs.writeFile(join(directory, 'exact.bpmn'), exactXml, 'utf8');

    const imported = await engine.loadDiagram('exact.bpmn');
    expect(imported.id).toBe('Process_Exact');

    const stable = await engine.createProcess('Stable state');
    const overXml = `${exactXml}\n`;
    await fs.writeFile(join(directory, 'over.bpmn'), overXml, 'utf8');
    const beforeFiles = await directorySnapshot(directory);

    await expect(engine.loadDiagram('over.bpmn')).rejects.toThrow('byte limit');
    expect(engine.getProcess(stable.id)).toBe(stable);
    expect(await directorySnapshot(directory)).toEqual(beforeFiles);
  });

  it('accepts exact element, flow, and DI limits', async () => {
    const engine = new SimpleBpmnEngine(directory, {
      ...generousLimits,
      maxElements: 3,
      maxFlows: 1,
      maxDiElements: 3
    });

    const context = await engine.importXml(processXml({
      id: 'Process_ExactComplexity',
      elements: 2,
      flows: 1,
      diElements: 1
    }));
    expect(context.elements.size).toBe(2);
    expect(context.connections.size).toBe(1);
  });

  it.each([
    ['element', { elements: 3, flows: 0, diElements: 0 }],
    ['flow', { elements: 2, flows: 2, diElements: 0 }],
    ['DI element', { elements: 2, flows: 0, diElements: 2 }]
  ])('rejects one-over the configured %s limit before files or state change', async (
    expectedLimit,
    counts
  ) => {
    const secret = `DO_NOT_ECHO_${expectedLimit.replace(/\s/g, '_')}`;
    const engine = new SimpleBpmnEngine(directory, {
      ...generousLimits,
      maxElements: 3,
      maxFlows: 1,
      maxDiElements: 3
    });
    const stable = await engine.createProcess('Stable complexity state');
    const beforeFiles = await directorySnapshot(directory);
    const rejectedId = `Rejected_${expectedLimit.replace(/\s/g, '_')}`;

    let rejection: Error | undefined;
    try {
      await engine.importXml(processXml({
        id: rejectedId,
        ...counts,
        secret
      }));
    } catch (error) {
      rejection = error as Error;
    }

    expect(rejection?.message).toContain(`configured ${expectedLimit} limit`);
    expect(rejection?.message).not.toContain(secret);
    expect(rejection?.message).not.toContain(directory);
    expect(engine.getProcess(stable.id)).toBe(stable);
    expect(() => engine.getProcess(rejectedId)).toThrow('not found');
    expect(await directorySnapshot(directory)).toEqual(beforeFiles);
  });

  it.each([
    [
      'malformed XML',
      'malformed.bpmn',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><secret>DO_NOT_ECHO_MALFORMED</bpmn:definitions>',
      'DO_NOT_ECHO_MALFORMED'
    ],
    [
      'a non-BPMN root',
      'wrong-root.bpmn',
      '<notBpmn xmlns="urn:not-bpmn">DO_NOT_ECHO_WRONG_ROOT</notBpmn>',
      'DO_NOT_ECHO_WRONG_ROOT'
    ],
    [
      'an unsupported root',
      'unsupported-root.bpmn',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:message id="DO_NOT_ECHO_UNSUPPORTED" /></bpmn:definitions>',
      'DO_NOT_ECHO_UNSUPPORTED'
    ],
    [
      'missing process and collaboration roots',
      'missing-root.bpmn',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="DO_NOT_ECHO_MISSING" />',
      'DO_NOT_ECHO_MISSING'
    ],
    [
      'unresolved references',
      'unresolved.bpmn',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="Rejected"><bpmn:sequenceFlow id="Flow" sourceRef="DO_NOT_ECHO_SOURCE" targetRef="DO_NOT_ECHO_TARGET" /></bpmn:process></bpmn:definitions>',
      'DO_NOT_ECHO_SOURCE'
    ],
    [
      'missing required IDs',
      'missing-id.bpmn',
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="Rejected"><bpmn:task name="DO_NOT_ECHO_MISSING_ID" /></bpmn:process></bpmn:definitions>',
      'DO_NOT_ECHO_MISSING_ID'
    ]
  ])('rejects %s through open_bpmn without changing current state or files', async (
    _caseName,
    filename,
    xml,
    secret
  ) => {
    const engine = new SimpleBpmnEngine(directory, generousLimits);
    const handler = new BpmnRequestHandler(engine);
    const created = await handler.handleRequest('new_bpmn', { name: 'Stable diagram' });
    expect(created.isError).toBeUndefined();
    const stable = diagramContext.getCurrent();
    await fs.writeFile(join(directory, filename), xml, 'utf8');
    const beforeFiles = await directorySnapshot(directory);

    const result = await handler.handleRequest('open_bpmn', { filename });
    const diagnostic = resultText(result);

    expect(result.isError).toBe(true);
    expect(diagramContext.getCurrent()).toBe(stable);
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(directory);
    expect(await directorySnapshot(directory)).toEqual(beforeFiles);
  });

  it.each([
    ['process', 'valid-process.bpmn', processXml({ id: 'Process_Valid', elements: 2, flows: 1 })],
    ['collaboration', 'valid-collaboration.bpmn', collaborationXml('Collaboration_Valid')]
  ])('opens and re-exports a valid %s import', async (expectedType, filename, xml) => {
    const engine = new SimpleBpmnEngine(directory, generousLimits);
    const handler = new BpmnRequestHandler(engine);
    const moddle = new BpmnModdle();
    await fs.writeFile(join(directory, filename), xml, 'utf8');

    const result = await handler.handleRequest('open_bpmn', { filename });
    expect(result.isError).toBeUndefined();
    const current = diagramContext.getCurrent();
    expect(current.type).toBe(expectedType);

    const reparsed = await moddle.fromXML(await engine.exportXml(current.id));
    expect(reparsed.warnings).toHaveLength(0);
    expect(reparsed.rootElement.$type).toBe('bpmn:Definitions');
  });
});
