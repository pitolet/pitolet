/**
 * Tailwind v4 default scales — the "snap targets" for closest-token matching.
 * A raw value that lands exactly (or within tolerance) on a scale entry emits
 * the standard utility; anything else emits an arbitrary value. Never round
 * beyond tolerance: fidelity beats prettiness.
 */

/** Spacing scale (px). Tailwind: n × 0.25rem. */
export const SPACING_PX: ReadonlyMap<number, string> = new Map(
  [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 80, 96, 112, 128,
    144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 384].map((v) => [v, spacingName(v)]),
);

function spacingName(v: number): string {
  if (v === 1) return 'px';
  const n = v / 4;
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Font sizes (px → Tailwind text-*). */
export const FONT_SIZE_PX: ReadonlyMap<number, string> = new Map([
  [12, 'xs'],
  [14, 'sm'],
  [16, 'base'],
  [18, 'lg'],
  [20, 'xl'],
  [24, '2xl'],
  [30, '3xl'],
  [36, '4xl'],
  [48, '5xl'],
  [60, '6xl'],
  [72, '7xl'],
  [96, '8xl'],
  [128, '9xl'],
]);

/** Border radius (px → rounded-*), Tailwind v4 defaults. */
export const RADIUS_PX: ReadonlyMap<number, string> = new Map([
  [0, 'none'],
  [2, 'xs'],
  [4, 'sm'],
  [6, 'md'],
  [8, 'lg'],
  [12, 'xl'],
  [16, '2xl'],
  [24, '3xl'],
  [9999, 'full'],
]);

export const FONT_WEIGHTS: ReadonlyMap<number, string> = new Map([
  [100, 'thin'],
  [200, 'extralight'],
  [300, 'light'],
  [400, 'normal'],
  [500, 'medium'],
  [600, 'semibold'],
  [700, 'bold'],
  [800, 'extrabold'],
  [900, 'black'],
]);

export const LINE_HEIGHTS: ReadonlyMap<number, string> = new Map([
  [1, 'none'],
  [1.25, 'tight'],
  [1.375, 'snug'],
  [1.5, 'normal'],
  [1.625, 'relaxed'],
  [2, 'loose'],
]);

/** Common width/height fractions (% → w-1/2 etc). */
export const FRACTIONS: ReadonlyMap<number, string> = new Map([
  [25, '1/4'],
  [33.333, '1/3'],
  [50, '1/2'],
  [66.667, '2/3'],
  [75, '3/4'],
  [100, 'full'],
]);

export const OPACITY_STEP = 5;

/** Snap tolerance for spacing-like values, in px. */
export const SPACING_TOLERANCE_PX = 0.5;
/** Perceptual color distance below which we snap to a token (OKLCH ΔE). */
export const COLOR_TOLERANCE = 0.02;
