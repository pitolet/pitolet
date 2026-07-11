import { parseColor } from './color.js';
import type { Color, Length, Shadow } from './styles.js';
import type { TokenSet } from './tokens.js';

/**
 * Import design tokens from CSS custom properties — Tailwind v4 `@theme`
 * blocks or plain `:root` variables. Recognized prefixes:
 *
 *   --color-*    → color tokens (any CSS color format)
 *   --spacing-*  → spacing (px / rem)
 *   --radius-*   → radius  (px / rem)
 *   --shadow-*   → shadows (box-shadow lists)
 *   --font-*     → font families
 *   --text-*     → font sizes (px / rem)
 *
 * Unparseable values are skipped and reported, never guessed.
 */

export interface ParsedTokens {
  color: Record<string, Color>;
  spacing: Record<string, Length>;
  radius: Record<string, Length>;
  shadow: Record<string, Shadow[]>;
  fontFamily: Record<string, string>;
  fontSize: Record<string, Length>;
}

export interface ParseTokensResult {
  tokens: ParsedTokens;
  /** Declarations in a recognized category whose values could not be parsed. */
  skipped: string[];
  /** Total imported token count. */
  count: number;
}

export function parseCssTokens(css: string): ParseTokensResult {
  const tokens: ParsedTokens = {
    color: {},
    spacing: {},
    radius: {},
    shadow: {},
    fontFamily: {},
    fontSize: {},
  };
  const skipped: string[] = [];

  const source = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  const declaration = /--([a-zA-Z0-9][\w-]*)\s*:\s*([^;{}]+)[;}]/g;

  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const name = match[1]!;
    const value = match[2]!.trim();
    if (value.startsWith('var(')) continue; // references can't resolve here

    if (name.startsWith('color-')) {
      const key = name.slice('color-'.length);
      const color = parseColor(value);
      if (color) tokens.color[key] = color;
      else skipped.push(`--${name}: ${value}`);
    } else if (name.startsWith('spacing-')) {
      route(name, 'spacing-', value, tokens.spacing, skipped);
    } else if (name.startsWith('radius-')) {
      route(name, 'radius-', value, tokens.radius, skipped);
    } else if (name.startsWith('shadow-')) {
      const key = name.slice('shadow-'.length);
      const shadows = parseBoxShadow(value);
      if (shadows) tokens.shadow[key] = shadows;
      else skipped.push(`--${name}: ${value}`);
    } else if (name.startsWith('font-')) {
      const key = name.slice('font-'.length);
      const family = parseFontFamily(value);
      if (family) tokens.fontFamily[key] = family;
      else skipped.push(`--${name}: ${value}`);
    } else if (name.startsWith('text-') && !name.includes('--')) {
      // Tailwind v4 sub-keys like --text-lg--line-height are skipped by the
      // double-dash guard above.
      const key = name.slice('text-'.length);
      const length = parseLength(value);
      if (length) tokens.fontSize[key] = length;
      else skipped.push(`--${name}: ${value}`);
    }
  }

  const count =
    Object.keys(tokens.color).length +
    Object.keys(tokens.spacing).length +
    Object.keys(tokens.radius).length +
    Object.keys(tokens.shadow).length +
    Object.keys(tokens.fontFamily).length +
    Object.keys(tokens.fontSize).length;

  return { tokens, skipped, count };
}

/** Merge parsed tokens into a TokenSet (draft-safe; overwrites same names). */
export function mergeParsedTokens(target: TokenSet, parsed: ParsedTokens): void {
  for (const [key, value] of Object.entries(parsed.color)) {
    target.color[key] = { $value: value };
  }
  for (const [key, value] of Object.entries(parsed.spacing)) {
    target.spacing[key] = { $value: value };
  }
  for (const [key, value] of Object.entries(parsed.radius)) {
    target.radius[key] = { $value: value };
  }
  for (const [key, value] of Object.entries(parsed.shadow)) {
    target.shadow[key] = { $value: value };
  }
  for (const [key, value] of Object.entries(parsed.fontFamily)) {
    target.typography.fontFamily[key] = { $value: value };
  }
  for (const [key, value] of Object.entries(parsed.fontSize)) {
    target.typography.fontSize[key] = { $value: value };
  }
}

// ---------------------------------------------------------------------------

function route(
  name: string,
  prefix: string,
  value: string,
  bucket: Record<string, Length>,
  skipped: string[],
): void {
  const key = name.slice(prefix.length);
  const length = parseLength(value);
  if (length) bucket[key] = length;
  else skipped.push(`--${name}: ${value}`);
}

function parseLength(value: string): Length | null {
  const match = value.trim().match(/^(-?\d*\.?\d+)(px|rem|em)?$/);
  if (!match) return null;
  const number = Number.parseFloat(match[1]!);
  if (!Number.isFinite(number)) return null;
  const unit = match[2];
  if (unit === 'rem' || unit === 'em') return { value: round(number * 16), unit: 'px' };
  if (unit === 'px' || (unit === undefined && number === 0)) {
    return { value: round(number), unit: 'px' };
  }
  if (unit === undefined) return null; // bare non-zero numbers are ambiguous
  return null;
}

function parseFontFamily(value: string): string | null {
  const first = value.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  return first && first.length > 0 ? first : null;
}

/**
 * Parse a box-shadow list: per layer `[inset] x y [blur [spread]] color`.
 * Lengths are extracted positionally; whatever remains is the color.
 */
function parseBoxShadow(value: string): Shadow[] | null {
  if (value === 'none') return [];
  const layers = splitTopLevel(value, ',');
  const shadows: Shadow[] = [];
  for (const layer of layers) {
    let rest = layer.trim();
    if (!rest) continue;
    const inset = /(^|\s)inset(\s|$)/.test(rest);
    rest = rest.replace(/(^|\s)inset(\s|$)/, ' ').trim();

    const lengthPattern = /(-?\d*\.?\d+)(px|rem|em)?(?=\s|$)/g;
    const lengths: number[] = [];
    let colorPart = rest;
    let lengthMatch: RegExpExecArray | null;
    let consumedUpTo = 0;
    while (lengths.length < 4 && (lengthMatch = lengthPattern.exec(rest)) !== null) {
      // Lengths must be leading tokens — stop once we hit the color.
      if (rest.slice(consumedUpTo, lengthMatch.index).trim() !== '') break;
      const raw = Number.parseFloat(lengthMatch[1]!);
      const unit = lengthMatch[2];
      lengths.push(unit === 'rem' || unit === 'em' ? round(raw * 16) : round(raw));
      consumedUpTo = lengthMatch.index + lengthMatch[0].length;
    }
    colorPart = rest.slice(consumedUpTo).trim();
    if (lengths.length < 2) return null;

    const color = colorPart ? parseColor(colorPart) : parseColor('rgba(0,0,0,0.1)');
    if (!color) return null;

    shadows.push({
      x: lengths[0]!,
      y: lengths[1]!,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color,
      ...(inset ? { inset: true as const } : {}),
    });
  }
  return shadows.length > 0 ? shadows : null;
}

/** Split on a separator, ignoring separators inside parentheses. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
