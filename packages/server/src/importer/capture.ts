import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { DOCUMENT_LIMITS } from '@pitolet/schema';
import { nanoid } from 'nanoid';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright-core';
import { createImportResourcePolicy, type ImportResourcePolicy } from './networkPolicy.js';
import type {
  CapturedAsset,
  CapturedFontFace,
  CapturedNode,
  CaptureOptions,
  CaptureSnapshot,
  WebCapture,
} from './types.js';

const CAPTURE_ATTRIBUTE = 'data-pitolet-capture-key';
const MAX_PAGE_HEIGHT = 20_000;
const MAX_SCREENSHOT_PIXELS = 24_000_000;
const MAX_DISCOVERED_BREAKPOINTS = 8;
const MAX_CAPTURE_NODES = 10_000;
const MAX_CAPTURE_DEPTH = DOCUMENT_LIMITS.maxDepth;
const MAX_CAPTURE_TEXT = 2_000_000;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_CAPTURE_ASSETS = 500;
const MAX_RASTER_REGIONS = 200;
const MAX_SCREENSHOT_BYTES = 40 * 1024 * 1024;
const MAX_ASSET_REDIRECTS = 5;
const MAX_DATA_URL_CHARACTERS = 28 * 1024 * 1024;
const MAX_TOTAL_DATA_URL_CHARACTERS = 140 * 1024 * 1024;
const SUPPORTED_ASSET_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'font/woff',
  'font/woff2',
]);
const SUPPORTED_IMAGE_MIMES = new Set(
  [...SUPPORTED_ASSET_MIMES].filter((mime) => mime.startsWith('image/')),
);
const SUPPORTED_FONT_MIMES = new Set(
  [...SUPPORTED_ASSET_MIMES].filter((mime) => mime.startsWith('font/')),
);
const CHROMIUM_CAPTURE_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  // Browser request interception cannot see WebRTC UDP sockets. Force
  // Chromium to disable direct UDP so a captured page cannot bypass the
  // URL/DNS policy with a peer connection.
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
] as const;

interface CaptureAssetRequest {
  width: number;
  height: number;
  kind: 'image' | 'font';
  fontFace?: CapturedFontFace;
}

