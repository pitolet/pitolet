import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const staticRoot = process.env.PITOLET_SITE_STATIC_ROOT
  ? resolve(process.env.PITOLET_SITE_STATIC_ROOT)
  : resolve(repoRoot, 'deploy/static');
const artifactRoot = process.env.PITOLET_QA_ARTIFACT_DIR
  ? resolve(process.env.PITOLET_QA_ARTIFACT_DIR, 'site')
  : resolve(tmpdir(), 'pitolet-site-qa');
const pages = [
  {
    name: 'home',
    path: '/',
    heading: 'Give your agent’s designs a human touch.',
    noindex: false,
  },
  {
    name: 'vs-figma',
    path: '/vs-figma/',
    heading: 'Use Pitolet when the interface already exists.',
    noindex: false,
  },
  { name: 'terms', path: '/terms.html', heading: 'Terms of Service', noindex: true },
  { name: 'privacy', path: '/privacy.html', heading: 'Privacy Policy', noindex: true },
];
const viewports = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 1000 },
];

if (!existsSync(resolve(staticRoot, 'index.html'))) {
  throw new Error('landing site has not been built; run `pnpm build:site` first');
}
await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });

const server = createServer((request, response) => serveStatic(request.url ?? '/', response));
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('could not start site QA server');
const baseUrl = `http://127.0.0.1:${address.port}`;

