import {
  colorToCss,
  isTokenRef,
  len,
  type Color,
  type Display,
  type Fill,
  type FlexDirection,
  type Length,
  type Shadow,
  type Sides,
  type Size,
  type StyleDecl,
  type StyleValue,
  type Track,
} from '@pitolet/schema';
import {
  FONT_SIZE_PX,
  FONT_WEIGHTS,
  FRACTIONS,
  LINE_HEIGHTS,
  OPACITY_STEP,
  RADIUS_PX,
  SPACING_PX,
  SPACING_TOLERANCE_PX,
} from './scales.js';
import type { TokenMaps } from './tokenMaps.js';

export interface ClassContext {
  maps: TokenMaps;
  parentDisplay?: Display;
  parentDirection?: FlexDirection;
  previousParentDisplay?: Display;
  previousParentDirection?: FlexDirection;
  /**
   * Breakpoint/state override layer. Zero padding/margin is kept (it may reset
   * a base value); on the base layer such zeros are dropped as Tailwind defaults.
   */
  isOverrideLayer?: boolean;
}

/**
 * StyleDecl → Tailwind class list, in a fixed category order (stable diffs).
 * Priority per value: token-bound → token utility; raw matching a document
 * token or the Tailwind scale (within tolerance) → snapped utility; anything
 * else → arbitrary value. Lossless by construction.
 */
