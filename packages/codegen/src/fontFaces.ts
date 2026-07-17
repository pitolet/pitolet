import type { Asset } from '@pitolet/schema';
import { escapeCssString, safeCssValue } from './safety.js';

const FONT_MIME_FORMAT: Record<string, string> = {
  'font/woff': 'woff',
  'font/woff2': 'woff2',
};

/**
 * Local font declarations carried by imported document assets. Descriptors
 * are allowlisted because captured styles are untrusted source-page data and
 * these rules are also embedded in preview <style> elements.
 */
export function importedFontFaceCss(
  assets: Record<string, Asset>,
  assetUrl: (assetId: string) => string = (assetId) => `assets/${assetId}`,
): string {
  const rules: string[] = [];
  for (const [assetId, asset] of Object.entries(assets)) {
    const format = FONT_MIME_FORMAT[asset.mime];
    const face = asset.fontFace;
    if (!format || !face) continue;
    const family = safeCssValue(face.family.trim());
    if (typeof family !== 'string' || family.length === 0) continue;

    const style = /^(normal|italic|oblique(?:\s+-?\d+(?:\.\d+)?deg)?)$/i.test(
      face.style?.trim() ?? '',
    )
      ? face.style!.trim().toLowerCase()
      : 'normal';
    const weight = /^(normal|bold|[1-9]00|[1-9]00\s+[1-9]00)$/i.test(face.weight?.trim() ?? '')
      ? face.weight!.trim().toLowerCase()
      : 'normal';
    const display = /^(auto|block|swap|fallback|optional)$/i.test(face.display?.trim() ?? '')
      ? face.display!.trim().toLowerCase()
      : 'swap';
    const url = assetUrl(assetId);
    if (!/^(?:\.{0,2}\/|assets\/|\/)[A-Za-z0-9_./-]+$/.test(url)) continue;

    rules.push(
      `@font-face {\n` +
        `  font-family: '${escapeCssString(family)}';\n` +
        `  src: url('${escapeCssString(url)}') format('${format}');\n` +
        `  font-style: ${style};\n` +
        `  font-weight: ${weight};\n` +
        `  font-display: ${display};\n` +
        `}`,
    );
  }
  return rules.join('\n\n');
}

export function importedFontFamilies(assets: Record<string, Asset>): Set<string> {
  return new Set(
    Object.values(assets)
      .filter((asset) => Boolean(FONT_MIME_FORMAT[asset.mime]))
      .map((asset) => asset.fontFace?.family.trim())
      .filter((family): family is string => Boolean(family)),
  );
}
