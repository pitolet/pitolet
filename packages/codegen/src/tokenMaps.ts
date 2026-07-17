import {
  colorDistance,
  type Color,
  type Length,
  type Shadow,
  type TokenSet,
} from '@pitolet/schema';
import { COLOR_TOLERANCE } from './scales.js';
import { allocateNames, sanitizeCssName } from './safety.js';

/**
 * Reverse lookups from raw values to document-token names, used both to
 * emit token-derived utilities for bound values and to snap raw values that
 * happen to equal a token.
 */
export class TokenMaps {
  readonly colorEntries: Array<{ name: string; value: Color }>;
  private pathNames = new Map<string, string>();
  private spacingByPx = new Map<number, string>();
  private radiusByPx = new Map<number, string>();
  private fontSizeByPx = new Map<number, string>();
  private shadowByJson = new Map<string, string>();
  private fontFamilyByValue = new Map<string, string>();

  constructor(readonly tokens: TokenSet) {
    for (const [category, names] of [
      ['color', Object.keys(tokens.color)],
      ['spacing', Object.keys(tokens.spacing)],
      ['radius', Object.keys(tokens.radius)],
      ['shadow', Object.keys(tokens.shadow)],
      ['typography.fontFamily', Object.keys(tokens.typography.fontFamily)],
      ['typography.fontSize', Object.keys(tokens.typography.fontSize)],
    ] as const) {
      const allocated = allocateNames(names, 'token');
      for (const name of names) this.pathNames.set(`${category}.${name}`, allocated.get(name)!);
    }
    this.colorEntries = Object.entries(tokens.color).map(([name, t]) => ({
      name: this.nameForPath(`color.${name}`),
      value: t.$value,
    }));
    for (const [name, t] of Object.entries(tokens.spacing)) {
      if (t.$value.unit === 'px')
        this.spacingByPx.set(t.$value.value, this.nameForPath(`spacing.${name}`));
    }
    for (const [name, t] of Object.entries(tokens.radius)) {
      if (t.$value.unit === 'px')
        this.radiusByPx.set(t.$value.value, this.nameForPath(`radius.${name}`));
    }
    for (const [name, t] of Object.entries(tokens.typography.fontSize)) {
      if (t.$value.unit === 'px')
        this.fontSizeByPx.set(t.$value.value, this.nameForPath(`typography.fontSize.${name}`));
    }
    for (const [name, t] of Object.entries(tokens.shadow)) {
      this.shadowByJson.set(JSON.stringify(t.$value), this.nameForPath(`shadow.${name}`));
    }
    for (const [name, t] of Object.entries(tokens.typography.fontFamily)) {
      this.fontFamilyByValue.set(t.$value, this.nameForPath(`typography.fontFamily.${name}`));
    }
  }

  /** Token name for a token path like "color.primary" → "primary". */
  nameForPath(path: string): string {
    return this.pathNames.get(path) ?? (sanitizeCssName(path.replace(/^[^.]+\./, '')) || 'token');
  }

  colorTokenFor(color: Color): string | null {
    let best: { name: string; d: number } | null = null;
    for (const entry of this.colorEntries) {
      const d = colorDistance(entry.value, color);
      if (d <= COLOR_TOLERANCE && (!best || d < best.d)) best = { name: entry.name, d };
    }
    return best?.name ?? null;
  }

  spacingTokenFor(length: Length): string | null {
    return length.unit === 'px' ? (this.spacingByPx.get(length.value) ?? null) : null;
  }

  radiusTokenFor(length: Length): string | null {
    return length.unit === 'px' ? (this.radiusByPx.get(length.value) ?? null) : null;
  }

  fontSizeTokenFor(length: Length): string | null {
    return length.unit === 'px' ? (this.fontSizeByPx.get(length.value) ?? null) : null;
  }

  shadowTokenFor(shadows: Shadow[]): string | null {
    return this.shadowByJson.get(JSON.stringify(shadows)) ?? null;
  }

  fontFamilyTokenFor(family: string): string | null {
    return this.fontFamilyByValue.get(family) ?? null;
  }
}

export function sanitizeTokenName(name: string): string {
  return sanitizeCssName(name);
}
