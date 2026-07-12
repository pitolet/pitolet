import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright-core';
import type {
  CapturedAsset,
  CapturedNode,
  CaptureOptions,
  CaptureSnapshot,
  WebCapture,
} from './types.js';

const CAPTURE_ATTRIBUTE = 'data-pitolet-capture-key';
const MAX_PAGE_HEIGHT = 20_000;
const SUPPORTED_ASSET_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

export async function captureWebPage(options: CaptureOptions): Promise<WebCapture> {
  const { chromium } = await import('playwright-core');
  const browser = await launchChromium(chromium, options.onBrowserInstall);
  const context = await browser.newContext({
    storageState: options.storageState,
    ignoreHTTPSErrors: false,
  });
  const warnings: string[] = [];
  try {
    const snapshots: CaptureSnapshot[] = [];
    const rasterAssets: CapturedAsset[] = [];
    const assetRequests = new Map<string, { width: number; height: number }>();
    const fonts = new Set<string>();
    let title = '';
    let cssVariables: Record<string, string> = {};

    for (const width of [...options.viewports].sort((a, b) => a - b)) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: Math.max(720, Math.round(width * 0.75)) });
      const navigation = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      if (!navigation) throw new Error(`source page ${options.url} returned no response`);
      if (!navigation.ok()) {
        throw new Error(`source page returned HTTP ${navigation.status()} at ${navigation.url()}`);
      }
      if (options.waitFor) {
        await page.locator(options.waitFor).waitFor({ state: 'visible', timeout: 30_000 });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      }

      const roots = page.locator(options.selector ?? 'body');
      const rootCount = await roots.count();
      if (rootCount !== 1) {
        throw new Error(
          `${options.selector ?? 'body'} matched ${rootCount} elements; import requires exactly one root`,
        );
      }

      const captured = await captureDom(page, options.selector ?? 'body');
      title ||= captured.title;
      if (Object.keys(cssVariables).length === 0) cssVariables = captured.cssVariables;
      if (captured.fullHeight > MAX_PAGE_HEIGHT) {
        warnings.push(
          `page height ${captured.fullHeight}px exceeds ${MAX_PAGE_HEIGHT}px; screenshots were clipped`,
        );
      }
      const rootIsPage = !options.selector || ['body', 'html'].includes(options.selector.trim());
      const screenshot = rootIsPage
        ? await page.screenshot({
            type: 'png',
            fullPage: captured.fullHeight <= MAX_PAGE_HEIGHT,
            ...(captured.fullHeight > MAX_PAGE_HEIGHT
              ? { clip: { x: 0, y: 0, width, height: MAX_PAGE_HEIGHT } }
              : {}),
          })
        : await roots.screenshot({ type: 'png' });

      for (const node of Object.values(captured.nodes)) {
        if (node.styles.fontFamily) fonts.add(node.styles.fontFamily);
        if (node.assetUrl) {
          const previous = assetRequests.get(node.assetUrl);
          if (!previous || node.rect.width * node.rect.height > previous.width * previous.height) {
            assetRequests.set(node.assetUrl, { width: node.rect.width, height: node.rect.height });
          }
        }
      }

      const viewportRasters = await captureUnsupportedRegions(
        page,
        captured.nodes,
        width,
        warnings,
      );
      snapshots.push({
        width,
        height: Math.max(720, Math.round(width * 0.75)),
        fullHeight: rootIsPage
          ? Math.min(captured.fullHeight, MAX_PAGE_HEIGHT)
          : Math.max(1, Math.round(captured.nodes[captured.rootKey]!.rect.height)),
        rootKey: captured.rootKey,
        nodes: captured.nodes,
        screenshot: Buffer.from(screenshot),
      });
      rasterAssets.push(...viewportRasters);
      await page.close();
    }

    const downloaded = await downloadAssets(context, assetRequests, warnings);
    return {
      version: 1,
      captureId: `imp_${nanoid(12)}`,
      sourceUrl: options.url,
      rootSelector: options.selector ?? 'body',
      title,
      snapshots,
      cssVariables,
      fonts: [...fonts].sort(),
      assets: dedupeAssets([...rasterAssets, ...downloaded]),
      warnings,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

interface DomCaptureResult {
  title: string;
  fullHeight: number;
  rootKey: string;
  nodes: Record<string, CapturedNode>;
  cssVariables: Record<string, string>;
}

async function captureDom(page: Page, selector: string): Promise<DomCaptureResult> {
  return page.evaluate(
    ({ selector: rootSelector, captureAttribute }) => {
      const g = globalThis as unknown as {
        document: any;
        getComputedStyle: (element: any, pseudo?: string) => any;
      };
      const document = g.document;
      const root = document.querySelector(rootSelector);
      if (!root) throw new Error(`capture root ${rootSelector} disappeared`);

      const ignored = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
      const unsupportedTags = new Set(['SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'OBJECT', 'EMBED']);
      const idCounts = new Map<string, number>();
      const testIdCounts = new Map<string, number>();
      for (const element of Array.from(root.querySelectorAll('*')) as any[]) {
        if (element.id) idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
        const testId = element.getAttribute('data-testid');
        if (testId) testIdCounts.set(testId, (testIdCounts.get(testId) ?? 0) + 1);
      }
      if (root.id) idCounts.set(root.id, (idCounts.get(root.id) ?? 0) + 1);

      const styleProperties = [
        'display',
        'flexDirection',
        'flexWrap',
        'alignItems',
        'justifyContent',
        'rowGap',
        'columnGap',
        'gridTemplateColumns',
        'gridTemplateRows',
        'gridColumn',
        'gridRow',
        'alignSelf',
        'flexGrow',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'marginTop',
        'marginRight',
        'marginBottom',
        'marginLeft',
        'width',
        'height',
        'minWidth',
        'maxWidth',
        'minHeight',
        'maxHeight',
        'position',
        'top',
        'right',
        'bottom',
        'left',
        'zIndex',
        'fontFamily',
        'fontSize',
        'fontWeight',
        'lineHeight',
        'letterSpacing',
        'textAlign',
        'color',
        'backgroundColor',
        'backgroundImage',
        'borderTopWidth',
        'borderTopStyle',
        'borderTopColor',
        'borderTopLeftRadius',
        'borderTopRightRadius',
        'borderBottomRightRadius',
        'borderBottomLeftRadius',
        'boxShadow',
        'opacity',
        'overflow',
        'cursor',
        'objectFit',
        'transform',
        'filter',
        'mixBlendMode',
      ];
      const nodes: Record<string, CapturedNode> = {};
      const usedKeys = new Set<string>();

      const stableKey = (element: any, path: string): string => {
        let key = path;
        if (element.id && idCounts.get(element.id) === 1) key = `id:${element.id}`;
        else {
          const testId = element.getAttribute('data-testid');
          if (testId && testIdCounts.get(testId) === 1) key = `testid:${testId}`;
        }
        if (!usedKeys.has(key)) {
          usedKeys.add(key);
          return key;
        }
        let suffix = 2;
        while (usedKeys.has(`${key}:${suffix}`)) suffix += 1;
        const unique = `${key}:${suffix}`;
        usedKeys.add(unique);
        return unique;
      };

      const visit = (element: any, parentKey: string | null, path: string): string | null => {
        if (ignored.has(element.tagName)) return null;
        const key = stableKey(element, path);
        element.setAttribute(captureAttribute, key);
        const css = g.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const styles: Record<string, string> = {};
        for (const property of styleProperties) styles[property] = String(css[property] ?? '');
        const before = g.getComputedStyle(element, '::before')?.content;
        const after = g.getComputedStyle(element, '::after')?.content;
        let unsupportedReason: string | undefined;
        if (unsupportedTags.has(element.tagName)) unsupportedReason = element.tagName.toLowerCase();
        else if (styles.backgroundImage && styles.backgroundImage !== 'none')
          unsupportedReason = 'background image';
        else if (styles.transform && styles.transform !== 'none')
          unsupportedReason = 'CSS transform';
        else if (styles.filter && styles.filter !== 'none') unsupportedReason = 'CSS filter';
        else if (styles.position === 'fixed') unsupportedReason = 'fixed positioning';
        else if (
          (before && before !== 'none' && before !== 'normal') ||
          (after && after !== 'none' && after !== 'normal')
        ) {
          unsupportedReason = 'pseudo-element content';
        }

        const attrs: Record<string, string> = {};
        for (const attr of Array.from(element.attributes) as any[]) {
          const attrName = String(attr.name).toLowerCase();
          if (
            attrName.startsWith('aria-') ||
            [
              'alt',
              'role',
              'placeholder',
              'title',
              'type',
              'name',
              'value',
              'for',
              'href',
              'target',
              'rel',
              'colspan',
              'rowspan',
              'scope',
              'autocomplete',
              'inputmode',
              'pattern',
              'min',
              'max',
              'step',
              'rows',
              'cols',
              'checked',
              'disabled',
              'selected',
            ].includes(attrName)
          )
            attrs[attrName] = String(attr.value);
        }
        if ('value' in element && typeof element.value === 'string' && element.value) {
          attrs.value = String(element.value);
        }
        if ('checked' in element && element.checked) attrs.checked = 'true';
        if ('selected' in element && element.selected) attrs.selected = 'true';
        const children: string[] = [];
        const childNodes = Array.from(element.childNodes) as any[];
        let elementIndex = 0;
        let textIndex = 0;
        if (!unsupportedReason) {
          for (const child of childNodes) {
            if (child.nodeType === 1) {
              const childKey = visit(
                child,
                key,
                `${path}>${String(child.tagName).toLowerCase()}:${elementIndex++}`,
              );
              if (childKey) children.push(childKey);
            } else if (child.nodeType === 3) {
              const text = String(child.textContent ?? '').replace(/\s+/g, ' ');
              if (!text.trim()) continue;
              const textKey = `${key}::text:${textIndex++}`;
              nodes[textKey] = {
                key: textKey,
                kind: 'text',
                tag: '#text',
                parentKey: key,
                children: [],
                text,
                name: 'Text',
                attrs: {},
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                styles,
              };
              children.push(textKey);
            }
          }
        }
        const label = attrs['aria-label'] || element.id || String(element.tagName).toLowerCase();
        nodes[key] = {
          key,
          kind: 'element',
          tag: String(element.tagName).toLowerCase(),
          parentKey,
          children,
          text: String(element.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10_000),
          name: String(label).slice(0, 120),
          attrs,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          styles,
          ...(element.tagName === 'IMG' && (element.currentSrc || element.src)
            ? { assetUrl: String(element.currentSrc || element.src) }
            : {}),
          ...(unsupportedReason ? { unsupportedReason } : {}),
        };
        return key;
      };

      const rootKey = visit(root, null, `root:${String(root.tagName).toLowerCase()}`)!;
      const cssVariables: Record<string, string> = {};
      const rootStyle = g.getComputedStyle(document.documentElement);
      for (let i = 0; i < rootStyle.length; i++) {
        const property = String(rootStyle.item(i));
        if (property.startsWith('--'))
          cssVariables[property] = rootStyle.getPropertyValue(property).trim();
      }
      return {
        title: String(document.title || '').trim(),
        fullHeight: Math.ceil(Math.max(document.documentElement.scrollHeight, root.scrollHeight)),
        rootKey,
        nodes,
        cssVariables,
      };
    },
    { selector, captureAttribute: CAPTURE_ATTRIBUTE },
  );
}

async function captureUnsupportedRegions(
  page: Page,
  nodes: Record<string, CapturedNode>,
  width: number,
  warnings: string[],
): Promise<CapturedAsset[]> {
  const assets: CapturedAsset[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.unsupportedReason || node.rect.width < 1 || node.rect.height < 1) continue;
    try {
      const locator = page.locator(`[${CAPTURE_ATTRIBUTE}="${escapeAttribute(node.key)}"]`);
      if ((await locator.count()) !== 1) throw new Error('capture locator is not unique');
      const data = Buffer.from(await locator.screenshot({ type: 'png' }));
      assets.push({
        key: `raster:${node.key}:${width}`,
        fileName: `${safeName(node.name || node.tag)}-${width}.png`,
        mime: 'image/png',
        width: Math.max(1, Math.round(node.rect.width)),
        height: Math.max(1, Math.round(node.rect.height)),
        data,
      });
      warnings.push(`${node.name || node.tag} was rasterized: ${node.unsupportedReason}`);
    } catch (err) {
      warnings.push(
        `${node.name || node.tag} could not be rasterized: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return assets;
}

async function downloadAssets(
  context: BrowserContext,
  requests: Map<string, { width: number; height: number }>,
  warnings: string[],
): Promise<CapturedAsset[]> {
  const assets: CapturedAsset[] = [];
  for (const [url, dimensions] of requests) {
    try {
      const decoded = decodeDataUrl(url);
      let mime: string;
      let data: Buffer;
      if (decoded) {
        ({ mime, data } = decoded);
      } else {
        const response = await context.request.get(url, { timeout: 30_000 });
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
        mime = (response.headers()['content-type'] ?? '').split(';')[0]!.trim();
        data = Buffer.from(await response.body());
      }
      if (!SUPPORTED_ASSET_MIMES.has(mime))
        throw new Error(`unsupported type ${mime || 'unknown'}`);
      if (data.length > 20 * 1024 * 1024) throw new Error('asset exceeds 20 MB');
      assets.push({
        key: `url:${url}`,
        fileName: safeName(basename(new URL(url, 'http://localhost').pathname) || 'image'),
        mime,
        width: Math.max(1, Math.round(dimensions.width)),
        height: Math.max(1, Math.round(dimensions.height)),
        data,
      });
    } catch (err) {
      warnings.push(
        `image ${url.slice(0, 160)} was skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return assets;
}

export async function launchChromium(
  chromium: Pick<BrowserType, 'launch'>,
  onInstall?: () => void,
  install: () => Promise<void> = installChromium,
): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/executable.*doesn.t exist|browser.*not found|install/i.test(message)) throw err;
  }
  onInstall?.();
  await install();
  return chromium.launch({ headless: true });
}

async function installChromium(): Promise<void> {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('playwright-core/package.json'));
  await run(process.execPath, [join(packageRoot, 'cli.js'), 'install', 'chromium']);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`browser installation failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  return {
    mime: match[1]!,
    data: match[2] ? Buffer.from(match[3]!, 'base64') : Buffer.from(decodeURIComponent(match[3]!)),
  };
}

function dedupeAssets(assets: CapturedAsset[]): CapturedAsset[] {
  const byKey = new Map<string, CapturedAsset>();
  for (const asset of assets) byKey.set(asset.key, asset);
  return [...byKey.values()];
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeName(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'asset'
  );
}