export async function captureWebPage(options: CaptureOptions): Promise<WebCapture> {
  const resourcePolicy = await createImportResourcePolicy(options.url, {
    allowInsecureHttp: options.allowInsecureHttp,
  });
  const { chromium } = await import('playwright-core');
  const browser = await launchChromium(chromium, options.onBrowserInstall);
  const warnings: string[] = [];
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      storageState: options.storageState,
      ignoreHTTPSErrors: false,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    await installResourceGuards(context, resourcePolicy, warnings);
    const snapshots: CaptureSnapshot[] = [];
    const rasterAssets: CapturedAsset[] = [];
    const assetRequests = new Map<string, CaptureAssetRequest>();
    let dataUrlCharacters = 0;
    const assetBudget: CaptureAssetBudget = { count: 0, bytes: 0 };
    const fonts = new Set<string>();
    const customFontFaces = new Map<string, CapturedFontFace>();
    let title = '';
    let cssVariables: Record<string, string> = {};
    const requestedWidths = [...options.viewports].sort((a, b) => a - b);
    const captureWidths = [...requestedWidths];
    const breakpointWidths = requestedWidths.slice(1);

    for (let viewportIndex = 0; viewportIndex < captureWidths.length; viewportIndex++) {
      const width = captureWidths[viewportIndex]!;
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
      if (viewportIndex === 0) {
        const minWidth = requestedWidths[0]!;
        const maxWidth = requestedWidths.at(-1)!;
        const discovered = extractMediaMinWidths(
          captured.mediaQueries,
          captured.rootFontSize,
        ).filter((candidate) => candidate > minWidth && candidate <= maxWidth);
        if (discovered.length > 0) {
          const reported = discovered.slice(0, MAX_DISCOVERED_BREAKPOINTS);
          warnings.push(
            `source media-query breakpoints detected at ${reported.map((value) => `${value}px`).join(', ')}; the requested capture widths remain the editable Pitolet breakpoints`,
          );
          if (discovered.length > MAX_DISCOVERED_BREAKPOINTS) {
            warnings.push(
              `only the first ${MAX_DISCOVERED_BREAKPOINTS} source breakpoints were imported`,
            );
          }
        }
      }
      title ||= captured.title;
      if (Object.keys(cssVariables).length === 0) cssVariables = captured.cssVariables;
      for (const face of captured.fontFaces) {
        customFontFaces.set(
          `${face.family}\0${face.style ?? ''}\0${face.weight ?? ''}\0${face.sourceUrl}`,
          face,
        );
        if (assetRequests.has(face.sourceUrl)) continue;
        const dataUrlLength = face.sourceUrl.startsWith('data:') ? face.sourceUrl.length : 0;
        if (dataUrlLength > MAX_DATA_URL_CHARACTERS) {
          warnings.push(`font ${face.family} was skipped because its encoded data exceeds 28 MB`);
          continue;
        }
        if (dataUrlCharacters + dataUrlLength > MAX_TOTAL_DATA_URL_CHARACTERS) {
          warnings.push('additional inline fonts were skipped after the 140 MB encoded-data limit');
          continue;
        }
        if (assetRequests.size >= MAX_CAPTURE_ASSETS) {
          warnings.push(
            `additional fonts were skipped after the ${MAX_CAPTURE_ASSETS}-asset capture limit`,
          );
          continue;
        }
        dataUrlCharacters += dataUrlLength;
        assetRequests.set(face.sourceUrl, {
          width: 0,
          height: 0,
          kind: 'font',
          fontFace: face,
        });
      }
      const maximumScreenshotHeight = Math.max(
        1,
        Math.min(MAX_PAGE_HEIGHT, Math.floor(MAX_SCREENSHOT_PIXELS / width)),
      );
      if (captured.fullHeight > maximumScreenshotHeight) {
        warnings.push(
          `page height ${captured.fullHeight}px exceeds the safe screenshot limit at ${width}px; screenshots were clipped to ${maximumScreenshotHeight}px`,
        );
      }
      const rootIsPage = !options.selector || ['body', 'html'].includes(options.selector.trim());
      const rootNode = captured.nodes[captured.rootKey]!;
      if (
        !rootIsPage &&
        Math.ceil(rootNode.rect.width) * Math.ceil(rootNode.rect.height) > MAX_SCREENSHOT_PIXELS
      ) {
        throw new Error(
          `selected subtree is too large to screenshot safely at ${width}px; choose a smaller --selector`,
        );
      }
      const screenshot =
        rootIsPage && captured.fullHeight > maximumScreenshotHeight
          ? await page.screenshot({
              type: 'png',
              clip: { x: 0, y: 0, width, height: maximumScreenshotHeight },
            })
          : rootIsPage
            ? await page.screenshot({ type: 'png', fullPage: true })
            : await roots.screenshot({ type: 'png' });
      if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) {
        throw new Error(
          `${width}px source screenshot exceeds ${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)} MB; ` +
            'import a smaller subtree with --selector',
        );
      }

      for (const node of Object.values(captured.nodes)) {
        if (node.styles.fontFamily) fonts.add(node.styles.fontFamily);
        if (node.assetUrl && !node.unsupportedReason) {
          const previous = assetRequests.get(node.assetUrl);
          const dataUrlLength = node.assetUrl.startsWith('data:') ? node.assetUrl.length : 0;
          if (!previous && dataUrlLength > MAX_DATA_URL_CHARACTERS) {
            warnings.push('an inline image was skipped because its encoded data exceeds 28 MB');
          } else if (
            !previous &&
            dataUrlCharacters + dataUrlLength > MAX_TOTAL_DATA_URL_CHARACTERS
          ) {
            warnings.push(
              'additional inline images were skipped after the 140 MB encoded-data limit',
            );
          } else if (!previous && assetRequests.size >= MAX_CAPTURE_ASSETS) {
            warnings.push(
              `additional images were skipped after the ${MAX_CAPTURE_ASSETS}-asset capture limit`,
            );
          } else if (
            !previous ||
            node.rect.width * node.rect.height > previous.width * previous.height
          ) {
            if (!previous) dataUrlCharacters += dataUrlLength;
            assetRequests.set(node.assetUrl, {
              width: node.rect.width,
              height: node.rect.height,
              kind: 'image',
            });
          }
        }
      }

      const viewportRasters = await captureUnsupportedRegions(
        page,
        captured.nodes,
        width,
        warnings,
        assetBudget,
      );
      snapshots.push({
        width,
        height: Math.max(720, Math.round(width * 0.75)),
        fullHeight: rootIsPage
          ? Math.min(captured.fullHeight, maximumScreenshotHeight)
          : Math.max(1, Math.round(captured.nodes[captured.rootKey]!.rect.height)),
        rootKey: captured.rootKey,
        nodes: captured.nodes,
        screenshot: Buffer.from(screenshot),
      });
      rasterAssets.push(...viewportRasters);
      await page.close();
    }

    const downloaded = await downloadAssets(
      context,
      assetRequests,
      warnings,
      resourcePolicy,
      assetBudget,
    );
    if (customFontFaces.size > 0) {
      const embeddedFaces = new Set(
        downloaded
          .map((asset) => asset.fontFace?.family)
          .filter((family): family is string => Boolean(family)),
      );
      const missing = [
        ...new Set(
          [...customFontFaces.values()]
            .map((face) => face.family)
            .filter((family) => !embeddedFaces.has(family)),
        ),
      ].sort();
      if (missing.length > 0) {
        warnings.push(
          `custom web font${missing.length === 1 ? '' : 's'} ${missing
            .slice(0, 8)
            .join(', ')}${missing.length > 8 ? ', …' : ''} could not be embedded and may fall back`,
        );
      }
    }
    return {
      version: 1,
      captureId: `imp_${nanoid(12)}`,
      sourceUrl: options.url,
      rootSelector: options.selector ?? 'body',
      title,
      snapshots,
      breakpointWidths,
      cssVariables,
      fonts: [...fonts].sort(),
      assets: dedupeAssets([...rasterAssets, ...downloaded]),
      warnings,
    };
  } finally {
    await context?.close();
    await browser.close();
  }
}

