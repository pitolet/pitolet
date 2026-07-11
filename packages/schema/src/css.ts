import { colorToCss } from './color.js';
import type {
  Color,
  Display,
  Fill,
  FlexDirection,
  Length,
  Shadow,
  Size,
  StyleDecl,
  Track,
} from './styles.js';

/**
 * StyleDecl → CSS properties. THE single source of CSS truth: the editor
 * canvas renders with these exact properties (as a React style object) and
 * the HTML/CSS code generator serializes the same output — so editor pixels
 * and shipped pixels cannot drift.
 *
 * Input must be token-resolved (see resolve.ts). Keys are camelCase
 * (React-style); codegen kebab-cases them for stylesheet output.
 */

export type CssProps = Record<string, string | number>;

export interface CssContext {
  /** Layout context of the parent — needed to translate `fill` sizing. */
  parentDisplay?: Display;
  parentDirection?: FlexDirection;
}

export function styleToCssProps(s: StyleDecl, ctx: CssContext = {}): CssProps {
  const css: CssProps = {};

  // --- Layout (container) ---
  if (s.display !== undefined) css.display = s.display;
  const isFlex = s.display === 'flex';
  if (s.flexDirection && isFlex) css.flexDirection = s.flexDirection;
  if (s.flexWrap && isFlex) css.flexWrap = s.flexWrap;
  if (s.alignItems) css.alignItems = alignValue(s.alignItems, isFlex);
  if (s.justifyContent) css.justifyContent = justifyValue(s.justifyContent, isFlex);
  if (s.gap) {
    const row = len(s.gap.row as Length);
    const col = len(s.gap.column as Length);
    css.gap = row === col ? row : `${row} ${col}`;
  }
  if (s.gridTemplateColumns) css.gridTemplateColumns = tracks(s.gridTemplateColumns);
  if (s.gridTemplateRows) css.gridTemplateRows = tracks(s.gridTemplateRows);

  // --- Layout (child) ---
  if (s.alignSelf) css.alignSelf = alignValue(s.alignSelf, ctx.parentDisplay === 'flex');
  if (s.flexGrow !== undefined) css.flexGrow = s.flexGrow;
  if (s.gridColumn) css.gridColumn = s.gridColumn;
  if (s.gridRow) css.gridRow = s.gridRow;

  // --- Box ---
  if (s.padding) {
    css.paddingTop = len(s.padding.top as Length);
    css.paddingRight = len(s.padding.right as Length);
    css.paddingBottom = len(s.padding.bottom as Length);
    css.paddingLeft = len(s.padding.left as Length);
  }
  if (s.margin) {
    css.marginTop = len(s.margin.top as Length);
    css.marginRight = len(s.margin.right as Length);
    css.marginBottom = len(s.margin.bottom as Length);
    css.marginLeft = len(s.margin.left as Length);
  }
  applySize(css, 'width', s.width as Size | undefined, ctx, 'horizontal');
  applySize(css, 'height', s.height as Size | undefined, ctx, 'vertical');
  if (s.minWidth !== undefined) css.minWidth = sizeValue(s.minWidth as Size);
  if (s.maxWidth !== undefined) css.maxWidth = sizeValue(s.maxWidth as Size);
  if (s.minHeight !== undefined) css.minHeight = sizeValue(s.minHeight as Size);
  if (s.maxHeight !== undefined) css.maxHeight = sizeValue(s.maxHeight as Size);

  // --- Position ---
  if (s.position) css.position = s.position;
  if (s.inset) {
    if (s.inset.top !== undefined) css.top = len(s.inset.top as Length);
    if (s.inset.right !== undefined) css.right = len(s.inset.right as Length);
    if (s.inset.bottom !== undefined) css.bottom = len(s.inset.bottom as Length);
    if (s.inset.left !== undefined) css.left = len(s.inset.left as Length);
  }
  if (s.zIndex !== undefined) css.zIndex = s.zIndex;

  // --- Typography ---
  if (s.fontFamily !== undefined) css.fontFamily = fontStack(s.fontFamily as string);
  if (s.fontSize !== undefined) css.fontSize = len(s.fontSize as Length);
  if (s.fontWeight !== undefined) css.fontWeight = s.fontWeight as number;
  if (s.lineHeight !== undefined) {
    const lh = s.lineHeight as number | Length;
    css.lineHeight = typeof lh === 'number' ? lh : len(lh);
  }
  if (s.letterSpacing !== undefined) css.letterSpacing = len(s.letterSpacing as Length);
  if (s.textAlign) css.textAlign = s.textAlign;
  if (s.color !== undefined) css.color = colorToCss(s.color as Color);

  // --- Appearance ---
  if (s.fills && s.fills.length > 0) applyFills(css, s.fills);
  if (s.border) {
    const b = s.border;
    const value = `${len(b.width as Length)} ${b.style} ${colorToCss(b.color as Color)}`;
    const bs = b.sides;
    if (!bs) {
      css.border = value;
    } else {
      if (bs.top) css.borderTop = value;
      if (bs.right) css.borderRight = value;
      if (bs.bottom) css.borderBottom = value;
      if (bs.left) css.borderLeft = value;
    }
  }
  if (s.radius) {
    const { tl, tr, br, bl } = s.radius;
    const parts = [tl, tr, br, bl].map((r) => len(r as Length));
    css.borderRadius = parts.every((p) => p === parts[0]) ? parts[0]! : parts.join(' ');
  }
  if (s.shadows && s.shadows.length > 0) {
    css.boxShadow = s.shadows.map(shadowValue).join(', ');
  }

  // --- Effects & misc ---
  if (s.opacity !== undefined) css.opacity = s.opacity;
  if (s.blendMode) css.mixBlendMode = s.blendMode;
  if (s.overflow) css.overflow = s.overflow;
  if (s.cursor) css.cursor = s.cursor;
  if (s.objectFit) css.objectFit = s.objectFit;

  return css;
}