export function styleDeclToClasses(s: StyleDecl, ctx: ClassContext): string[] {
  const c: string[] = [];
  const { maps } = ctx;

  // --- display / flex container ---
  if (s.display === 'flex') c.push('flex');
  else if (s.display === 'grid') c.push('grid');
  else if (s.display === 'inline') c.push('inline');
  else if (s.display === 'none') c.push('hidden');
  else if (s.display === 'block') c.push('block');

  const isFlex = s.display === 'flex';
  if (isFlex && s.flexDirection === 'row' && ctx.isOverrideLayer) c.push('flex-row');
  if (isFlex && s.flexDirection === 'column') c.push('flex-col');
  if (isFlex && s.flexDirection === 'row-reverse') c.push('flex-row-reverse');
  if (isFlex && s.flexDirection === 'column-reverse') c.push('flex-col-reverse');
  if (isFlex && s.flexWrap === 'nowrap' && ctx.isOverrideLayer) c.push('flex-nowrap');
  if (isFlex && s.flexWrap === 'wrap') c.push('flex-wrap');
  if (isFlex && s.flexWrap === 'wrap-reverse') c.push('flex-wrap-reverse');
  if (s.alignItems) c.push(`items-${s.alignItems}`);
  if (s.justifyContent) c.push(`justify-${s.justifyContent}`);

  if (s.gap) {
    const row = spacingClass('gap-y', s.gap.row, maps);
    const col = spacingClass('gap-x', s.gap.column, maps);
    if (row === col?.replace('gap-x', 'gap-y')) {
      c.push(row.replace('gap-y', 'gap'));
    } else {
      if (row) c.push(row);
      if (col) c.push(col);
    }
  }

  if (s.gridTemplateColumns) c.push(gridTemplateClass('grid-cols', s.gridTemplateColumns));
  if (s.gridTemplateRows) c.push(gridTemplateClass('grid-rows', s.gridTemplateRows));

  // --- flex/grid child ---
  if (s.alignSelf) c.push(`self-${s.alignSelf}`);
  if (s.flexGrow !== undefined) {
    c.push(s.flexGrow === 1 ? 'grow' : s.flexGrow === 0 ? 'grow-0' : `grow-[${s.flexGrow}]`);
  }
  if (s.gridColumn) c.push(spanClass('col', s.gridColumn));
  if (s.gridRow) c.push(spanClass('row', s.gridRow));

  // --- spacing ---
  if (s.padding) c.push(...sidesClasses('p', s.padding, maps, ctx.isOverrideLayer));
  if (s.margin) c.push(...sidesClasses('m', s.margin, maps, ctx.isOverrideLayer));

  // --- sizing ---
  if (s.width !== undefined) c.push(...sizeClasses('w', s.width, ctx, 'horizontal'));
  if (s.height !== undefined) c.push(...sizeClasses('h', s.height, ctx, 'vertical'));
  if (s.minWidth !== undefined) c.push(minMaxClass('min-w', s.minWidth, maps));
  if (s.maxWidth !== undefined) c.push(minMaxClass('max-w', s.maxWidth, maps));
  if (s.minHeight !== undefined) c.push(minMaxClass('min-h', s.minHeight, maps));
  if (s.maxHeight !== undefined) c.push(minMaxClass('max-h', s.maxHeight, maps));

  // --- position ---
  if (s.position) c.push(s.position);
  if (s.inset) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const value = s.inset[side];
      if (value !== undefined) c.push(spacingClass(side, value, maps, true));
      else if (ctx.isOverrideLayer) c.push(`${side}-auto`);
    }
  }
  if (s.zIndex !== undefined) {
    c.push([0, 10, 20, 30, 40, 50].includes(s.zIndex) ? `z-${s.zIndex}` : `z-[${s.zIndex}]`);
  }

  // --- typography ---
  if (s.fontFamily !== undefined) c.push(fontFamilyClass(s.fontFamily, maps));
  if (s.fontSize !== undefined) c.push(fontSizeClass(s.fontSize, maps));
  if (s.fontWeight !== undefined) c.push(fontWeightClass(s.fontWeight));
  if (s.lineHeight !== undefined) c.push(lineHeightClass(s.lineHeight));
  if (s.letterSpacing !== undefined) {
    const v = resolveRaw(s.letterSpacing, maps);
    if (v) c.push(`tracking-[${len(v)}]`);
  }
  if (s.textAlign) c.push(`text-${s.textAlign}`);
  if (s.color !== undefined) c.push(colorClass('text', s.color, maps));

  // --- appearance ---
  if (s.fills) {
    // An explicitly-empty fills array means "no background" — it must
    // override any base-layer fill when layers merge.
    c.push(...(s.fills.length > 0 ? fillClasses(s.fills, maps) : ['bg-transparent']));
  }
  if (s.border) c.push(...borderClasses(s.border, maps, ctx.isOverrideLayer));
  if (s.radius) c.push(...radiusClasses(s.radius, maps, ctx.isOverrideLayer));
  if (s.shadows) c.push(s.shadows.length > 0 ? shadowClass(s.shadows, maps) : 'shadow-none');

  // --- effects ---
  if (s.opacity !== undefined) {
    const pct = Math.round(s.opacity * 100);
    c.push(pct % OPACITY_STEP === 0 ? `opacity-${pct}` : `opacity-[${s.opacity}]`);
  }
  if (s.blendMode && safeKeyword(s.blendMode)) c.push(`mix-blend-${s.blendMode}`);
  if (s.overflow) c.push(`overflow-${s.overflow}`);
  if (s.cursor && safeKeyword(s.cursor)) c.push(`cursor-${s.cursor}`);
  if (s.objectFit) c.push(`object-${s.objectFit}`);

  return c.filter(Boolean);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveRaw(value: StyleValue<Length>, maps: TokenMaps): Length | null {
  if (isTokenRef(value)) {
    const parts = value.$token.split('.');
    const category = parts[0];
    // Look up the actual token value for raw resolution.
    const token = lookupLengthToken(maps, value.$token);
    if (token) return token;
    void category;
    return null;
  }
  return value;
}

function lookupLengthToken(maps: TokenMaps, path: string): Length | null {
  const t = maps.tokens;
  const parts = path.split('.');
  if (parts[0] === 'spacing') return t.spacing[parts.slice(1).join('.')]?.$value ?? null;
  if (parts[0] === 'radius') return t.radius[parts.slice(1).join('.')]?.$value ?? null;
  if (parts[0] === 'typography' && parts[1] === 'fontSize')
    return t.typography.fontSize[parts.slice(2).join('.')]?.$value ?? null;
  return null;
}