let browser;
const failures = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(`console error: ${message.text()}`);
    });

    for (const expected of pages) {
      runtimeErrors.length = 0;
      const label = `${expected.path} at ${viewport.name} (${viewport.width}px)`;
      try {
        const response = await page.goto(`${baseUrl}${expected.path}`, {
          waitUntil: 'networkidle',
        });
        if (!response?.ok()) {
          failures.push(`${label}: HTTP ${response?.status() ?? 'no response'}`);
          continue;
        }

        const artifactName = `${expected.name}-${viewport.name}`;
        const screenshot = await page.screenshot({
          fullPage: true,
          path: resolve(artifactRoot, `${artifactName}.png`),
        });
        const screenshotStats = await analyzeScreenshot(page, screenshot);
        await writeFile(
          resolve(artifactRoot, `${artifactName}.json`),
          JSON.stringify(screenshotStats, null, 2),
        );
        if (screenshot.length < 5_000 || screenshotStats.nearUniform) {
          failures.push(
            `${label}: screenshot looks blank or near-uniform ` +
              `(${screenshot.length} bytes, ${screenshotStats.distinctBuckets} color buckets)`,
          );
        }

        const result = await page.evaluate((expectedHeading) => {
          const html = document.documentElement;
          const heading = document.querySelector('h1');
          const images = [...document.images];
          const invalidLinks = [...document.querySelectorAll('a')].filter((link) => {
            const href = link.getAttribute('href')?.trim() ?? '';
            return !href || /^(?:javascript|data):/i.test(href);
          });
          const brokenFragments = [...document.querySelectorAll('a[href^="#"]')]
            .map((link) => link.getAttribute('href')?.slice(1) ?? '')
            .filter((id) => id && document.getElementById(decodeURIComponent(id)) === null);
          const internalLinks = [
            ...new Set(
              [...document.querySelectorAll('a[href]')]
                .map((link) => link.getAttribute('href')?.trim() ?? '')
                .filter((href) => href && !href.startsWith('#'))
                .map((href) => new URL(href, location.href))
                .filter((url) => url.origin === location.origin)
                .map((url) => `${url.pathname}${url.search}`),
            ),
          ];
          const styles = [...document.querySelectorAll('style')]
            .map((style) => style.textContent ?? '')
            .join('\n');
          const metaDescription = document.querySelector('meta[name="description"]');
          const robots = document.querySelector('meta[name="robots"]');
          return {
            language: html.lang,
            title: document.title.trim(),
            description: metaDescription?.getAttribute('content')?.trim() ?? '',
            robots: robots?.getAttribute('content')?.trim().toLowerCase() ?? '',
            heading: heading?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            headingCount: document.querySelectorAll('h1').length,
            hasMain: document.querySelector('main') !== null,
            overflow: Math.max(html.scrollWidth, document.body.scrollWidth) - window.innerWidth,
            brokenImages: images
              .filter((image) => !image.complete || image.naturalWidth === 0)
              .map((image) => image.currentSrc || image.src),
            invalidLinkCount: invalidLinks.length,
            brokenFragments,
            internalLinks,
            undeclaredFontNames: ['Inter', 'JetBrains Mono'].filter((font) =>
              styles.includes(font),
            ),
            expectedHeading,
          };
        }, expected.heading);

        if (result.language !== 'en') failures.push(`${label}: missing html[lang="en"]`);
        if (!result.title) failures.push(`${label}: missing document title`);
        if (!result.description) failures.push(`${label}: missing meta description`);
        const isNoindex = result.robots
          .split(',')
          .map((value) => value.trim())
          .includes('noindex');
        if (isNoindex !== expected.noindex) {
          failures.push(
            `${label}: expected robots noindex=${expected.noindex}, found "${result.robots || 'none'}"`,
          );
        }
        if (result.headingCount !== 1) {
          failures.push(`${label}: expected one h1, found ${result.headingCount}`);
        }
        if (result.heading !== result.expectedHeading) {
          failures.push(`${label}: unexpected h1 "${result.heading}"`);
        }
        if (!result.hasMain) failures.push(`${label}: missing main landmark`);
        if (result.overflow > 1) {
          failures.push(`${label}: page overflows horizontally by ${Math.ceil(result.overflow)}px`);
        }
        if (result.brokenImages.length > 0) {
          failures.push(`${label}: broken images: ${result.brokenImages.join(', ')}`);
        }
        if (result.invalidLinkCount > 0) {
          failures.push(`${label}: found ${result.invalidLinkCount} empty or unsafe links`);
        }
        if (result.brokenFragments.length > 0) {
          failures.push(`${label}: missing link targets: ${result.brokenFragments.join(', ')}`);
        }
        for (const href of result.internalLinks) {
          const linkResponse = await context.request.get(`${baseUrl}${href}`);
          if (!linkResponse.ok()) {
            failures.push(`${label}: internal link ${href} returned HTTP ${linkResponse.status()}`);
          }
        }
        if (result.undeclaredFontNames.length > 0) {
          failures.push(
            `${label}: references fonts that are not loaded: ${result.undeclaredFontNames.join(', ')}`,
          );
        }
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        if (accessibility.violations.length > 0) {
          await writeFile(
            resolve(artifactRoot, `${artifactName}-axe.json`),
            JSON.stringify(accessibility, null, 2),
          );
          for (const violation of accessibility.violations) {
            failures.push(
              `${label}: axe ${violation.id} (${violation.impact ?? 'unknown'}) on ` +
                `${violation.nodes.length} node(s): ${violation.help}`,
            );
          }
        }
        failures.push(...runtimeErrors.map((error) => `${label}: ${error}`));
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

if (failures.length > 0) {
  throw new Error(
    `landing-site browser QA failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`,
  );
}
console.log(
  `Landing-site browser QA passed (${pages.length * viewports.length} page/viewport checks; ` +
    `artifacts: ${artifactRoot}).`,
);

async function analyzeScreenshot(page, screenshot) {
  const dataUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('could not inspect screenshot pixels');
    context.drawImage(image, 0, 0, size, size);
    const pixels = context.getImageData(0, 0, size, size).data;
    const buckets = new Set();
    let total = 0;
    let totalSquared = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      total += luminance;
      totalSquared += luminance * luminance;
    }
    const count = pixels.length / 4;
    const mean = total / count;
    const deviation = Math.sqrt(Math.max(0, totalSquared / count - mean * mean));
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      distinctBuckets: buckets.size,
      luminanceDeviation: Number(deviation.toFixed(2)),
      nearUniform: buckets.size < 4 || deviation < 1.5,
    };
  }, dataUrl);
}

function serveStatic(requestUrl, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = resolve(staticRoot, `.${pathname}`);
  if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(filePath).pipe(response);
}

function contentType(path) {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}
