import { assetUrl } from '../sync/serverBase.js';

const DEFAULT_WIDTHS = [375, 768, 1024, 1280];

/** Keep exported HTML portable while resolving its relative assets in Preview. */
export function resolvePreviewAssetUrls(
  html: string,
  assetIds: string[],
  resolve: (assetId: string) => string = assetUrl,
): string {
  let resolved = html;
  for (const assetId of assetIds) {
    resolved = resolved.split(`assets/${assetId}`).join(resolve(assetId));
  }
  return resolved;
}

export function previewWidthOptions(
  breakpoints: Array<{ minWidth: number }>,
): Array<{ label: string; value: number }> {
  const values = new Set(DEFAULT_WIDTHS);
  for (const breakpoint of breakpoints) values.add(breakpoint.minWidth);
  return [
    { label: 'Fill', value: 0 },
    ...[...values]
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right)
      .map((value) => ({ label: String(value), value })),
  ];
}
