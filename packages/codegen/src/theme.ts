import { colorToCss, len, type Breakpoint, type Shadow, type TokenSet } from '@pitolet/schema';
import { isTokenRef } from '@pitolet/schema';
import { sanitizeTokenName } from './tokenMaps.js';

/**
 * TokenSet → theme.css. Tailwind v4 is CSS-first: design tokens become
 * `@theme` variables, which automatically drive utilities like `bg-primary`,
 * `p-gutter`, `rounded-md`, `text-lg`, `font-sans`, `shadow-md`.
 */
const SYSTEM_FAMILIES = new Set([
  'system-ui', 'Arial', 'Helvetica', 'Helvetica Neue', 'Georgia', 'Times New Roman',
  'Menlo', 'Monaco', 'Courier New', 'sans-serif', 'serif', 'monospace',
]);

const TAILWIND_DEFAULT_BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
};

export function generateThemeCss(tokens: TokenSet, breakpoints: Breakpoint[] = []): string {
  const lines: string[] = [];
  // Web fonts first (CSS requires @import before other rules).
  for (const token of Object.values(tokens.typography.fontFamily)) {
    const family = token.$value;
    if (SYSTEM_FAMILIES.has(family) || family.includes(',')) continue;
    const encoded = family.replace(/ /g, '+');
    lines.push(
      `@import url('https://fonts.googleapis.com/css2?family=${encoded}:wght@100..900&display=swap');`,
    );
  }
  lines.push(`@import 'tailwindcss';`);
  lines.push('');
  lines.push('@theme {');

  for (const [name, token] of Object.entries(tokens.color)) {
    lines.push(`  --color-${sanitizeTokenName(name)}: ${colorToCss(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.spacing)) {
    lines.push(`  --spacing-${sanitizeTokenName(name)}: ${len(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.radius)) {
    lines.push(`  --radius-${sanitizeTokenName(name)}: ${len(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.shadow)) {
    lines.push(`  --shadow-${sanitizeTokenName(name)}: ${shadowCss(token.$value)};`);
  }
  for (const [name, token] of Object.entries(tokens.typography.fontFamily)) {
    lines.push(
      `  --font-${sanitizeTokenName(name)}: '${token.$value}', system-ui, sans-serif;`,
    );
  }
  for (const [name, token] of Object.entries(tokens.typography.fontSize)) {
    lines.push(`  --text-${sanitizeTokenName(name)}: ${len(token.$value)};`);
  }
  for (const breakpoint of breakpoints) {
    if (TAILWIND_DEFAULT_BREAKPOINTS[breakpoint.id] === breakpoint.minWidth) continue;
    lines.push(
      `  --breakpoint-${sanitizeTokenName(breakpoint.id)}: ${round(breakpoint.minWidth / 16)}rem;`,
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
    .join(', ');
}
