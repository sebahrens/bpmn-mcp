import { BpmnRequestHandler } from '../../src/server/handlers.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTempDiagramsDirectory,
  snapshotDefaultDiagramsDirectory,
  type TempDiagramsSandbox
} from '../helpers/tempDiagrams.js';

describe('SVG export integration', () => {
  let handler: BpmnRequestHandler;
  let sandbox: TempDiagramsSandbox | undefined;
  let defaultDiagramsSnapshot: string;

  beforeAll(async () => {
    defaultDiagramsSnapshot = await snapshotDefaultDiagramsDirectory();
  });

  beforeEach(async () => {
    IdGenerator.reset();
    diagramContext.clear();
    sandbox = await createTempDiagramsDirectory('svg-export');
    handler = new BpmnRequestHandler(new SimpleBpmnEngine(sandbox.directory));
    await handler.handleRequest('new_bpmn', { name: 'SVG Export Test' });
    await handler.handleRequest('add_event', { eventType: 'start', name: 'Start' });
    await handler.handleRequest('add_activity', { activityType: 'task', name: 'Do Work' });
    await handler.handleRequest('connect', {
      sourceId: 'StartEvent_1',
      targetId: 'Task_1'
    });
  });

  afterEach(async () => {
    diagramContext.clear();
    await sandbox?.cleanup();
    sandbox = undefined;
  });

  afterAll(async () => {
    expect(await snapshotDefaultDiagramsDirectory()).toBe(defaultDiagramsSnapshot);
  });

  it('should export a deterministic, self-contained SVG using the real renderer', async () => {
    const fixture = await readFile(
      join(process.cwd(), 'tests/fixtures/import-roundtrip/full-semantics-di.bpmn'),
      'utf8'
    );
    const untrustedLabel = '&lt;script&gt;globalThis.pwned=true&lt;/script&gt; '
      + '&lt;image href=&quot;https://attacker.invalid/tracker&quot;/&gt;';
    const withBoundaryEvent = fixture
      .replace('name="Review request"', `name="${untrustedLabel}"`)
      .replace(
        '    <bpmn:exclusiveGateway id="Gateway_Decision"',
        `    <bpmn:boundaryEvent id="Boundary_Timer" name="Timeout" attachedToRef="Task_Unrelated">
      <bpmn:timerEventDefinition id="Boundary_Timer_Definition">
        <bpmn:timeDuration>PT5M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:exclusiveGateway id="Gateway_Decision"`
      )
      .replace(
        '      <bpmndi:BPMNShape id="Gateway_Decision_CustomDI"',
        `      <bpmndi:BPMNShape id="Boundary_Timer_CustomDI" bpmnElement="Boundary_Timer">
        <dc:Bounds x="250" y="230" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_Decision_CustomDI"`
      );
    const filename = sandbox!.uniqueFilename('svg-export');
    await writeFile(join(sandbox!.directory, filename), withBoundaryEvent, 'utf8');
    const opened = await handler.handleRequest('open_bpmn', { filename });
    expect(opened.isError).toBeUndefined();

    const result = await handler.handleRequest('export', { format: 'svg' });
    const repeated = await handler.handleRequest('export', { format: 'svg' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('resource');
    expect(repeated.content[0]).toEqual(result.content[0]);
    if (result.content[0].type !== 'resource'
      || !('text' in result.content[0].resource)) {
      throw new Error('Expected text-backed SVG resource content');
    }

    const { resource } = result.content[0];
    expect(resource.mimeType).toBe('image/svg+xml');
    expect(resource.uri).toMatch(/^bpmn:\/\/diagram\/.+\.svg$/);
    expect(resource.text).toMatch(
      /^<svg[^>]+width="930" height="590"[^>]+viewBox="35 35 930 590"/
    );
    expect(resource.text).toContain('data-element-id="Participant_Internal"');
    expect(resource.text).toContain('data-element-id="Lane_Reviewer"');
    expect(resource.text).toContain('data-element-id="Boundary_Timer"');
    expect(resource.text).toContain('data-element-id="MessageFlow_Notice"');
    expect(resource.text).toContain('Reviewer lane');
    expect(resource.text).toContain('bpmn-marker-1');
    expect(resource.text).toContain('marker-end: url');
    expect(resource.text).not.toMatch(/bpmn-marker-\d+: url/);
    expect(resource.text).toContain('&lt;script&gt;globalThi');
    expect(resource.text).not.toMatch(/<!DOCTYPE|<script\b|<image\b|<foreignObject\b/i);
    expect(resource.text).not.toMatch(/\s(?:href|xlink:href|on[a-z]+)\s*=/i);
    expect(resource.text).not.toMatch(/url\(\s*['"]?(?:https?:|data:|file:|javascript:)/i);
  }, 25_000);

  it('should reject overlapping SVG exports at the renderer boundary', async () => {
    const concurrent = await Promise.all([
      handler.handleRequest('export', { format: 'svg' }),
      handler.handleRequest('export', { format: 'svg' })
    ]);

    expect(concurrent.filter(item => item.isError)).toHaveLength(1);
    expect(concurrent.find(item => item.isError)?.content[0]).toMatchObject({
      type: 'text',
      text: 'Error: SVG renderer concurrency limit reached'
    });
    expect(concurrent.find(item => !item.isError)?.content[0].type).toBe('resource');
  }, 15_000);
});