/** spacing-family class: token → `p-4`/`p-gutter`; raw → snap or arbitrary. */
function spacingClass(
  prefix: string,
  value: StyleValue<Length>,
  maps: TokenMaps,
  allowNegative = false,
): string {
  if (isTokenRef(value)) {
    return `${prefix}-${maps.nameForPath(value.$token)}`;
  }
  const { value: v, unit } = value;
  if (unit === 'px') {
    const neg = allowNegative && v < 0;
    const abs = Math.abs(v);
    const snapped = snapPx(abs, SPACING_PX);
    if (snapped !== null) return `${neg ? '-' : ''}${prefix}-${snapped}`;
    // A document spacing token with this exact value?
    const tokenName = maps.spacingTokenFor({ value: abs, unit: 'px' });
    if (tokenName) return `${neg ? '-' : ''}${prefix}-${tokenName}`;
  }
  return `${prefix}-[${len(value)}]`;
}

function snapPx(v: number, scale: ReadonlyMap<number, string>): string | null {
  for (const [px, name] of scale) {
    if (Math.abs(px - v) <= SPACING_TOLERANCE_PX) return name;
  }
  return null;
}

function sidesClasses(
  prefix: string,
  sides: Sides<StyleValue<Length>>,
  maps: TokenMaps,
  isOverrideLayer = false,
): string[] {
  const t = spacingClass(`${prefix}t`, sides.top, maps, prefix === 'm');
  const r = spacingClass(`${prefix}r`, sides.right, maps, prefix === 'm');
  const b = spacingClass(`${prefix}b`, sides.bottom, maps, prefix === 'm');
  const l = spacingClass(`${prefix}l`, sides.left, maps, prefix === 'm');
  const suffix = (cls: string) => cls.slice(cls.indexOf('-'));
  let out: string[];
  if (suffix(t) === suffix(r) && suffix(r) === suffix(b) && suffix(b) === suffix(l)) {
    out = [`${prefix}${suffix(t)}`];
  } else {
    out = [];
    if (suffix(t) === suffix(b)) out.push(`${prefix}y${suffix(t)}`);
    else out.push(t, b);
    if (suffix(l) === suffix(r)) out.push(`${prefix}x${suffix(l)}`);
    else out.push(l, r);
  }
  // On the base layer, `p-0`/`m-0` (any side) is a Tailwind default — drop it.
  // On override layers, keep it (it may reset an inherited-from-base value).
  if (!isOverrideLayer) out = out.filter((cls) => !cls.endsWith('-0'));
  return out;
}

function sizeClasses(
  prefix: 'w' | 'h',
  size: StyleValue<Size>,
  ctx: ClassContext,
  axis: 'horizontal' | 'vertical',
): string[] {
  if (isTokenRef(size)) return [`${prefix}-${ctx.maps.nameForPath(size.$token)}`];
  if (size === 'auto') return [`${prefix}-auto`];
  if (size === 'fill') {
    const currentMain = flexMainAxis(ctx.parentDisplay, ctx.parentDirection);
    const previousMain = flexMainAxis(ctx.previousParentDisplay, ctx.previousParentDirection);
    const fillsMainAxis = axis === currentMain;
    const filledPreviousMainAxis = axis === previousMain;
    const classes = fillsMainAxis
      ? ['flex-1', prefix === 'w' ? 'min-w-0' : 'min-h-0']
      : [`${prefix}-full`];
    if (ctx.isOverrideLayer && currentMain !== previousMain) {
      if (fillsMainAxis && !filledPreviousMainAxis) {
        classes.push(`${prefix}-auto`);
      } else if (!fillsMainAxis && filledPreviousMainAxis) {
        classes.push('flex-initial', prefix === 'w' ? 'min-w-[auto]' : 'min-h-[auto]');
      }
    }
    return classes;
  }
  if (size.unit === '%') {
    for (const [pct, name] of FRACTIONS) {
      if (Math.abs(pct - size.value) < 0.01) return [`${prefix}-${name}`];
    }
  }
  if (size.unit === 'px') {
    const snapped = snapPx(size.value, SPACING_PX);
    if (snapped !== null && snapped !== 'px') return [`${prefix}-${snapped}`];
  }
  return [`${prefix}-[${len(size)}]`];
}

