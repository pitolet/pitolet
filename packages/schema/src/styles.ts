/**
 * Structured, token-aware style declarations.
 *
 * Styles are never raw CSS strings — every property is structured data whose
 * vocabulary maps 1:1 onto CSS, so the editor render and the code generator
 * derive from the same semantics. Any leaf value may instead reference a
 * design token via `{ $token: "color.primary" }`.
 */

export interface TokenRef {
  $token: string;
}

export type StyleValue<T> = T | TokenRef;

export function isTokenRef(v: unknown): v is TokenRef {
  return typeof v === 'object' && v !== null && '$token' in v;
}

// ---------------------------------------------------------------------------
// Primitive value types
// ---------------------------------------------------------------------------

export type LengthUnit = 'px' | 'rem' | 'em' | '%' | 'vw' | 'vh';

export interface Length {
  value: number;
  unit: LengthUnit;
}

export const px = (value: number): Length => ({ value, unit: 'px' });
export const rem = (value: number): Length => ({ value, unit: 'rem' });
export const pct = (value: number): Length => ({ value, unit: '%' });

/** Sizing: a concrete length, intrinsic (`auto`), or stretch-to-container (`fill`). */
export type Size = Length | 'auto' | 'fill';

export interface Color {
  space: 'oklch';
  /** Lightness 0..1 */
  l: number;
  /** Chroma 0..~0.4 */
  c: number;
  /** Hue 0..360 */
  h: number;
  /** Alpha 0..1, default 1 */
  alpha?: number;
}

export interface Sides<T> {
  top: T;
  right: T;
  bottom: T;
  left: T;
}

export const sides = <T,>(all: T): Sides<T> => ({ top: all, right: all, bottom: all, left: all });

export type GradientStop = { color: StyleValue<Color>; position: number /* 0..1 */ };

export type Fill =
  | { type: 'solid'; color: StyleValue<Color> }
  | { type: 'linear'; angle: number /* deg */; stops: GradientStop[] }
  | { type: 'radial'; stops: GradientStop[] };

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: StyleValue<Color>;
  inset?: boolean;
}

/** Grid track sizing. */
export type Track =
  | { kind: 'fr'; value: number }
  | { kind: 'px'; value: number }
  | { kind: 'auto' }
  | { kind: 'minmax'; min: number /* px */; max: { kind: 'fr' | 'px'; value: number } };

// ---------------------------------------------------------------------------
// StyleDecl — one layer of styling (base, a breakpoint override, or a state)
// ---------------------------------------------------------------------------

export type Display = 'flex' | 'grid' | 'block' | 'inline' | 'none';
export type FlexDirection = 'row' | 'column';
export type AlignValue = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
export type JustifyValue = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
export type Position = 'relative' | 'absolute' | 'sticky';
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type Overflow = 'visible' | 'hidden' | 'auto' | 'scroll';
export type ObjectFit = 'cover' | 'contain' | 'fill' | 'none';

export interface StyleDecl {
  // Layout (container)
  display?: Display;
  flexDirection?: FlexDirection;
  flexWrap?: 'wrap' | 'nowrap';
  alignItems?: AlignValue;
  justifyContent?: JustifyValue;
  gap?: { row: StyleValue<Length>; column: StyleValue<Length> };
  gridTemplateColumns?: Track[];
  gridTemplateRows?: Track[];

  // Layout (child)
  alignSelf?: AlignValue;
  flexGrow?: number;
  gridColumn?: string;
  gridRow?: string;

  // Box
  padding?: Sides<StyleValue<Length>>;
  margin?: Sides<StyleValue<Length>>;
  width?: StyleValue<Size>;
  height?: StyleValue<Size>;
  minWidth?: StyleValue<Size>;
  maxWidth?: StyleValue<Size>;
  minHeight?: StyleValue<Size>;
  maxHeight?: StyleValue<Size>;

  // Position
  position?: Position;
  inset?: Partial<Sides<StyleValue<Length>>>;
  zIndex?: number;

  // Typography
  fontFamily?: StyleValue<string>;
  fontSize?: StyleValue<Length>;
  fontWeight?: StyleValue<number>;
  lineHeight?: StyleValue<number | Length>;
  letterSpacing?: StyleValue<Length>;
  textAlign?: TextAlign;
  color?: StyleValue<Color>;

  // Appearance
  fills?: Fill[];
  border?: {
    width: StyleValue<Length>;
    style: 'solid' | 'dashed' | 'dotted';
    color: StyleValue<Color>;
    /** Which sides get the border; omitted = all. */
    sides?: Partial<Sides<boolean>>;
  };
  radius?: {
    tl: StyleValue<Length>;
    tr: StyleValue<Length>;
    br: StyleValue<Length>;
    bl: StyleValue<Length>;
  };
  shadows?: Shadow[];

  // Effects & misc
  opacity?: number;
  blendMode?: string;
  overflow?: Overflow;
  cursor?: string;
  objectFit?: ObjectFit;
}

// ---------------------------------------------------------------------------
// StyleSheet — the full cascading style record on a node
// ---------------------------------------------------------------------------

export type StateName = 'hover' | 'focus' | 'active';
export const STATE_NAMES: readonly StateName[] = ['hover', 'focus', 'active'];

export interface StyleSheet {
  base: StyleDecl;
  /** Cascading overrides keyed by breakpoint id, applied mobile-first. */
  breakpoints?: Record<string, Partial<StyleDecl>>;
  /** Interaction-state overrides, applied on top of the resolved breakpoint cascade. */
  states?: Partial<Record<StateName, Partial<StyleDecl>>>;
}

export const emptyStyleSheet = (): StyleSheet => ({ base: {} });
