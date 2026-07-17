import { describe, expect, it } from 'vitest';
import {
  allStyleValuesEqual,
  readBorderSides,
  removeStyleBorder,
  removeStyleFill,
  removeStyleShadow,
  toggleAllBorderSides,
  toggleBorderSide,
  updateGapAxis,
} from '../src/inspector/compoundControls.js';
import { px, type StyleDecl } from '@pitolet/schema';

describe('border side controls', () => {
  it('treats an omitted side map as all sides', () => {
    expect(readBorderSides()).toEqual({ top: true, right: true, bottom: true, left: true });
  });

  it('toggles one side without changing the others', () => {
    const withoutTop = toggleBorderSide(undefined, 'top');
    expect(readBorderSides(withoutTop)).toEqual({
      top: false,
      right: true,
      bottom: true,
      left: true,
    });
    expect(toggleBorderSide(withoutTop, 'top')).toBeUndefined();
  });

  it('toggles between all and no sides', () => {
    const none = toggleAllBorderSides(undefined);
    expect(readBorderSides(none)).toEqual({
      top: false,
      right: false,
      bottom: false,
      left: false,
    });
    expect(toggleAllBorderSides(none)).toBeUndefined();
  });
});

describe('allStyleValuesEqual', () => {
  it('compares the complete structured value rather than only its number', () => {
    expect(
      allStyleValuesEqual([
        { value: 1, unit: 'px' },
        { value: 1, unit: 'rem' },
      ]),
    ).toBe(false);
    expect(allStyleValuesEqual([{ $token: 'spacing.2' }, { $token: 'spacing.2' }])).toBe(true);
  });
});

describe('gap controls', () => {
  it('preserves the inherited axis when creating a contextual override', () => {
    const resolved = {
      row: { $token: 'spacing.5' },
      column: px(0),
    };
    expect(updateGapAxis(undefined, resolved, 'row', px(24))).toEqual({
      row: px(24),
      column: px(0),
    });
    expect(updateGapAxis(undefined, resolved, 'column', px(12))).toEqual({
      row: { $token: 'spacing.5' },
      column: px(12),
    });
  });

  it('keeps a local sibling-axis override when editing again', () => {
    expect(updateGapAxis({ row: px(20), column: px(4) }, undefined, 'row', px(24))).toEqual({
      row: px(24),
      column: px(4),
    });
  });
});

describe('contextual appearance removal', () => {
  it('stores explicit neutral values instead of accidentally inheriting again', () => {
    const decl: StyleDecl = {
      fills: [{ type: 'solid' as const, color: { $token: 'color.background' } }],
      border: {
        width: px(1),
        style: 'solid' as const,
        color: { $token: 'color.border' },
      },
      shadows: [
        {
          x: 0,
          y: 2,
          blur: 8,
          spread: 0,
          color: { $token: 'color.foreground' },
        },
      ],
    };

    removeStyleFill(decl, true);
    removeStyleBorder(decl, true);
    removeStyleShadow(decl, 0, true);

    expect(decl.fills).toEqual([]);
    expect(decl.border?.sides).toEqual({});
    expect(decl.shadows).toEqual([]);
  });
});
