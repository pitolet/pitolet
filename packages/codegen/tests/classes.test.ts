import { defaultTokens, oklch, px, sides, type StyleDecl } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { styleDeclToClasses, TokenMaps } from '../src/index.js';

const maps = new TokenMaps(defaultTokens());

function classes(decl: StyleDecl, ctx: Partial<Parameters<typeof styleDeclToClasses>[1]> = {}) {
  return styleDeclToClasses(decl, { maps, ...ctx }).join(' ');
}

describe('class matching', () => {
  it('maps flex layout', () => {
    expect(
      classes({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'between',
        gap: { row: px(16), column: px(16) },
      }),
    ).toBe('flex flex-col items-center justify-between gap-4');
  });

  it('preserves reverse flex direction and wrapping', () => {
    expect(
      classes({
        display: 'flex',
        flexDirection: 'row-reverse',
        flexWrap: 'wrap-reverse',
      }),
    ).toBe('flex flex-row-reverse flex-wrap-reverse');
    expect(
      classes({ width: 'fill' }, { parentDisplay: 'flex', parentDirection: 'row-reverse' }),
    ).toBe('flex-1 min-w-0');
  });

  it('splits asymmetric gaps', () => {
    expect(classes({ gap: { row: px(8), column: px(24) } })).toBe('gap-y-2 gap-x-6');
  });

  it('token-bound values emit token utilities', () => {
    expect(
      classes({
        padding: sides({ $token: 'spacing.6' }),
        fills: [{ type: 'solid', color: { $token: 'color.primary' } }],
        color: { $token: 'color.primary-foreground' },
        fontSize: { $token: 'typography.fontSize.lg' },
        radius: {
          tl: { $token: 'radius.md' },
          tr: { $token: 'radius.md' },
          br: { $token: 'radius.md' },
          bl: { $token: 'radius.md' },
        },
      }),
    ).toBe('p-6 text-lg text-primary-foreground bg-primary rounded-md');
  });

  it('snaps raw values on the Tailwind scale', () => {
    expect(classes({ padding: sides(px(16)) })).toBe('p-4');
    expect(classes({ fontSize: px(18) })).toBe('text-lg');
    expect(classes({ width: px(64) })).toBe('w-16');
  });

  it('falls back to arbitrary values instead of rounding', () => {
    expect(classes({ padding: sides(px(13)) })).toBe('p-[13px]');
    expect(classes({ fontSize: px(17) })).toBe('text-[17px]');
    expect(classes({ width: px(437) })).toBe('w-[437px]');
  });

  it('emits px/py when vertical and horizontal sides pair up', () => {
    expect(classes({ padding: { top: px(12), bottom: px(12), left: px(24), right: px(24) } })).toBe(
      'py-3 px-6',
    );
  });

  it('matches raw colors near a token perceptually', () => {
    const tokens = defaultTokens();
    const primary = tokens.color.primary!.$value;
    expect(classes({ color: { ...primary } })).toBe('text-primary');
    // A clearly different color stays arbitrary.
    expect(classes({ color: oklch(0.5, 0.2, 30) })).toBe('text-[oklch(0.5_0.2_30)]');
  });

  it('handles fill sizing via flex context', () => {
    expect(classes({ width: 'fill' }, { parentDisplay: 'flex', parentDirection: 'row' })).toBe(
      'flex-1 min-w-0',
    );
    expect(classes({ width: 'fill' }, { parentDisplay: 'flex', parentDirection: 'column' })).toBe(
      'w-full',
    );
    expect(classes({ width: 'fill' }, { parentDisplay: 'block' })).toBe('w-full');
    expect(classes({ width: '50%' as never })).toContain('w-');
  });

  it('preserves cross-axis alignment when fill is constrained', () => {
    expect(
      classes(
        { width: 'fill', maxWidth: px(880), alignSelf: 'center' },
        { parentDisplay: 'flex', parentDirection: 'column' },
      ),
    ).toBe('self-center w-full max-w-[880px]');
    expect(
      classes(
        { height: 'fill', maxHeight: px(480), alignSelf: 'end' },
        { parentDisplay: 'flex', parentDirection: 'row' },
      ),
    ).toBe('self-end h-full max-h-[480px]');
  });

  it('percentage widths use fractions', () => {
    expect(classes({ width: { value: 50, unit: '%' } })).toBe('w-1/2');
    expect(classes({ width: { value: 100, unit: '%' } })).toBe('w-full');
    expect(classes({ width: { value: 37, unit: '%' } })).toBe('w-[37%]');
  });

  it('borders', () => {
    expect(
      classes({ border: { width: px(1), style: 'solid', color: { $token: 'color.border' } } }),
    ).toBe('border border-border');
    expect(classes({ border: { width: px(2), style: 'dashed', color: oklch(0, 0, 0) } })).toBe(
      'border-2 border-dashed border-[oklch(0_0_0)]',
    );
  });

  it('grid templates', () => {
    expect(
      classes({
        display: 'grid',
        gridTemplateColumns: [
          { kind: 'fr', value: 1 },
          { kind: 'fr', value: 1 },
          { kind: 'fr', value: 1 },
        ],
      }),
    ).toBe('grid grid-cols-3');
    expect(
      classes({
        display: 'grid',
        gridTemplateColumns: [
          { kind: 'px', value: 200 },
          { kind: 'fr', value: 1 },
        ],
      }),
    ).toBe('grid grid-cols-[200px_1fr]');
  });

  it('opacity snaps to 5% steps', () => {
    expect(classes({ opacity: 0.5 })).toBe('opacity-50');
    expect(classes({ opacity: 0.37 })).toBe('opacity-[0.37]');
  });

  it('shadows resolve document tokens', () => {
    const tokens = defaultTokens();
    expect(classes({ shadows: tokens.shadow.md!.$value })).toBe('shadow-md');
  });

  it('emits explicit reset utilities for responsive override layers', () => {
    expect(
      classes(
        {
          alignSelf: 'auto',
          width: 'auto',
          position: 'static',
          gridTemplateColumns: [],
          shadows: [],
          blendMode: 'normal',
        },
        { isOverrideLayer: true },
      ),
    ).toBe('grid-cols-none self-auto w-auto static shadow-none mix-blend-normal');
  });

  it('resets flex, inset, border and radius defaults in override layers', () => {
    expect(
      classes(
        {
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          inset: { top: px(0) },
        },
        { isOverrideLayer: true },
      ),
    ).toBe('flex flex-row flex-nowrap top-0 right-auto bottom-auto left-auto');
    expect(
      classes(
        {
          border: {
            width: px(1),
            style: 'solid',
            color: { $token: 'color.border' },
            sides: { left: true },
          },
        },
        { isOverrideLayer: true },
      ),
    ).toBe('border-t-0 border-r-0 border-b-0 border-l border-solid border-border');
    expect(
      classes(
        {
          radius: { tl: px(0), tr: px(8), br: px(0), bl: px(8) },
        },
        { isOverrideLayer: true },
      ),
    ).toBe('rounded-tl-none rounded-tr-lg rounded-br-none rounded-bl-lg');
    expect(
      classes(
        {
          radius: { tl: px(0), tr: px(0), br: px(0), bl: px(0) },
        },
        { isOverrideLayer: true },
      ),
    ).toBe('rounded-none');
  });
});