function flexMainAxis(
  display: Display | undefined,
  direction: FlexDirection | undefined,
): 'horizontal' | 'vertical' | undefined {
  if (display !== 'flex') return undefined;
  return direction === 'column' || direction === 'column-reverse' ? 'vertical' : 'horizontal';
}

function minMaxClass(prefix: string, size: StyleValue<Size>, maps: TokenMaps): string {
  if (isTokenRef(size)) return `${prefix}-${maps.nameForPath(size.$token)}`;
  if (size === 'auto') return `${prefix}-auto`;
  if (size === 'fill') return `${prefix}-full`;
  if (size.unit === 'px' && size.value === 0) return `${prefix}-0`;
  return `${prefix}-[${len(size)}]`;
}

function gridTemplateClass(prefix: string, tracks: Track[]): string {
  if (tracks.length === 0) return `${prefix}-none`;
  const allEqualFr = tracks.every((t) => t.kind === 'fr' && t.value === 1);
  if (allEqualFr) return `${prefix}-${tracks.length}`;
  const parts = tracks
    .map((t) => {
      switch (t.kind) {
        case 'fr':
          return `${t.value}fr`;
        case 'px':
          return `${t.value}px`;
        case 'auto':
          return 'auto';
        case 'minmax':
          return `minmax(${t.min}px,${t.max.value}${t.max.kind})`;
      }
    })
    .join('_');
  return `${prefix}-[${parts}]`;
}

function spanClass(axis: 'col' | 'row', value: string): string {
  const m = value.match(/^span (\d+)$/);
  if (m) return `${axis}-span-${m[1]}`;
  if (!/^(?:auto|-?\d+)(?:\s*\/\s*(?:auto|-?\d+|span\s+\d+))?$/.test(value.trim())) {
    return `${axis}-auto`;
  }
  return `${axis}-[${value.trim().replace(/\s+/g, '_')}]`;
}

function fontFamilyClass(family: StyleValue<string>, maps: TokenMaps): string {
  if (isTokenRef(family)) return `font-${maps.nameForPath(family.$token)}`;
  const tokenName = maps.fontFamilyTokenFor(family);
  if (tokenName) return `font-${tokenName}`;
  const safeFamily = family.replace(/[^a-zA-Z0-9 ,_-]/g, '').trim() || 'sans-serif';
  return `font-['${safeFamily.replace(/\s+/g, '_')}']`;
}

function fontSizeClass(size: StyleValue<Length>, maps: TokenMaps): string {
  if (isTokenRef(size)) return `text-${maps.nameForPath(size.$token)}`;
  if (size.unit === 'px') {
    const snapped = snapPx(size.value, FONT_SIZE_PX);
    if (snapped !== null) return `text-${snapped}`;
    const tokenName = maps.fontSizeTokenFor(size);
    if (tokenName) return `text-${tokenName}`;
  }
  return `text-[${len(size)}]`;
}

function fontWeightClass(weight: StyleValue<number>): string {
  const w = isTokenRef(weight) ? null : weight;
  if (w !== null) {
    const named = FONT_WEIGHTS.get(w);
    if (named) return `font-${named}`;
    return `font-[${w}]`;
  }
  return '';
}

function lineHeightClass(lh: StyleValue<number | Length>): string {
  if (isTokenRef(lh)) return '';
  if (typeof lh === 'number') {
    const named = LINE_HEIGHTS.get(lh);
    return named ? `leading-${named}` : `leading-[${lh}]`;
  }
  return `leading-[${len(lh)}]`;
}

function colorClass(prefix: string, color: StyleValue<Color>, maps: TokenMaps): string {
  if (isTokenRef(color)) return `${prefix}-${maps.nameForPath(color.$token)}`;
  const tokenName = maps.colorTokenFor(color);
  if (tokenName) return `${prefix}-${tokenName}`;
  return `${prefix}-[${colorToCss(color).replace(/\s+/g, '_')}]`;
}

function fillClasses(fills: Fill[], maps: TokenMaps): string[] {
  if (fills.length === 1 && fills[0]!.type === 'solid') {
    return [colorClass('bg', fills[0]!.color, maps)];
  }
  // Layered/gradient fills → one arbitrary background-image (bottom fill last).
  const layers = [...fills].reverse().map((fill) => fillLayerCss(fill, maps));
  return [`bg-[image:${layers.join(',').replace(/\s+/g, '_')}]`];
}