interface DomCaptureResult {
  title: string;
  fullHeight: number;
  rootKey: string;
  nodes: Record<string, CapturedNode>;
  cssVariables: Record<string, string>;
  mediaQueries: string[];
  fontFaces: CapturedFontFace[];
  rootFontSize: number;
}

interface CaptureAssetBudget {
  count: number;
  bytes: number;
}

async function captureDom(page: Page, selector: string): Promise<DomCaptureResult> {
  return page.evaluate(
    ({ selector: rootSelector, captureAttribute, limits }) => {
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
        'borderRightWidth',
        'borderRightStyle',
        'borderRightColor',
        'borderBottomWidth',
        'borderBottomStyle',
        'borderBottomColor',
        'borderLeftWidth',
        'borderLeftStyle',
        'borderLeftColor',
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
      let nodeCount = 0;
      let textLength = 0;

      const isSingleSupportedGradient = (value: string): boolean => {
        const input = value.trim().toLowerCase();
        if (!input.startsWith('linear-gradient(') && !input.startsWith('radial-gradient(')) {
          return false;
        }
        let depth = 0;
        for (const character of input) {
          if (character === '(') depth += 1;
          else if (character === ')') {
            depth -= 1;
            if (depth < 0) return false;
          } else if (character === ',' && depth === 0) {
            // Multiple background layers cannot yet be represented faithfully.
            return false;
          }
        }
        return depth === 0;
      };

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

      const visit = (
        element: any,
        parentKey: string | null,
        path: string,
        depth: number,
      ): string | null => {
        if (ignored.has(element.tagName)) return null;
        if (depth > limits.maxDepth) {
          throw new Error(`capture exceeds the maximum tree depth of ${limits.maxDepth}`);
        }
        nodeCount += 1;
        if (nodeCount > limits.maxNodes) {
          throw new Error(`capture exceeds the maximum node count of ${limits.maxNodes}`);
        }
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
        else if (
          styles.backgroundImage &&
          styles.backgroundImage !== 'none' &&
          !isSingleSupportedGradient(styles.backgroundImage)
        )
          unsupportedReason = 'background image';
        else if (styles.transform && styles.transform !== 'none')
          unsupportedReason = 'CSS transform';
        else if (styles.filter && styles.filter !== 'none') unsupportedReason = 'CSS filter';
        else if (styles.position === 'fixed') unsupportedReason = 'fixed positioning';
        else if (
          (() => {
            const sides = ['Top', 'Right', 'Bottom', 'Left']
              .map((side) => ({
                width: Number.parseFloat(styles[`border${side}Width`] ?? '0') || 0,
                style: styles[`border${side}Style`] ?? 'none',
                color: styles[`border${side}Color`] ?? 'transparent',
              }))
              .filter((side) => side.width > 0 && side.style !== 'none');
            if (sides.length < 2) return false;
            return sides.some(
              (side) =>
                side.width !== sides[0]!.width ||
                side.style !== sides[0]!.style ||
                side.color !== sides[0]!.color,
            );
          })()
        )
          unsupportedReason = 'asymmetric border';
        else if (
          element.tagName === 'IMG' &&
          /(?:^data:image\/svg\+xml|\.svg(?:$|[?#]))/i.test(
            String(element.currentSrc || element.src || ''),
          )
        )
          unsupportedReason = 'SVG image';
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
                depth + 1,
              );
              if (childKey) children.push(childKey);
            } else if (child.nodeType === 3) {
              const text = String(child.textContent ?? '').replace(/\s+/g, ' ');
              if (!text.trim()) continue;
              const textKey = `${key}::text:${textIndex++}`;
              const trimmedText = text.trim();
              nodeCount += 1;
              textLength += text.length;
              if (nodeCount > limits.maxNodes) {
                throw new Error(`capture exceeds the maximum node count of ${limits.maxNodes}`);
              }
              if (textLength > limits.maxText) {
                throw new Error(
                  `capture exceeds the maximum text size of ${limits.maxText} characters`,
                );
              }
              nodes[textKey] = {
                key: textKey,
                kind: 'text',
                tag: '#text',
                parentKey: key,
                children: [],
                text,
                name: trimmedText.length > 48 ? `${trimmedText.slice(0, 47)}…` : trimmedText,
                attrs: {},
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                styles,
              };
              children.push(textKey);
            }
          }
        }
        const tag = String(element.tagName).toLowerCase();
        const semanticTextTags = new Set([
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'button',
          'a',
          'label',
          'legend',
          'summary',
          'option',
          'th',
        ]);
        const semanticText = semanticTextTags.has(tag)
          ? String(element.textContent ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120)
          : '';
        textLength += semanticText.length;
        if (textLength > limits.maxText) {
          throw new Error(`capture exceeds the maximum text size of ${limits.maxText} characters`);
        }
        const className = Array.from(element.classList ?? [])
          .map(String)
          .find((value) => value.length > 1 && value.length <= 80);
        const humanize = (value: string): string =>
          value
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^./, (character) => character.toUpperCase());
        const label =
          attrs['aria-label'] ||
          element.id ||
          element.getAttribute('data-testid') ||
          attrs.alt ||
          semanticText ||
          (className ? humanize(className) : '') ||
          tag;
        nodes[key] = {
          key,
          kind: 'element',
          tag,
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

      const rootKey = visit(root, null, `root:${String(root.tagName).toLowerCase()}`, 0)!;
      const cssVariables: Record<string, string> = {};
      const rootStyle = g.getComputedStyle(document.documentElement);
      for (let i = 0; i < rootStyle.length; i++) {
        const property = String(rootStyle.item(i));
        if (property.startsWith('--'))
          cssVariables[property] = rootStyle.getPropertyValue(property).trim();
      }
      const mediaQueries = new Set<string>();
      const fontFaces: CapturedFontFace[] = [];
      const collectMediaQueries = (rules: any, stylesheetUrl: string): void => {
        for (const rule of Array.from(rules ?? []) as any[]) {
          const condition = String(rule.conditionText ?? rule.media?.mediaText ?? '').trim();
          if (condition) mediaQueries.add(condition);
          const cssText = String(rule.cssText ?? '')
            .trim()
            .toLowerCase();
          if (rule.type === 5 || cssText.startsWith('@font-face')) {
            const family = String(rule.style?.getPropertyValue?.('font-family') ?? '')
              .replace(/^['"]|['"]$/g, '')
              .trim();
            const source = String(rule.style?.getPropertyValue?.('src') ?? '');
            const style = String(rule.style?.getPropertyValue?.('font-style') ?? '').trim();
            const weight = String(rule.style?.getPropertyValue?.('font-weight') ?? '').trim();
            const display = String(rule.style?.getPropertyValue?.('font-display') ?? '').trim();
            const urlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
            let match: RegExpExecArray | null;
            while (family && (match = urlPattern.exec(source))) {
              try {
                fontFaces.push({
                  family,
                  sourceUrl: new URL(match[2]!, stylesheetUrl).href,
                  ...(style ? { style } : {}),
                  ...(weight ? { weight } : {}),
                  ...(display ? { display } : {}),
                });
              } catch {
                // Invalid font URLs are ignored; computed text styles remain editable.
              }
            }
          }
          try {
            if (rule.cssRules) collectMediaQueries(rule.cssRules, stylesheetUrl);
          } catch {
            // Cross-origin and browser-managed rule lists are intentionally opaque.
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets) as any[]) {
        try {
          collectMediaQueries(sheet.cssRules, String(sheet.href || document.baseURI));
        } catch {
          // A cross-origin stylesheet can still be rendered even when its rules cannot be read.
        }
      }
      return {
        title: String(document.title || '').trim(),
        fullHeight: Math.ceil(Math.max(document.documentElement.scrollHeight, root.scrollHeight)),
        rootKey,
        nodes,
        cssVariables,
        mediaQueries: [...mediaQueries],
        fontFaces,
        rootFontSize: Number.parseFloat(rootStyle.fontSize) || 16,
      };
    },
    {
      selector,
      captureAttribute: CAPTURE_ATTRIBUTE,
      limits: {
        maxNodes: MAX_CAPTURE_NODES,
        maxDepth: MAX_CAPTURE_DEPTH,
        maxText: MAX_CAPTURE_TEXT,
      },
    },
  );
}

/** Extract inclusive lower width bounds from the common media-query syntaxes. */
export function extractMediaMinWidths(queries: string[], rootFontSize = 16): number[] {
  const widths = new Set<number>();
  const patterns = [
    /min-width\s*:\s*(\d*\.?\d+)\s*(px|em|rem)/gi,
    /width\s*>=\s*(\d*\.?\d+)\s*(px|em|rem)/gi,
    /(\d*\.?\d+)\s*(px|em|rem)\s*<=\s*width/gi,
  ];

  for (const query of queries) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(query))) {
        const value = Number(match[1]);
        const unit = match[2]!.toLowerCase();
        const width = Math.ceil(value * (unit === 'px' ? 1 : rootFontSize));
        if (Number.isFinite(width) && width >= 240 && width <= 4096) widths.add(width);
      }
    }
  }

  return [...widths].sort((left, right) => left - right);
}