// ---------------------------------------------------------------------------

export function len(l: Length): string {
  return `${trim(l.value)}${l.unit}`;
}

function sizeValue(size: Size): string {
  if (size === 'auto') return 'auto';
  if (size === 'fill') return '100%';
  return len(size);
}

/**
 * `fill` sizing translates by layout context:
 *  - along a flex parent's main axis  → flex: 1 1 0 (share space)
 *  - along a flex parent's cross axis → 100% on that axis
 *  - otherwise                        → 100%
 *
 * Cross-axis fill must be an explicit size rather than `align-self: stretch`.
 * Stretch overrides the parent's alignment, and a max-width/max-height can
 * then clamp the item while leaving it stuck at the cross-start edge. A 100%
 * preferred size still fills the parent, but lets the parent's alignment (or
 * an explicit align-self) position the item when a min/max constraint wins.
 */
function applySize(
  css: CssProps,
  prop: 'width' | 'height',
  size: Size | undefined,
  ctx: CssContext,
  axis: 'horizontal' | 'vertical',
): void {
  if (size === undefined) return;
  if (size !== 'fill') {
    css[prop] = sizeValue(size);
    return;
  }
  if (ctx.parentDisplay === 'flex') {
    const mainAxis = (ctx.parentDirection ?? 'row') === 'row' ? 'horizontal' : 'vertical';
    if (axis === mainAxis) {
      css.flexGrow = 1;
      css.flexShrink = 1;
      css.flexBasis = '0%';
      css[axis === 'horizontal' ? 'minWidth' : 'minHeight'] =
        css[axis === 'horizontal' ? 'minWidth' : 'minHeight'] ?? 0;
    } else {
      css[prop] = '100%';
    }
    return;
  }
  css[prop] = '100%';
}

function alignValue(v: string, isFlex: boolean): string {
  if (v === 'start') return isFlex ? 'flex-start' : 'start';
  if (v === 'end') return isFlex ? 'flex-end' : 'end';
  return v;
}

function justifyValue(v: string, isFlex: boolean): string {
  switch (v) {
    case 'start':
      return isFlex ? 'flex-start' : 'start';
    case 'end':
      return isFlex ? 'flex-end' : 'end';
    case 'between':
      return 'space-between';
    case 'around':
      return 'space-around';
    case 'evenly':
      return 'space-evenly';
    default:
      return v;
  }
}

function tracks(list: Track[]): string {
  return list
    .map((t) => {
      switch (t.kind) {
        case 'fr':
          return `${trim(t.value)}fr`;
        case 'px':
          return `${trim(t.value)}px`;
        case 'auto':
          return 'auto';
        case 'minmax':
          return `minmax(${trim(t.min)}px, ${trim(t.max.value)}${t.max.kind})`;
      }
    })
    .join(' ');
}

/**
 * fills[0] is the bottom-most layer. CSS paints the FIRST background-image
 * layer on top, so layers are emitted in reverse. A single solid fill uses
 * background-color; any layered composition converts solids to gradients.
 */
function applyFills(css: CssProps, fills: Fill[]): void {
  if (fills.length === 1 && fills[0]!.type === 'solid') {
    css.backgroundColor = colorToCss(fills[0]!.color as Color);
    return;
  }
  const layers = [...fills].reverse().map(fillLayer);
  css.backgroundImage = layers.join(', ');
}

function fillLayer(fill: Fill): string {
  switch (fill.type) {
    case 'solid': {
      const c = colorToCss(fill.color as Color);
      return `linear-gradient(${c}, ${c})`;
    }
    case 'linear':
      return `linear-gradient(${trim(fill.angle)}deg, ${gradientStops(fill.stops)})`;
    case 'radial':
      return `radial-gradient(circle, ${gradientStops(fill.stops)})`;
  }
}

function gradientStops(stops: { color: unknown; position: number }[]): string {
  return stops
    .map((s) => `${colorToCss(s.color as Color)} ${trim(s.position * 100)}%`)
    .join(', ');
}

function shadowValue(sh: Shadow): string {
  const parts = [
    sh.inset ? 'inset' : '',
    `${trim(sh.x)}px`,
    `${trim(sh.y)}px`,
    `${trim(sh.blur)}px`,
    `${trim(sh.spread)}px`,
    colorToCss(sh.color as Color),
  ];
  return parts.filter(Boolean).join(' ');
}

function fontStack(family: string): string {
  if (family.includes(',')) return family;
  const quoted = family.includes(' ') ? `'${family}'` : family;
  return `${quoted}, system-ui, sans-serif`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
