import type { Length, Sides, StyleDecl, StyleValue } from '@pitolet/schema';

export type BorderSide = keyof Sides<boolean>;
export type BorderSideState = Record<BorderSide, boolean>;

export const BORDER_SIDES: readonly BorderSide[] = ['top', 'right', 'bottom', 'left'];

/** Missing border-side data means the border applies to every side. */
export function readBorderSides(sides?: Partial<Sides<boolean>>): BorderSideState {
  if (sides === undefined) return { top: true, right: true, bottom: true, left: true };
  return {
    top: sides.top === true,
    right: sides.right === true,
    bottom: sides.bottom === true,
    left: sides.left === true,
  };
}

export function toggleBorderSide(
  sides: Partial<Sides<boolean>> | undefined,
  side: BorderSide,
): Partial<Sides<boolean>> | undefined {
  const next = readBorderSides(sides);
  next[side] = !next[side];
  return compactBorderSides(next);
}

export function toggleAllBorderSides(
  sides: Partial<Sides<boolean>> | undefined,
): Partial<Sides<boolean>> | undefined {
  const current = readBorderSides(sides);
  const nextValue = !BORDER_SIDES.every((side) => current[side]);
  return compactBorderSides({
    top: nextValue,
    right: nextValue,
    bottom: nextValue,
    left: nextValue,
  });
}

/** Equal means structurally equal, so 1px, 1rem, and token refs stay distinct. */
export function allStyleValuesEqual(values: unknown[]): boolean {
  if (values.length < 2) return true;
  const first = JSON.stringify(values[0]);
  return values.every((value) => JSON.stringify(value) === first);
}

/** Update one gap axis without replacing the other axis inherited by this layer. */
export function updateGapAxis(
  local: StyleDecl['gap'],
  resolved: StyleDecl['gap'],
  axis: 'row' | 'column',
  value: StyleValue<Length>,
): NonNullable<StyleDecl['gap']> {
  if (axis === 'row') {
    return { row: value, column: local?.column ?? resolved?.column ?? value };
  }
  return { row: local?.row ?? resolved?.row ?? value, column: value };
}

/** "Remove" must be represented explicitly in a contextual layer; deleting
 * the property there means "inherit" and would make the control look broken. */
export function removeStyleFill(decl: StyleDecl, contextual: boolean): void {
  if (contextual) decl.fills = [];
  else delete decl.fills;
}

export function removeStyleBorder(decl: StyleDecl, contextual: boolean): void {
  if (contextual && decl.border) decl.border.sides = {};
  else delete decl.border;
}

export function removeStyleShadow(decl: StyleDecl, index: number, contextual: boolean): void {
  decl.shadows?.splice(index, 1);
  if (decl.shadows?.length === 0 && !contextual) delete decl.shadows;
}

function compactBorderSides(state: BorderSideState): Partial<Sides<boolean>> | undefined {
  if (BORDER_SIDES.every((side) => state[side])) return undefined;
  return Object.fromEntries(BORDER_SIDES.filter((side) => state[side]).map((side) => [side, true]));
}
