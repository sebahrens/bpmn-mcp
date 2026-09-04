import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';
import {
  BROWSER_ARGS_ENVIRONMENT_VARIABLE,
  MAX_PNG_SCALE,
  resolveBrowserLaunchArgs
} from '../config/index.js';

const moduleAnchor = process.argv[1] && existsSync(process.argv[1])
  ? realpathSync(process.argv[1])
  : resolve(process.cwd(), 'package.json');
const requireFromHere = createRequire(moduleAnchor);

const VIEWER_BUNDLE_PATH = requireFromHere.resolve(
  'bpmn-js/dist/bpmn-navigated-viewer.production.min.js'
);

const SYSTEM_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

// A cold browser launch can exceed ten seconds on contended hosts even though
// subsequent renders are fast. Keep the operation bounded while allowing the
// first SVG export to finish on supported CI and installed environments.
const DEFAULT_RENDER_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CONCURRENT_RENDERS = 1;
// Renders past the concurrency limit wait their turn rather than failing, but
// the wait list itself is bounded so a runaway caller cannot pin memory.
const DEFAULT_MAX_QUEUED_RENDERS = 32;
const MAX_PNG_DIMENSION = 4_096;
const MAX_PNG_PIXELS = 16_000_000;
/** What a PNG render produced, including any downscale the limits forced. */
export interface PngRenderResult {
  image: Buffer;
  /** Pixel width of the returned image. */
  width: number;
  /** Pixel height of the returned image. */
  height: number;
  /** Effective scale applied to the SVG's own dimensions. */
  scale: number;
  /** True when the requested scale was reduced to stay inside the pixel caps. */
  downscaled: boolean;
}

const RENDERER_DOCUMENT = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
  </head>
  <body><div id="canvas"></div></body>
