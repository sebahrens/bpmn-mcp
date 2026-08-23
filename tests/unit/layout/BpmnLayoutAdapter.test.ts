import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MermaidConverter } from '../../../src/converters/MermaidConverter.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import {
  BpmnAutoLayoutV2Adapter,
  BPMN_AUTO_LAYOUT_VERSION,
  BpmnLayoutError,
  type BpmnLayoutAdapter,
  type BpmnLayoutResult
} from '../../../src/core/layout/BpmnLayoutAdapter.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';

describe('BpmnAutoLayoutV2Adapter', () => {
  it('normalizes the selected 2.0.0-alpha.2 result contract', async () => {
    const layoutProcess = jest.fn().mockResolvedValue({
      xml: '<definitions />',
      warnings: [{
        code: 'GROUP_MEMBERS_NOT_FOUND',
        elementId: 'Group_1',
        message: 'The group was omitted.',
        relatedElementIds: ['Task_1']
      }]
    });
    const adapter = new BpmnAutoLayoutV2Adapter(layoutProcess);

    await expect(adapter.layout('<source />')).resolves.toEqual({
      xml: '<definitions />',
      warnings: [{
        code: 'GROUP_MEMBERS_NOT_FOUND',
        elementId: 'Group_1',
        message: 'The group was omitted.',
        relatedElementIds: ['Task_1']
      }]
    });
    expect(layoutProcess).toHaveBeenCalledTimes(1);
    expect(layoutProcess).toHaveBeenCalledWith('<source />');
  });

  it('matches the exact production dependency pin', async () => {
    const packageMetadata = JSON.parse(
      await fs.readFile(join(process.cwd(), 'package.json'), 'utf8')
    );

    expect(packageMetadata.dependencies['bpmn-auto-layout']).toBe(BPMN_AUTO_LAYOUT_VERSION);
  });

  it('uses nullish fallbacks for subprocess error diagnostics', async () => {
    const adapterSource = await fs.readFile(
      join(process.cwd(), 'src/core/layout/BpmnLayoutAdapter.ts'),
      'utf8'
    );

    expect(adapterSource).toContain("code: error?.code ?? 'LAYOUT_FAILED'");
    expect(adapterSource).toContain('message: error?.message ?? String(error)');
  });

  it('surfaces structured unsupported-feature failures without leaking package classes', async () => {
    const packageError = Object.assign(new Error('Unsupported collaboration'), {
      name: 'LayoutError',
      code: 'UNSUPPORTED_COLLABORATION',
      elementId: 'Collaboration_1',
      relatedElementIds: ['Participant_1']
    });
    const adapter = new BpmnAutoLayoutV2Adapter(jest.fn().mockRejectedValue(packageError));

    await expect(adapter.layout('<source />')).rejects.toMatchObject({
      name: 'BpmnLayoutError',
      code: 'UNSUPPORTED_COLLABORATION',
      elementId: 'Collaboration_1',
      relatedElementIds: ['Participant_1'],
      cause: packageError
    });
  });

  it('rejects a result that does not match the pinned package contract', async () => {
    const adapter = new BpmnAutoLayoutV2Adapter(jest.fn().mockResolvedValue('<definitions />'));

    await expect(adapter.layout('<source />')).rejects.toEqual(expect.objectContaining({
      name: 'BpmnLayoutError',
      code: 'INVALID_ADAPTER_RESULT'
    }));
  });
});

describe('shared external layout pipeline', () => {
  const diagram = 'flowchart LR\n  A((Start)) --> B[Review] --> C((End))';

  it('lays Mermaid-generated BPMN exactly once and surfaces adapter warnings', async () => {
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn(async (xml: string): Promise<BpmnLayoutResult> => ({
        xml: xml.replace(
          '<dc:Bounds x="100" y="100" width="36" height="36" />',
          '<dc:Bounds x="900" y="700" width="36" height="36" />'
        ),
        warnings: [{ code: 'TEST_WARNING', message: 'Layout completed with a warning' }]
      }))
    };

    const result = await new MermaidConverter(adapter).convert(diagram);

    expect(adapter.layout).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain('TEST_WARNING: Layout completed with a warning');
    expect(result.elements.find(element => element.id === 'StartEvent_A')).toMatchObject({
      x: 900,
      y: 700
    });
  });

  it('honors autoLayout:false without invoking the adapter', async () => {
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn(async (xml: string): Promise<BpmnLayoutResult> => ({ xml, warnings: [] }))
    };

    const result = await new MermaidConverter(adapter).convert(diagram, { autoLayout: false });

    expect(adapter.layout).not.toHaveBeenCalled();
    expect(result.xml).toContain('bpmndi:BPMNDiagram');
  });

  it('keeps engine memory and the active file unchanged when layout fails', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-adapter-rollback-'));
    const failure = new BpmnLayoutError({
      code: 'UNSUPPORTED_ELEMENT',
      message: 'Unsupported element',
      elementId: 'Task_Unsupported'
    });
    const adapter: BpmnLayoutAdapter = {
      layout: jest.fn().mockRejectedValue(failure)
    };
    try {
      const engine = new SimpleBpmnEngine(directory, undefined, adapter);
      const context = await engine.createProcess('Atomic layout');
      await engine.createElement(context.id, {
        id: 'Task_Unsupported',
        type: 'bpmn:Task',
        name: 'Before layout'
      });
      const beforeXml = context.xml;
      const beforePosition = { ...context.elements.get('Task_Unsupported')!.position };

      await expect(engine.applyAutoLayout(context.id)).rejects.toBe(failure);

      expect(context.xml).toBe(beforeXml);
      expect(context.elements.get('Task_Unsupported')!.position).toEqual(beforePosition);
      await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeXml);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('surfaces Mermaid and manual-layout warnings through MCP responses', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-adapter-warnings-'));
    const engineAdapter: BpmnLayoutAdapter = {
      layout: jest.fn(async (xml: string): Promise<BpmnLayoutResult> => ({
        xml,
        warnings: [{ code: 'MANUAL_WARNING', message: 'Manual layout warning' }]
      }))
    };
    const mermaidAdapter: BpmnLayoutAdapter = {
      layout: jest.fn(async (xml: string): Promise<BpmnLayoutResult> => ({
        xml,
        warnings: [{ code: 'MERMAID_WARNING', message: 'Mermaid layout warning' }]
      }))
    };
    try {
      const engine = new SimpleBpmnEngine(directory, undefined, engineAdapter);
      const handler = new BpmnRequestHandler(engine, new MermaidConverter(mermaidAdapter));

      const created = await handler.handleRequest('new_from_mermaid', {
        name: 'Warning visibility',
        mermaidCode: diagram
      });
      expect(created.content[0].text).toContain(
        'Warnings:\nMERMAID_WARNING: Mermaid layout warning'
      );

      const laidOut = await handler.handleRequest('auto_layout', {});
      expect(laidOut.content[0].text).toContain(
        'Warnings:\nMANUAL_WARNING: Manual layout warning'
      );
    } finally {
      diagramContext.clear();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