async function installResourceGuards(
  context: BrowserContext,
  policy: ImportResourcePolicy,
  warnings: string[],
): Promise<void> {
  const reported = new Set<string>();
  const reportBlocked = (url: string, error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `blocked page resource ${safeResourceLabel(url)}: ${reason}`;
    if (reported.has(message)) return;
    reported.add(message);
    warnings.push(message);
  };

  // Remove the page-level WebRTC entry points before any source script runs.
  // The Chromium flag above is the transport boundary; this is defense in
  // depth and also prevents noisy STUN attempts.
  await context.addInitScript(() => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      try {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          configurable: false,
          writable: false,
        });
      } catch {
        // A browser may expose a non-configurable property already. The
        // launch policy still blocks direct UDP in that case.
      }
    }
  });

  // Capture uses pages it creates itself. Popups are unnecessary and can
  // outlive the source page, so close them before they become background
  // network actors. Context routing below still applies during the race.
  context.on('page', (page) => {
    void page
      .opener()
      .then((opener) => (opener ? page.close() : undefined))
      .catch(() => {});
  });

  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (!/^(?:https?|wss?):/i.test(url)) {
      // Page-local resources are required by normal apps. Every other
      // non-network scheme (file:, ftp:, chrome-extension:, …) is blocked
      // instead of being handed back to Chromium outside our DNS policy.
      if (/^(?:data:|blob:)/i.test(url) || /^about:blank(?:[#?].*)?$/i.test(url)) {
        await route.continue();
      } else {
        reportBlocked(url, new Error('non-http resource schemes are blocked'));
        await route.abort('blockedbyclient');
      }
      return;
    }
    try {
      await policy.assertAllowed(url);
      await route.continue();
    } catch (error) {
      reportBlocked(url, error);
      await route.abort('blockedbyclient');
    }
  });

  await context.routeWebSocket(/.*/, async (webSocket) => {
    const url = webSocket.url();
    try {
      await policy.assertAllowed(url);
      webSocket.connectToServer();
    } catch (error) {
      reportBlocked(url, error);
      await webSocket.close({ code: 1008, reason: 'Blocked by import network policy' });
    }
  });
}