</html>`;

/**
 * Render BPMN XML through the real bpmn-js viewer in an isolated browser page.
 * The page cannot make network requests and only a conservative SVG subset is
 * allowed back across the browser boundary.
 */
export class BpmnSvgRenderer {
  private activeRenders = 0;
  private readonly renderQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly browsers = new Set<Browser>();
  private browser: Browser | undefined;
  private browserLaunch: Promise<Browser> | undefined;
  private closed = false;

  constructor(
    private readonly renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
    private readonly maxConcurrentRenders = DEFAULT_MAX_CONCURRENT_RENDERS,
    private readonly maxQueuedRenders = DEFAULT_MAX_QUEUED_RENDERS
  ) {
    if (!Number.isSafeInteger(renderTimeoutMs) || renderTimeoutMs <= 0
      || !Number.isSafeInteger(maxConcurrentRenders) || maxConcurrentRenders <= 0
      || !Number.isSafeInteger(maxQueuedRenders) || maxQueuedRenders < 0) {
      throw new Error('Invalid SVG renderer limits');
    }
  }

  async render(xml: string): Promise<string> {
    return this.runRender(browser => this.renderWithBrowser(
      browser,
      () => this.renderPage(browser, xml)
    ));
  }

  async renderPng(xml: string, scale = 1): Promise<PngRenderResult> {
    const requestedScale = normalizePngScale(scale);
    return this.runRender(browser => this.renderWithBrowser(browser, async () => {
      const svg = await this.renderPage(browser, xml);
      return this.rasterizeSvg(browser, svg, requestedScale);
    }));
  }

  private async runRender<T>(operation: (browser: Browser) => Promise<T>): Promise<T> {
    await this.acquireRenderSlot();

    try {
      const browser = await this.getBrowser();
      return await operation(browser);
    } finally {
      this.releaseRenderSlot();
    }
  }

  /**
   * Take one render slot, waiting in FIFO order when every slot is busy. An
   * overlapping export queues instead of failing, which is what an agent
   * issuing two exports back to back expects; only a wait list longer than
   * `maxQueuedRenders` is rejected outright.
   */
  private async acquireRenderSlot(): Promise<void> {
    if (this.closed) {
      throw new Error('SVG renderer is closed');
    }
    if (this.activeRenders < this.maxConcurrentRenders) {
      this.activeRenders += 1;
      return;
    }
    if (this.renderQueue.length >= this.maxQueuedRenders) {
      throw new Error(
        `SVG renderer queue limit of ${this.maxQueuedRenders} pending renders exceeded`
      );
    }

    await new Promise<void>((resolve, reject) => {
      this.renderQueue.push({ resolve, reject });
    });
    if (this.closed) {
      this.releaseRenderSlot();
      throw new Error('SVG renderer is closed');
    }
  }

  /** Hand the slot to the next waiter, or give it back to the pool. */
  private releaseRenderSlot(): void {
    const waiter = this.renderQueue.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.activeRenders -= 1;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.renderQueue.splice(0)) {
      waiter.reject(new Error('SVG renderer is closed'));
    }
    const browser = this.browser;
    const browserLaunch = this.browserLaunch;

    await Promise.all([
      ...Array.from(this.browsers, launched => launched.close().catch(() => undefined)),
      browserLaunch?.then(launched => (
        launched === browser || this.browsers.has(launched)
          ? undefined
          : launched.close().catch(() => undefined)
      )).catch(() => undefined)
    ]);

    this.browsers.clear();
    this.browser = undefined;
    this.browserLaunch = undefined;
  }

  private async renderWithBrowser<T>(browser: Browser, operation: () => Promise<T>): Promise<T> {
    let renderTimeout: NodeJS.Timeout | undefined;
    let browserClose: Promise<void> | undefined;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        renderTimeout = setTimeout(() => {
          reject(new Error(`SVG rendering exceeded ${this.renderTimeoutMs}ms`));
          this.invalidateBrowser(browser);
          browserClose = browser.close().catch(() => undefined);
        }, this.renderTimeoutMs);
      });

      return await Promise.race([operation(), timeout]);
    } finally {
      if (renderTimeout) clearTimeout(renderTimeout);
      await browserClose;
    }
  }

  private async renderPage(browser: Browser, xml: string): Promise<string> {
    const page = await browser.newPage();

    try {
      let blockedExternalRequest = false;

      await page.setRequestInterception(true);
      page.on('request', request => {
        blockedExternalRequest = true;
        void request.abort('blockedbyclient').catch(() => undefined);
      });

      await page.setContent(RENDERER_DOCUMENT);
      await page.addScriptTag({ path: VIEWER_BUNDLE_PATH });

      const renderedSvg = await page.evaluate(async diagramXml => {
        type BrowserAttribute = { name: string; value: string };
        type BrowserElement = {
          localName: string;
          namespaceURI: string | null;
          attributes: ArrayLike<BrowserAttribute>;
          outerHTML: string;
          appendChild(child: BrowserElement): BrowserElement;
          cloneNode(deep: boolean): BrowserElement;
          getAttribute(name: string): string | null;
          querySelector(selector: string): BrowserElement | null;
          querySelectorAll(selector: string): ArrayLike<BrowserElement>;
          setAttribute(name: string, value: string): void;
        };
        type BrowserDocument = {
          documentElement: BrowserElement;
          createElementNS(namespace: string, qualifiedName: string): BrowserElement;
          querySelector(selector: string): BrowserElement | null;
        };
        type BrowserDomParser = new () => {
          parseFromString(value: string, mimeType: string): BrowserDocument;
        };
        type Viewer = {
          importXML(xml: string): Promise<unknown>;
          saveSVG(): Promise<{ svg: string }>;
          destroy(): void;
        };
        type ViewerConstructor = new (options: { container: string }) => Viewer;

        const Viewer = (globalThis as unknown as { BpmnJS: ViewerConstructor }).BpmnJS;
        if (typeof Viewer !== 'function') {
          throw new Error('bpmn-js viewer bundle did not initialize');
        }

        const viewer = new Viewer({ container: '#canvas' });
        try {
          await viewer.importXML(diagramXml);
          const { svg } = await viewer.saveSVG();
          const DomParser = (globalThis as unknown as { DOMParser: BrowserDomParser }).DOMParser;
          const parsed = new DomParser().parseFromString(svg, 'image/svg+xml');
          const parserError = parsed.querySelector('parsererror');
          if (parserError) throw new Error('bpmn-js returned malformed SVG');

          const root = parsed.documentElement;
          if (root.localName.toLowerCase() !== 'svg'
            || root.namespaceURI !== 'http://www.w3.org/2000/svg') {
            throw new Error('bpmn-js returned an invalid SVG root');
          }

          const allowedTags = new Set([
            'circle', 'defs', 'ellipse', 'g', 'line', 'marker', 'path',
            'polygon', 'polyline', 'rect', 'svg', 'text', 'tspan'
          ]);
          for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
            if (!allowedTags.has(element.localName.toLowerCase())) {
              throw new Error(`Unsafe SVG element: ${element.localName}`);
            }

            for (const attribute of Array.from(element.attributes)) {
              const name = attribute.name.toLowerCase();
              if (name.startsWith('on') || name === 'href' || name === 'xlink:href') {
                throw new Error(`Unsafe SVG attribute: ${attribute.name}`);
              }
              if (name === 'style') {
                for (const match of attribute.value.matchAll(/url\(([^)]+)\)/gi)) {
                  const target = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
                  if (!/^#[A-Za-z0-9_.:-]+$/.test(target)) {
                    throw new Error('Unsafe external URL in SVG style');
                  }
                }
              }
            }
          }

          for (const attribute of ['width', 'height']) {
            const value = Number(root.getAttribute(attribute));
            if (!Number.isFinite(value) || value <= 0) {
              throw new Error(`Invalid SVG ${attribute}`);
            }
          }
          const viewBox = (root.getAttribute('viewBox') || '')
            .trim()
            .split(/[ ,]+/)
            .map(Number);
          if (viewBox.length !== 4
            || viewBox.some(value => !Number.isFinite(value))
            || viewBox[2] <= 0
            || viewBox[3] <= 0) {
            throw new Error('Invalid SVG viewBox');
          }

          const rendererDocument = (globalThis as unknown as {
            document: BrowserDocument;
          }).document;
          const poweredByLink = rendererDocument.querySelector('#canvas .bjs-powered-by');
          const poweredByLogo = poweredByLink?.querySelector('svg');
          if (!poweredByLink
            || poweredByLink.getAttribute('title') !== 'Powered by bpmn.io'
            || !/^https?:\/\/bpmn\.io\/?$/.test(poweredByLink.getAttribute('href') || '')
            || !poweredByLogo) {
            throw new Error('bpmn-js attribution source is missing or changed');
          }

          const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] = viewBox;
          const attributionWidth = 65;
          const attributionHeight = 33;
          const attributionX = viewBoxX + viewBoxWidth - attributionWidth;
          const attributionY = viewBoxY + viewBoxHeight - attributionHeight;
          const svgNamespace = 'http://www.w3.org/2000/svg';
          const attribution = parsed.createElementNS(svgNamespace, 'a');
          attribution.setAttribute('id', 'bpmn-io-attribution');
          attribution.setAttribute('href', 'https://bpmn.io');
          attribution.setAttribute('target', '_blank');
          attribution.setAttribute('rel', 'noopener noreferrer');
          attribution.setAttribute('aria-label', 'Powered by bpmn.io');

          const background = parsed.createElementNS(svgNamespace, 'rect');
          background.setAttribute('x', String(attributionX));
          background.setAttribute('y', String(attributionY));
          background.setAttribute('width', String(attributionWidth));
          background.setAttribute('height', String(attributionHeight));
          background.setAttribute('fill', '#fff');
          attribution.appendChild(background);

          const logoContainer = parsed.createElementNS(svgNamespace, 'g');
          logoContainer.setAttribute(
            'transform',
            `translate(${attributionX + 6} ${attributionY + 6})`
          );
          logoContainer.setAttribute('color', '#404040');
          logoContainer.appendChild(poweredByLogo.cloneNode(true));
          attribution.appendChild(logoContainer);
          root.appendChild(attribution);

          // Serializing only the root drops bpmn-js's external SVG doctype.
          return root.outerHTML;
        } finally {
          viewer.destroy();
        }
      }, xml);

      if (blockedExternalRequest) {
        throw new Error('SVG rendering attempted to load an external resource');
      }

      return normalizeMarkerIds(renderedSvg);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async rasterizeSvg(
    browser: Browser,
    svg: string,
    requestedScale: number
  ): Promise<PngRenderResult> {
    const page = await browser.newPage();

    try {
      let blockedExternalRequest = false;
      await page.setRequestInterception(true);
      page.on('request', request => {
        blockedExternalRequest = true;
        void request.abort('blockedbyclient').catch(() => undefined);
      });
      await page.setContent(`<!doctype html>
