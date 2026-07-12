import { buildPreviewHtml } from '@pitolet/codegen';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { assetIdFor } from './convert.js';
import type { ImportConversion, SimilarityResult, WebCapture } from './types.js';

export async function verifyImport(
  capture: WebCapture,
  conversion: ImportConversion,
  reportDir: string,
): Promise<SimilarityResult[]> {
  mkdirSync(reportDir, { recursive: true });
  const frameId = conversion.document.rootOrder[0];
  if (!frameId) return [];
  let html = buildPreviewHtml(conversion.document, frameId);
  for (const asset of capture.assets) {
    const assetId = assetIdFor(asset.data, asset.mime);
    const dataUrl = `data:${asset.mime};base64,${asset.data.toString('base64')}`;
    html = html.split(`assets/${assetId}`).join(dataUrl);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const results: SimilarityResult[] = [];
    for (const snapshot of capture.snapshots) {
      const page = await browser.newPage({
        viewport: { width: snapshot.width, height: snapshot.height },
      });
      await page.setContent(html, { waitUntil: 'networkidle' });
      const root = page.locator('body > *');
      const imported = Buffer.from(
        (await root.count()) === 1
          ? await root.screenshot({ type: 'png' })
          : await page.screenshot({ type: 'png', fullPage: true }),
      );
      const comparison = await compareImages(page, snapshot.screenshot, imported);

      const sourcePath = join(reportDir, `source-${snapshot.width}.png`);
      const importedPath = join(reportDir, `imported-${snapshot.width}.png`);
      const differencePath = join(reportDir, `difference-${snapshot.width}.png`);
      writeFileSync(sourcePath, snapshot.screenshot);
      writeFileSync(importedPath, imported);
      writeFileSync(differencePath, comparison.difference);
      results.push({
        width: snapshot.width,
        score: comparison.score,
        sourcePath,
        importedPath,
        differencePath,
      });
      await page.close();
    }
    return results;
  } finally {
    await browser.close();
  }
}

async function compareImages(
  page: import('playwright-core').Page,
  source: Buffer,
  imported: Buffer,
): Promise<{ score: number; difference: Buffer }> {
  const result = await page.evaluate(
    async ({ sourceUrl, importedUrl }) => {
      const g = globalThis as unknown as {
        document: any;
        Image: new () => any;
      };
      const load = (url: string): Promise<any> =>
        new Promise((resolve, reject) => {
          const image = new g.Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('image decode failed'));
          image.src = url;
        });
      const [a, b] = await Promise.all([load(sourceUrl), load(importedUrl)]);
      const width = Math.max(a.width, b.width);
      const height = Math.max(a.height, b.height);
      const makeCanvas = () => {
        const canvas = g.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        return { canvas, context };
      };
      const ca = makeCanvas();
      const cb = makeCanvas();
      const cd = makeCanvas();
      ca.context.drawImage(a, 0, 0);
      cb.context.drawImage(b, 0, 0);
      const ad = ca.context.getImageData(0, 0, width, height);
      const bd = cb.context.getImageData(0, 0, width, height);
      const dd = cd.context.createImageData(width, height);
      let weightedDifference = 0;
      for (let i = 0; i < ad.data.length; i += 4) {
        const dr = Math.abs(ad.data[i] - bd.data[i]);
        const dg = Math.abs(ad.data[i + 1] - bd.data[i + 1]);
        const db = Math.abs(ad.data[i + 2] - bd.data[i + 2]);
        weightedDifference += dr * 0.2126 + dg * 0.7152 + db * 0.0722;
        dd.data[i] = Math.min(255, dr * 3);
        dd.data[i + 1] = Math.min(255, dg * 3);
        dd.data[i + 2] = Math.min(255, db * 3);
        dd.data[i + 3] = 255;
      }
      cd.context.putImageData(dd, 0, 0);
      const pixels = Math.max(1, width * height);
      return {
        score: Math.max(0, Math.min(1, 1 - weightedDifference / (pixels * 255))),
        differenceUrl: cd.canvas.toDataURL('image/png'),
      };
    },
    {
      sourceUrl: `data:image/png;base64,${source.toString('base64')}`,
      importedUrl: `data:image/png;base64,${imported.toString('base64')}`,
    },
  );
  return {
    score: Math.round(result.score * 10_000) / 10_000,
    difference: Buffer.from(result.differenceUrl.split(',')[1]!, 'base64'),
  };
}
