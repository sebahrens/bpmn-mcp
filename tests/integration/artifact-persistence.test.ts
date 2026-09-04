import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceLimits } from '../../src/config/index.js';
import { DEFAULT_RESOURCE_LIMITS } from '../../src/config/index.js';
import {
  BpmnSvgRenderer,
  type PngRenderResult
} from '../../src/core/BpmnSvgRenderer.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

function textOf(result: Awaited<ReturnType<BpmnRequestHandler['handleRequest']>>): string {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('Expected text result');
  return content.text;
}

/** A PNG render stub carrying the pixel geometry save_png now reports. */
function pngResult(image: Buffer): PngRenderResult {
  return { image, width: 1, height: 1, scale: 1, downscaled: false };
}

describe('managed rendered artifact persistence', () => {
  let directory: string;
  let handler: BpmnRequestHandler;
  let renderSvg: jest.Mock<Promise<string>, [string]>;
  let renderPng: jest.Mock<Promise<PngRenderResult>, [string, (number | undefined)?]>;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-artifacts-'));
    IdGenerator.reset();
    diagramContext.clear();
    renderSvg = jest.fn(async () => '<svg width="1" height="1" viewBox="0 0 1 1"/>');
    renderPng = jest.fn(async () => pngResult(Buffer.from('89504e470d0a1a0a', 'hex')));
    const renderer = {
      render: renderSvg,
      renderPng,
      close: jest.fn(async () => undefined)
    } as unknown as BpmnSvgRenderer;
    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      maxArtifactBytes: 1_024
    } as ResourceLimits;
    handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(directory, undefined, undefined, limits),
      undefined,
      limits,
      renderer
    );
    await handler.handleRequest('new_bpmn', { name: 'Artifact source' });
  });

  afterEach(async () => {
    await handler.shutdown();
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('saves independently rendered SVG and PNG files without changing diagram state', async () => {
    const context = diagramContext.getCurrent();
    const before = {
      filename: context.filename,
      xml: context.xml,
      revision: context.revision
    };

    const svg = await handler.handleRequest('save_svg', { filename: 'review.svg' });
    const png = await handler.handleRequest('save_png', { filename: 'review.png' });

    expect(svg.isError).toBeUndefined();
    expect(svg.structuredContent).toEqual({
      processId: context.id,
      filename: 'review.svg',
      format: 'svg',
      mimeType: 'image/svg+xml',
      byteLength: Buffer.byteLength(await renderSvg.mock.results[0].value)
    });
    expect(png.isError).toBeUndefined();
    expect(png.structuredContent).toEqual({
      processId: context.id,
      filename: 'review.png',
      format: 'png',
      mimeType: 'image/png',
      byteLength: 8,
      width: 1,
      height: 1,
      scale: 1,
      downscaled: false
    });
    await expect(fs.readFile(join(directory, 'review.svg'), 'utf8'))
      .resolves.toBe(await renderSvg.mock.results[0].value);
    await expect(fs.readFile(join(directory, 'review.png')))
      .resolves.toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(context).toMatchObject(before);

    const listing = await handler.handleRequest('list_diagrams', {});
    expect(JSON.parse(textOf(listing)).diagrams).toHaveLength(1);
    expect(JSON.parse(textOf(listing)).diagrams[0].filename).toBe(before.filename);
  });

  it('preserves an artifact unless overwrite is explicit, then replaces it atomically', async () => {
    await handler.handleRequest('save_svg', { filename: 'stable.svg' });
    const first = await fs.readFile(join(directory, 'stable.svg'), 'utf8');
    renderSvg.mockResolvedValue('<svg width="2" height="2" viewBox="0 0 2 2"/>');

    const rejected = await handler.handleRequest('save_svg', { filename: 'stable.svg' });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('File already exists: stable.svg');
    await expect(fs.readFile(join(directory, 'stable.svg'), 'utf8')).resolves.toBe(first);

    const replaced = await handler.handleRequest('save_svg', {
      filename: 'stable.svg',
      overwrite: true
    });
    expect(replaced.isError).toBeUndefined();
    await expect(fs.readFile(join(directory, 'stable.svg'), 'utf8'))
      .resolves.toContain('width="2"');
  });

  it.each([
    ['save_svg', '../outside.svg'],
    ['save_svg', 'wrong.png'],
    ['save_png', '..\\outside.png'],
    ['save_png', 'wrong.svg']
  ])('rejects unsafe %s filename %p before rendering', async (tool, filename) => {
    const result = await handler.handleRequest(tool, { filename });

    expect(result.isError).toBe(true);
    expect(renderSvg).not.toHaveBeenCalled();
    expect(renderPng).not.toHaveBeenCalled();
  });

  it('rejects rendered output over the configured byte limit without writing it', async () => {
    renderSvg.mockResolvedValue('x'.repeat(1_025));
    renderPng.mockResolvedValue(pngResult(Buffer.alloc(1_025)));

    const svg = await handler.handleRequest('save_svg', { filename: 'large.svg' });
    const png = await handler.handleRequest('save_png', { filename: 'large.png' });

    expect(svg.isError).toBe(true);
    expect(png.isError).toBe(true);
    expect(textOf(svg)).toContain('Rendered artifact exceeds the configured byte limit');
    expect(textOf(png)).toContain('Rendered artifact exceeds the configured byte limit');
    await expect(fs.access(join(directory, 'large.svg'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(join(directory, 'large.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
