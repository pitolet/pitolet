import { formatHex8, formatHex, oklch as toOklch, parse, differenceEuclidean } from 'culori';
import type { Color } from './styles.js';

/** Construct an OKLCH color. */
export function oklch(l: number, c: number, h: number, alpha?: number): Color {
  return alpha === undefined || alpha === 1 ? { space: 'oklch', l, c, h } : { space: 'oklch', l, c, h, alpha };
}

/** Serialize to a CSS `oklch()` string (the canonical CSS output everywhere). */
export function colorToCss(color: Color): string {
  const l = round(color.l, 4);
  const c = round(color.c, 4);
  const h = round(color.h, 2);
  const a = color.alpha;
  return a === undefined || a >= 1 ? `oklch(${l} ${c} ${h})` : `oklch(${l} ${c} ${h} / ${round(a, 3)})`;
}

/** Parse any CSS color string (hex, rgb, oklch, named…) into an OKLCH Color. */
export function parseColor(input: string): Color | null {
  const parsed = parse(input);
  if (!parsed) return null;
  const c = toOklch(parsed);
  if (!c) return null;
  return oklch(c.l ?? 0, c.c ?? 0, Number.isNaN(c.h) || c.h === undefined ? 0 : c.h, c.alpha);
}

/** Hex representation for display/input fields (with alpha only when needed). */
export function colorToHex(color: Color): string {
  const culoriColor = { mode: 'oklch' as const, l: color.l, c: color.c, h: color.h, alpha: color.alpha };
  return color.alpha !== undefined && color.alpha < 1 ? formatHex8(culoriColor) : formatHex(culoriColor);
}

/** Perceptual distance in OKLCH space — used for closest-token matching in codegen. */
export function colorDistance(a: Color, b: Color): number {
  const diff = differenceEuclidean('oklch');
  return diff(
    { mode: 'oklch', l: a.l, c: a.c, h: a.h, alpha: a.alpha ?? 1 },
    { mode: 'oklch', l: b.l, c: b.c, h: b.h, alpha: b.alpha ?? 1 },
  );
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