async function captureUnsupportedRegions(
  page: Page,
  nodes: Record<string, CapturedNode>,
  width: number,
  warnings: string[],
  budget: CaptureAssetBudget,
): Promise<CapturedAsset[]> {
  const assets: CapturedAsset[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.unsupportedReason || node.rect.width < 1 || node.rect.height < 1) continue;
    if (budget.count >= MAX_RASTER_REGIONS || budget.count >= MAX_CAPTURE_ASSETS) {
      warnings.push(
        `additional unsupported regions were skipped after the ${MAX_RASTER_REGIONS}-region raster limit`,
      );
      break;
    }
    try {
      const locator = page.locator(`[${CAPTURE_ATTRIBUTE}="${escapeAttribute(node.key)}"]`);
      if ((await locator.count()) !== 1) throw new Error('capture locator is not unique');
      const data = Buffer.from(await locator.screenshot({ type: 'png' }));
      if (data.length > MAX_ASSET_BYTES) {
        throw new Error('rasterized region exceeds 20 MB');
      }
      if (budget.bytes + data.length > MAX_TOTAL_ASSET_BYTES) {
        warnings.push('additional assets were skipped after the 100 MB capture limit');
        break;
      }
      assets.push({
        key: `raster:${node.key}:${width}`,
        fileName: `${safeName(node.name || node.tag)}-${width}.png`,
        mime: 'image/png',
        width: Math.max(1, Math.round(node.rect.width)),
        height: Math.max(1, Math.round(node.rect.height)),
        data,
      });
      budget.count += 1;
      budget.bytes += data.length;
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
  requests: Map<string, CaptureAssetRequest>,
  warnings: string[],
  resourcePolicy: ImportResourcePolicy,
  budget: CaptureAssetBudget,
): Promise<CapturedAsset[]> {
  const assets: CapturedAsset[] = [];
  for (const [url, request] of requests) {
    if (budget.count >= MAX_CAPTURE_ASSETS) {
      warnings.push(`additional images were skipped after the ${MAX_CAPTURE_ASSETS}-asset limit`);
      break;
    }
    if (budget.bytes >= MAX_TOTAL_ASSET_BYTES) {
      warnings.push('additional images were skipped after the 100 MB capture limit');
      break;
    }
    try {
      const decoded = decodeDataUrl(url);
      let mime: string;
      let data: Buffer;
      let fileName: string;
      if (decoded) {
        ({ mime, data } = decoded);
        fileName = `${request.kind}.${extensionForMime(mime)}`;
      } else {
        const response = await fetchAssetWithRedirects(context, url, resourcePolicy);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredMime = (response.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        const expectedMimes =
          request.kind === 'font' ? SUPPORTED_FONT_MIMES : SUPPORTED_IMAGE_MIMES;
        if (
          !expectedMimes.has(declaredMime) &&
          !(request.kind === 'font' && declaredMime === 'application/octet-stream')
        ) {
          await response.body?.cancel();
          throw new Error(`unsupported type ${declaredMime || 'unknown'}`);
        }
        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES) {
          throw new Error('asset exceeds 20 MB');
        }
        data = await readLimitedBody(response, MAX_ASSET_BYTES);
        mime = normalizedAssetMime(declaredMime, data, request.kind);
        fileName = safeName(basename(new URL(response.url || url).pathname) || request.kind);
      }
      mime = normalizedAssetMime(mime, data, request.kind);
      if (!SUPPORTED_ASSET_MIMES.has(mime))
        throw new Error(`unsupported type ${mime || 'unknown'}`);
      if (data.length > MAX_ASSET_BYTES) throw new Error('asset exceeds 20 MB');
      if (budget.bytes + data.length > MAX_TOTAL_ASSET_BYTES) {
        warnings.push('additional images were skipped after the 100 MB capture limit');
        break;
      }
      assets.push({
        key: `url:${url}`,
        fileName,
        mime,
        width: request.kind === 'font' ? 0 : Math.max(1, Math.round(request.width)),
        height: request.kind === 'font' ? 0 : Math.max(1, Math.round(request.height)),
        data,
        ...(request.fontFace ? { fontFace: request.fontFace } : {}),
      });
      budget.count += 1;
      budget.bytes += data.length;
    } catch (err) {
      warnings.push(
        `${request.kind} ${safeResourceLabel(url)} was skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return assets;
}

async function fetchAssetWithRedirects(
  context: BrowserContext,
  initialUrl: string,
  resourcePolicy: ImportResourcePolicy,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= MAX_ASSET_REDIRECTS; redirect += 1) {
    await resourcePolicy.assertAllowed(currentUrl);
    const cookies = await context.cookies(currentUrl);
    const response = await fetch(currentUrl, {
      headers:
        cookies.length > 0
          ? { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') }
          : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error(`HTTP ${response.status} redirect has no location`);
    if (redirect >= MAX_ASSET_REDIRECTS) {
      throw new Error(`asset exceeded ${MAX_ASSET_REDIRECTS} redirects`);
    }
    currentUrl = new URL(location, currentUrl).href;
  }
  throw new Error(`asset exceeded ${MAX_ASSET_REDIRECTS} redirects`);
}

export async function launchChromium(
  chromium: Pick<BrowserType, 'launch'>,
  onInstall?: () => void,
  install: () => Promise<void> = installChromium,
): Promise<Browser> {
  const launchOptions = { headless: true, args: [...CHROMIUM_CAPTURE_ARGS] };
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/executable.*doesn.t exist|browser.*not found|install/i.test(message)) throw err;
  }
  onInstall?.();
  await install();
  return chromium.launch(launchOptions);
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

export function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 5) return null;
  const metadata = url.slice(5, comma).split(';');
  const mime = metadata.shift()?.trim().toLowerCase();
  if (!mime) return null;
  const payload = url.slice(comma + 1);
  const base64 = metadata.some((entry) => entry.trim().toLowerCase() === 'base64');
  const estimatedBytes = base64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  if (estimatedBytes > MAX_ASSET_BYTES) throw new Error('asset exceeds 20 MB');
  const data = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
  if (data.length > MAX_ASSET_BYTES) throw new Error('asset exceeds 20 MB');
  return {
    mime,
    data,
  };
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'font/woff':
      return 'woff';
    case 'font/woff2':
      return 'woff2';
    default:
      return 'png';
  }
}

function normalizedAssetMime(
  declaredMime: string,
  data: Buffer,
  kind: CaptureAssetRequest['kind'],
): string {
  if (kind === 'font') {
    const signature = data.subarray(0, 4).toString('ascii');
    if (signature === 'wOF2') return 'font/woff2';
    if (signature === 'wOFF') return 'font/woff';
    throw new Error('font bytes are not WOFF or WOFF2');
  }
  if (!SUPPORTED_IMAGE_MIMES.has(declaredMime)) {
    throw new Error(`unsupported image type ${declaredMime || 'unknown'}`);
  }
  return declaredMime;
}

async function readLimitedBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('asset exceeds 20 MB');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
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

function safeResourceLabel(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 180);
  } catch {
    return value.slice(0, 180);
  }
}