<html><head><meta http-equiv="Content-Security-Policy"
content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;overflow:hidden;background:#fff}svg{display:block}</style></head>
<body>${svg}</body></html>`);

      const geometry = await page.$eval('svg', (element, limits) => {
        const width = Number(element.getAttribute('width'));
        const height = Number(element.getAttribute('height'));
        if (!Number.isFinite(width) || width <= 0
          || !Number.isFinite(height) || height <= 0) {
          throw new Error('Invalid SVG raster dimensions');
        }
        // The caller's scale is honoured only as far as the pixel caps allow;
        // beyond that the image is downscaled and the result says so.
        const scale = Math.min(
          limits.requestedScale,
          limits.maxDimension / width,
          limits.maxDimension / height,
          Math.sqrt(limits.maxPixels / (width * height))
        );
        // CSS pixels stay at the SVG's own size; deviceScaleFactor supplies the
        // resolution, so text and strokes are resampled rather than stretched.
        element.setAttribute('width', String(width));
        element.setAttribute('height', String(height));
        return { cssWidth: Math.max(1, Math.ceil(width)), cssHeight: Math.max(1, Math.ceil(height)), scale };
      }, {
        maxDimension: MAX_PNG_DIMENSION,
        maxPixels: MAX_PNG_PIXELS,
        requestedScale
      });

      const effectiveScale = Math.max(geometry.scale, Number.MIN_VALUE);
      await page.setViewport({
        width: geometry.cssWidth,
        height: geometry.cssHeight,
        deviceScaleFactor: effectiveScale
      });

      const screenshot = await page.screenshot({
        type: 'png',
        captureBeyondViewport: false,
        omitBackground: false
      });
      if (blockedExternalRequest) {
        throw new Error('PNG rendering attempted to load an external resource');
      }
      return {
        image: Buffer.from(screenshot),
        width: Math.max(1, Math.round(geometry.cssWidth * effectiveScale)),
        height: Math.max(1, Math.round(geometry.cssHeight * effectiveScale)),
        scale: effectiveScale,
        downscaled: effectiveScale < requestedScale
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.closed) {
      throw new Error('SVG renderer is closed');
    }

    if (this.browser?.connected) {
      return this.browser;
    }
    this.browser = undefined;

    const browserLaunch = this.browserLaunch ?? this.launchBrowser();
    this.browserLaunch = browserLaunch;

    let browser: Browser;
    try {
      browser = await browserLaunch;
    } catch (error) {
      if (this.browserLaunch === browserLaunch) this.browserLaunch = undefined;
      throw error;
    }

    if (this.browserLaunch === browserLaunch) this.browserLaunch = undefined;
    if (this.closed) {
      await browser.close().catch(() => undefined);
      throw new Error('SVG renderer is closed');
    }
    if (!browser.connected) {
      return this.getBrowser();
    }
    if (this.browser === browser) {
      return browser;
    }

    this.browser = browser;
    this.browsers.add(browser);
    browser.once('disconnected', () => {
      this.invalidateBrowser(browser);
      this.browsers.delete(browser);
    });
    return browser;
  }

  private invalidateBrowser(browser: Browser): void {
    if (this.browser === browser) {
      this.browser = undefined;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const options: LaunchOptions = {
      headless: true,
      timeout: this.renderTimeoutMs,
      // The executable's shutdown coordinator owns process signals and drains
      // this renderer before exit. Puppeteer's default handlers would call
      // process.exit(130/143) first and bypass that coordinated cleanup.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    };
    const executablePath = await resolveBrowserExecutable();
    if (executablePath) options.executablePath = executablePath;
    const launchArguments = resolveBrowserLaunchArgs();
    if (launchArguments.length > 0) options.args = launchArguments;
    try {
      return await puppeteer.launch(options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        'SVG export requires Chrome or Chromium. Install Puppeteer\'s managed browser '
        + 'or set PUPPETEER_EXECUTABLE_PATH to a working executable. '
        + `Chrome launch arguments come from ${BROWSER_ARGS_ENVIRONMENT_VARIABLE} `
        + '(space separated); Chrome cannot start as root unless that list disables '
        + 'its sandbox, which this server does by default under uid 0. '
        + `Browser launch failed: ${detail}`,
        { cause: error }
      );
    }
  }
}

async function resolveBrowserExecutable(): Promise<string | undefined> {
  const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configuredPath) return configuredPath;

  try {
    const bundledPath = await puppeteer.executablePath();
    if (existsSync(bundledPath)) return bundledPath;
  } catch {
    // Fall through to system browser paths for developer installations where
    // the Puppeteer download was intentionally skipped.
  }

  return SYSTEM_BROWSER_PATHS.find(existsSync);
}

/** Reject a scale the renderer cannot honour before a browser page is opened. */
function normalizePngScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_PNG_SCALE) {
    throw new Error(`PNG scale must be between 0 and ${MAX_PNG_SCALE}`);
  }
  return scale;
}

function normalizeMarkerIds(svg: string): string {
  const markerIds = Array.from(
    svg.matchAll(/<marker\b[^>]*\bid="(marker-[a-z0-9]+)"/gi),
    match => match[1]
  );

  let normalized = svg;
  for (const [index, markerId] of markerIds.entries()) {
    normalized = normalized.replaceAll(markerId, `bpmn-marker-${index + 1}`);
  }
  return normalized;
}
