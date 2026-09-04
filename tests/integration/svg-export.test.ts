import { BpmnRequestHandler } from '../../src/server/handlers.js';
import {
  ROOT_BROWSER_LAUNCH_ARGS,
  resolveBrowserLaunchArgs
} from '../../src/config/index.js';
import { BpmnSvgRenderer } from '../../src/core/BpmnSvgRenderer.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';
import { jest } from '@jest/globals';
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
    await handler.shutdown();
    await sandbox?.cleanup();
    sandbox = undefined;
  });

  afterAll(async () => {
    expect(await snapshotDefaultDiagramsDirectory()).toBe(defaultDiagramsSnapshot);
  });

  it('G2 exports a deterministic, self-contained SVG using the real renderer', async () => {
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
    expect(resource.text).toContain('id="bpmn-io-attribution"');
    expect(resource.text).toContain('href="https://bpmn.io"');
    expect(resource.text).toContain('aria-label="Powered by bpmn.io"');
    expect(resource.text).toContain(
      '<rect x="900" y="592" width="65" height="33" fill="#fff"/>'
    );
    expect(resource.text).not.toMatch(/<!DOCTYPE|<script\b|<image\b|<foreignObject\b/i);
    expect(resource.text.match(/\shref="[^"]+"/gi)).toEqual([' href="https://bpmn.io"']);
    expect(resource.text).not.toMatch(/\s(?:xlink:href|on[a-z]+)\s*=/i);
    expect(resource.text).not.toMatch(/url\(\s*['"]?(?:https?:|data:|file:|javascript:)/i);
  }, 25_000);

  it('queues overlapping SVG exports instead of failing the second one', async () => {
    // Two exports issued back to back is the ordinary agent pattern; the second
    // one used to come back as "SVG renderer concurrency limit reached".
    const concurrent = await Promise.all([
      handler.handleRequest('export', { format: 'svg' }),
      handler.handleRequest('export', { format: 'svg' })
    ]);

    expect(concurrent.filter(item => item.isError)).toHaveLength(0);
    for (const result of concurrent) {
      expect(result.content[0].type).toBe('resource');
    }
    expect(concurrent[1].content[0]).toEqual(concurrent[0].content[0]);
  }, 25_000);

  it('rejects a queued render once the wait list is full', async () => {
    const renderer = new BpmnSvgRenderer(20_000, 1, 0);
    const xml = '<invalid';

    const first = renderer.render(xml).catch(() => 'settled');
    await expect(renderer.render(xml)).rejects.toThrow(
      'SVG renderer queue limit of 0 pending renders exceeded'
    );
    await first;
    await renderer.close();
  }, 30_000);

  it('fails a queued render when the renderer closes while it waits', async () => {
    const renderer = new BpmnSvgRenderer(20_000, 1, 4);
    const xml = '<invalid';

    const first = renderer.render(xml).catch(() => 'settled');
    const queued = renderer.render(xml);
    const closing = renderer.close();

    await expect(queued).rejects.toThrow('SVG renderer is closed');
    await first;
    await closing;
  }, 30_000);

  it('reports PNG pixel geometry and honours the requested scale', async () => {
    const single = await handler.handleRequest('save_png', {
      filename: 'scale-one.png',
      overwrite: true,
      scale: 1
    });
    expect(single.isError).toBeUndefined();
    const singleContent = single.structuredContent as {
      width: number;
      height: number;
      scale: number;
      downscaled: boolean;
      byteLength: number;
    };
    expect(singleContent.scale).toBe(1);
    expect(singleContent.downscaled).toBe(false);
    expect(singleContent.width).toBeGreaterThan(0);
    expect(singleContent.height).toBeGreaterThan(0);

    const doubled = await handler.handleRequest('save_png', {
      filename: 'scale-two.png',
      overwrite: true,
      scale: 2
    });
    expect(doubled.isError).toBeUndefined();
    const doubledContent = doubled.structuredContent as {
      width: number;
      height: number;
      scale: number;
      downscaled: boolean;
      byteLength: number;
    };
    expect(doubledContent.scale).toBe(2);
    expect(doubledContent.width).toBe(singleContent.width * 2);
    expect(doubledContent.height).toBe(singleContent.height * 2);
    expect(doubledContent.byteLength).toBeGreaterThan(singleContent.byteLength);
  }, 40_000);

  it('reuses one browser without leaking render pages until shutdown', async () => {
    const launchBrowser = jest.spyOn(
      BpmnSvgRenderer.prototype as unknown as {
        launchBrowser(): Promise<import('puppeteer').Browser>;
      },
      'launchBrowser'
    );

    const first = await handler.handleRequest('export', { format: 'svg' });
    expect(first.isError).toBeUndefined();
    expect(launchBrowser).toHaveBeenCalledTimes(1);

    const browser = await launchBrowser.mock.results[0].value;
    const pageCount = (await browser.pages()).length;
    const second = await handler.handleRequest('export', { format: 'svg' });

    expect(second.isError).toBeUndefined();
    expect(launchBrowser).toHaveBeenCalledTimes(1);
    expect(await browser.pages()).toHaveLength(pageCount);
    expect(browser.connected).toBe(true);

    await handler.shutdown();
    expect(browser.connected).toBe(false);
  }, 15_000);
});

describe('Chrome launch arguments', () => {
  const originalGetuid = process.getuid;

  afterEach(() => {
    process.getuid = originalGetuid;
  });

  it('drops the Chrome sandbox when the server runs as root', () => {
    process.getuid = () => 0;

    // Chrome exits with "Running as root without --no-sandbox is not supported",
    // which is how every containerised agent runtime lost SVG and PNG output.
    expect(resolveBrowserLaunchArgs({}))
      .toEqual(['--no-sandbox', '--disable-setuid-sandbox']);
    expect(resolveBrowserLaunchArgs({})).toEqual([...ROOT_BROWSER_LAUNCH_ARGS]);
  });

  it('keeps the Chrome sandbox for an unprivileged user', () => {
    process.getuid = () => 1000;

    expect(resolveBrowserLaunchArgs({})).toEqual([]);
  });

  it('lets MCP_BPMN_BROWSER_ARGS replace the defaults entirely', () => {
    process.getuid = () => 0;

    expect(resolveBrowserLaunchArgs({
      MCP_BPMN_BROWSER_ARGS: '--no-sandbox   --disable-gpu'
    })).toEqual(['--no-sandbox', '--disable-gpu']);
    expect(resolveBrowserLaunchArgs({ MCP_BPMN_BROWSER_ARGS: '' })).toEqual([]);
  });
});