function fillLayerCss(fill: Fill, maps: TokenMaps): string {
  const color = (c: StyleValue<Color>): string =>
    isTokenRef(c) ? `var(--color-${maps.nameForPath(c.$token)})` : colorToCss(c);
  switch (fill.type) {
    case 'solid': {
      const v = color(fill.color);
      return `linear-gradient(${v}, ${v})`;
    }
    case 'linear':
      return `linear-gradient(${fill.angle}deg, ${fill.stops
        .map((s) => `${color(s.color)} ${round(s.position * 100)}%`)
        .join(', ')})`;
    case 'radial':
      return `radial-gradient(circle, ${fill.stops
        .map((s) => `${color(s.color)} ${round(s.position * 100)}%`)
        .join(', ')})`;
  }
}

function borderClasses(
  border: NonNullable<StyleDecl['border']>,
  maps: TokenMaps,
  isOverrideLayer = false,
): string[] {
  const out: string[] = [];
  const width = isTokenRef(border.width) ? null : border.width;
  const widthSuffix =
    width === null
      ? ''
      : width.unit === 'px' && [0, 2, 4, 8].includes(width.value)
        ? width.value === 0
          ? '-0'
          : `-${width.value}`
        : width.unit === 'px' && width.value === 1
          ? ''
          : `-[${len(width)}]`;

  const sides = border.sides;
  if (!sides) {
    out.push(`border${widthSuffix}`);
  } else {
    for (const [side, short] of [
      ['top', 't'],
      ['right', 'r'],
      ['bottom', 'b'],
      ['left', 'l'],
    ] as const) {
      if (sides[side]) out.push(`border-${short}${widthSuffix}`);
      else if (isOverrideLayer) out.push(`border-${short}-0`);
    }
  }
  if (border.style !== 'solid' || isOverrideLayer) out.push(`border-${border.style}`);
  out.push(colorClass('border', border.color, maps));
  return out;
}

function radiusClasses(
  radius: NonNullable<StyleDecl['radius']>,
  maps: TokenMaps,
  isOverrideLayer = false,
): string[] {
  const corner = (v: StyleValue<Length>): string => {
    if (isTokenRef(v)) return maps.nameForPath(v.$token);
    if (v.unit === 'px') {
      const named = RADIUS_PX.get(v.value);
      if (named) return named;
      const tokenName = maps.radiusTokenFor(v);
      if (tokenName) return tokenName;
    }
    return `[${len(v)}]`;
  };
  const tl = corner(radius.tl);
  const tr = corner(radius.tr);
  const br = corner(radius.br);
  const bl = corner(radius.bl);
  const cls = (name: string) => (name === 'none' ? '' : name.startsWith('[') ? name : `-${name}`);
  if (tl === tr && tr === br && br === bl) {
    if (tl === 'none') return isOverrideLayer ? ['rounded-none'] : [];
    return [tl.startsWith('[') ? `rounded-${tl}` : `rounded${cls(tl)}`];
  }
  const out: string[] = [];
  for (const [name, value] of [
    ['tl', tl],
    ['tr', tr],
    ['br', br],
    ['bl', bl],
  ] as const) {
    if (value === 'none') {
      if (isOverrideLayer) out.push(`rounded-${name}-none`);
    } else {
      out.push(value.startsWith('[') ? `rounded-${name}-${value}` : `rounded-${name}${cls(value)}`);
    }
  }
  return out;
}

function shadowClass(shadows: Shadow[], maps: TokenMaps): string {
  const tokenName = maps.shadowTokenFor(shadows);
  if (tokenName) return `shadow-${tokenName}`;
  const css = shadows
    .map((sh) => {
      const color = isTokenRef(sh.color)
        ? `var(--color-${maps.nameForPath(sh.color.$token)})`
        : colorToCss(sh.color);
      return `${sh.inset ? 'inset ' : ''}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${color}`;
    })
    .join(',');
  return `shadow-[${css.replace(/\s+/g, '_')}]`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeKeyword(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value);
}
