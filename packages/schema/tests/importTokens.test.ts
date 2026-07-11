import { describe, expect, it } from 'vitest';
import { colorToHex, defaultTokens, mergeParsedTokens, parseCssTokens } from '../src/index.js';

describe('parseCssTokens', () => {
  it('parses a Tailwind v4 @theme block', () => {
    const { tokens, count, skipped } = parseCssTokens(`
      @theme {
        --color-primary: #3b82f6;
        --color-surface: oklch(0.98 0.01 250);
        --spacing-gutter: 1.5rem;
        --spacing-2: 8px;
        --radius-card: 12px;
        --text-hero: 3rem;
        --font-sans: 'Inter', system-ui, sans-serif;
      }
    `);
    expect(count).toBe(7);
    expect(skipped).toEqual([]);
    expect(colorToHex(tokens.color.primary!).toLowerCase()).toBe('#3b82f6');
    expect(tokens.spacing.gutter).toEqual({ value: 24, unit: 'px' }); // 1.5rem → 24px
    expect(tokens.spacing['2']).toEqual({ value: 8, unit: 'px' });
    expect(tokens.radius.card).toEqual({ value: 12, unit: 'px' });
    expect(tokens.fontSize.hero).toEqual({ value: 48, unit: 'px' });
    expect(tokens.fontFamily.sans).toBe('Inter');
  });

  it('parses shadows including inset and multi-layer', () => {
    const { tokens } = parseCssTokens(`
      :root {
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.08);
        --shadow-lg: 0 12px 32px -4px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.1);
      }
    `);
    expect(tokens.shadow.sm).toHaveLength(1);
    expect(tokens.shadow.sm![0]).toMatchObject({ x: 0, y: 1, blur: 2, spread: 0 });
    expect(tokens.shadow.lg).toHaveLength(2);
    expect(tokens.shadow.lg![1]!.inset).toBe(true);
  });

  it('skips unparseable values and ignores var() references and Tailwind sub-keys', () => {
    const { tokens, skipped } = parseCssTokens(`
      --color-good: #fff;
      --color-bad: not-a-color;
      --spacing-ref: var(--spacing-4);
      --text-lg: 1.125rem;
      --text-lg--line-height: 1.75rem;
    `);
    expect(tokens.color.good).toBeDefined();
    expect(skipped).toContain('--color-bad: not-a-color');
    expect(tokens.spacing.ref).toBeUndefined(); // var() skipped silently
    expect(tokens.fontSize.lg).toEqual({ value: 18, unit: 'px' });
    // The --line-height sub-key must not become a bogus font size.
    expect(Object.keys(tokens.fontSize)).toEqual(['lg']);
  });

  it('merges into a token set, overwriting same names', () => {
    const set = defaultTokens();
    const { tokens } = parseCssTokens('--color-primary: #000; --color-brand: #f0f;');
    mergeParsedTokens(set, tokens);
    expect(colorToHex(set.color.primary!.$value).toLowerCase()).toBe('#000000');
    expect(set.color.brand).toBeDefined();
    expect(set.color.background).toBeDefined(); // untouched defaults survive
  });
});
