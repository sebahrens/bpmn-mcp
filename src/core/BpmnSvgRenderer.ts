import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';

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

const DEFAULT_RENDER_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_RENDERS = 1;

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
  private readonly browsers = new Set<Browser>();
  private closed = false;

  constructor(
    private readonly renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
    private readonly maxConcurrentRenders = DEFAULT_MAX_CONCURRENT_RENDERS
  ) {
    if (!Number.isSafeInteger(renderTimeoutMs) || renderTimeoutMs <= 0
      || !Number.isSafeInteger(maxConcurrentRenders) || maxConcurrentRenders <= 0) {
      throw new Error('Invalid SVG renderer limits');
    }
  }

  async render(xml: string): Promise<string> {
    if (this.closed) {
      throw new Error('SVG renderer is closed');
    }
    if (this.activeRenders >= this.maxConcurrentRenders) {
      throw new Error('SVG renderer concurrency limit reached');
    }
    this.activeRenders += 1;

    try {
      const browser = await this.launchBrowser();
      if (this.closed) {
        await browser.close().catch(() => undefined);
        throw new Error('SVG renderer is closed');
      }
      this.browsers.add(browser);
      return await this.renderWithBrowser(browser, xml);
    } finally {
      this.activeRenders -= 1;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(Array.from(this.browsers, browser => (
      browser.close().catch(() => undefined)
    )));
  }

  private async renderWithBrowser(browser: Browser, xml: string): Promise<string> {
    let renderTimeout: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        renderTimeout = setTimeout(() => {
          reject(new Error(`SVG rendering exceeded ${this.renderTimeoutMs}ms`));
          void browser.close().catch(() => undefined);
        }, this.renderTimeoutMs);
      });

      return await Promise.race([this.renderPage(browser, xml), timeout]);
    } finally {
      if (renderTimeout) clearTimeout(renderTimeout);
      await browser.close().catch(() => undefined);
      this.browsers.delete(browser);
    }
  }

  private async renderPage(browser: Browser, xml: string): Promise<string> {
      const page = await browser.newPage();
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
    return puppeteer.launch(options);
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
