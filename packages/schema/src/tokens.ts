import type { Color, Length, Shadow } from './styles.js';

/**
 * Design tokens — DTCG-flavored, unlimited, first-class.
 * Token paths look like "color.primary", "spacing.4", "typography.fontSize.lg".
 */

export interface Token<T> {
  $value: T;
  $description?: string;
}

export interface TokenSet {
  color: Record<string, Token<Color>>;
  spacing: Record<string, Token<Length>>;
  radius: Record<string, Token<Length>>;
  shadow: Record<string, Token<Shadow[]>>;
  typography: {
    fontFamily: Record<string, Token<string>>;
    fontSize: Record<string, Token<Length>>;
  };
}

export type TokenCategory = 'color' | 'spacing' | 'radius' | 'shadow' | 'fontFamily' | 'fontSize';

export const emptyTokenSet = (): TokenSet => ({
  color: {},
  spacing: {},
  radius: {},
  shadow: {},
  typography: { fontFamily: {}, fontSize: {} },
});

/** Look up a token by dotted path, e.g. "color.primary" or "typography.fontSize.lg". */
export function getToken(tokens: TokenSet, path: string): unknown {
  const value = tokenEntry(tokens, path);
  return value?.$value;
}

export function tokenEntry(tokens: TokenSet, path: string): Token<unknown> | undefined {
  const parts = path.split('.');
  const head = parts[0];
  if (head === 'typography') {
    const group = parts[1];
    const name = parts.slice(2).join('.');
    if (group === 'fontFamily') return tokens.typography.fontFamily[name];
    if (group === 'fontSize') return tokens.typography.fontSize[name];
    return undefined;
  }
  const name = parts.slice(1).join('.');
  if (head === 'color') return tokens.color[name];
  if (head === 'spacing') return tokens.spacing[name];
  if (head === 'radius') return tokens.radius[name];
  if (head === 'shadow') return tokens.shadow[name];
  return undefined;
}

/** All token paths in a set, e.g. for pickers and codegen theme emission. */
export function listTokenPaths(tokens: TokenSet): string[] {
  return [
    ...Object.keys(tokens.color).map((k) => `color.${k}`),
    ...Object.keys(tokens.spacing).map((k) => `spacing.${k}`),
    ...Object.keys(tokens.radius).map((k) => `radius.${k}`),
    ...Object.keys(tokens.shadow).map((k) => `shadow.${k}`),
    ...Object.keys(tokens.typography.fontFamily).map((k) => `typography.fontFamily.${k}`),
    ...Object.keys(tokens.typography.fontSize).map((k) => `typography.fontSize.${k}`),
  ];
}

/** Category of a token path (drives which picker/filter it appears in). */
export function tokenCategory(path: string): TokenCategory | undefined {
  if (path.startsWith('color.')) return 'color';
  if (path.startsWith('spacing.')) return 'spacing';
  if (path.startsWith('radius.')) return 'radius';
  if (path.startsWith('shadow.')) return 'shadow';
  if (path.startsWith('typography.fontFamily.')) return 'fontFamily';
  if (path.startsWith('typography.fontSize.')) return 'fontSize';
  return undefined;
}
