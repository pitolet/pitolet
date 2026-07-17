import {
  colorToCss,
  len,
  type Asset,
  type Breakpoint,
  type Shadow,
  type TokenSet,
} from '@pitolet/schema';
import { isTokenRef } from '@pitolet/schema';
import { importedFontFaceCss, importedFontFamilies } from './fontFaces.js';
import { TokenMaps } from './tokenMaps.js';
import { breakpointVariantNames, escapeCssString, safeCssValue } from './safety.js';

/**
 * TokenSet → theme.css. Tailwind v4 is CSS-first: design tokens become
 * `@theme` variables, which automatically drive utilities like `bg-primary`,
 * `p-gutter`, `rounded-md`, `text-lg`, `font-sans`, `shadow-md`.
 */
const SYSTEM_FAMILIES = new Set([
  'system-ui',
  'Arial',
  'Helvetica',
  'Helvetica Neue',
  'Georgia',
  'Times New Roman',
  'Menlo',
  'Monaco',
  'Courier New',
  'sans-serif',
  'serif',
  'monospace',
]);

const TAILWIND_DEFAULT_BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
};

export function generateThemeCss(
  tokens: TokenSet,
  breakpoints: Breakpoint[] = [],
  assets: Record<string, Asset> = {},
): string {
  const lines: string[] = [];
  const maps = new TokenMaps(tokens);
  const breakpointNames = breakpointVariantNames(breakpoints);
  const localFamilies = importedFontFamilies(assets);
  // Web fonts first (CSS requires @import before other rules).
  for (const token of Object.values(tokens.typography.fontFamily)) {
    const family = token.$value;
    if (SYSTEM_FAMILIES.has(family) || family.includes(',') || localFamilies.has(family)) continue;
    const encoded = encodeURIComponent(family).replace(/%20/g, '+');
    lines.push(
      `@import url('https://fonts.googleapis.com/css2?family=${encoded}:wght@100..900&display=swap');`,
    );
  }
  lines.push(`@import 'tailwindcss';`);
  const localFaces = importedFontFaceCss(assets);
  if (localFaces) lines.push('', localFaces);
  lines.push('');
  lines.push('@theme {');

  for (const [name, token] of Object.entries(tokens.color)) {
    lines.push(`  --color-${maps.nameForPath(`color.${name}`)}: ${colorToCss(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.spacing)) {
    lines.push(`  --spacing-${maps.nameForPath(`spacing.${name}`)}: ${len(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.radius)) {
    lines.push(`  --radius-${maps.nameForPath(`radius.${name}`)}: ${len(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.shadow)) {
    lines.push(`  --shadow-${maps.nameForPath(`shadow.${name}`)}: ${shadowCss(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.typography.fontFamily)) {
    lines.push(
      `  --font-${maps.nameForPath(`typography.fontFamily.${name}`)}: '${escapeCssString(token.$value)}', system-ui, sans-serif;`,
    );
  }
  for (const [name, token] of Object.entries(tokens.typography.fontSize)) {
    lines.push(
      `  --text-${maps.nameForPath(`typography.fontSize.${name}`)}: ${len(token.$value)};`,
    );
  }
  for (const breakpoint of breakpoints) {
    if (TAILWIND_DEFAULT_BREAKPOINTS[breakpoint.id] === breakpoint.minWidth) continue;
    lines.push(
      `  --breakpoint-${breakpointNames.get(breakpoint.id)}: ${round(breakpoint.minWidth / 16)}rem;`,
    );
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function shadowCss(shadows: Shadow[]): string {
  return shadows
    .map((sh) => {
      const color = isTokenRef(sh.color) ? 'currentColor' : colorToCss(sh.color);
      return `${sh.inset ? 'inset ' : ''}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${color}`;
    })
    .map((value) => safeCssValue(value))
    .filter((value): value is string => typeof value === 'string')
    .join(', ');
}
