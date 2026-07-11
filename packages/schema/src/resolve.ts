import type { Breakpoint } from './document.js';
import type { StateName, StyleDecl, StyleSheet } from './styles.js';
import { isTokenRef } from './styles.js';
import { getToken, type TokenSet } from './tokens.js';

/**
 * Style cascade resolution — the ONLY place layer-merge semantics live.
 * Editor rendering and codegen both consume this, which is what guarantees
 * "what you see is what ships".
 *
 * Cascade order (later wins, property-granular):
 *   base → each breakpoint with minWidth <= frameWidth (ascending) → active states
 */

export interface ResolveContext {
  /** Width of the containing frame — drives which breakpoint layers apply. */
  frameWidth: number;
  /** Document breakpoints, sorted ascending by minWidth. */
  breakpoints: Breakpoint[];
  /** Interaction states to apply (e.g. ['hover'] while previewing hover). */
  activeStates?: StateName[];
  tokens: TokenSet;
}

const STATE_ORDER: StateName[] = ['hover', 'focus', 'active'];

/** Merge cascade layers WITHOUT resolving token refs (used by codegen delta logic). */
export function mergeCascade(
  sheet: StyleSheet,
  frameWidth: number,
  breakpoints: Breakpoint[],
  activeStates: StateName[] = [],
): StyleDecl {
  const merged: StyleDecl = { ...sheet.base };
  for (const bp of breakpoints) {
    if (bp.minWidth <= frameWidth) {
      const layer = sheet.breakpoints?.[bp.id];
      if (layer) Object.assign(merged, layer);
    }
  }
  for (const state of STATE_ORDER) {
    if (activeStates.includes(state)) {
      const layer = sheet.states?.[state];
      if (layer) Object.assign(merged, layer);
    }
  }
  return merged;
}

/** Full resolution: cascade merge + token substitution. */
export function resolveStyles(sheet: StyleSheet, ctx: ResolveContext): StyleDecl {
  const merged = mergeCascade(sheet, ctx.frameWidth, ctx.breakpoints, ctx.activeStates ?? []);
  return resolveTokenRefs(merged, ctx.tokens) as StyleDecl;
}

/**
 * Deep-replace `{ $token: path }` references with their token values.
 * Unknown token paths resolve to undefined (the property is dropped) so a
 * deleted token degrades gracefully instead of crashing the renderer.
 */
export function resolveTokenRefs(value: unknown, tokens: TokenSet): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isTokenRef(value)) return getToken(tokens, value.$token);
  if (Array.isArray(value)) return value.map((v) => resolveTokenRefs(v, tokens));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const resolved = resolveTokenRefs(v, tokens);
    if (resolved !== undefined) out[k] = resolved;
  }
  return out;
}

/** Breakpoint layers that apply at a given frame width (ascending). */
export function activeBreakpoints(breakpoints: Breakpoint[], frameWidth: number): Breakpoint[] {
  return breakpoints.filter((bp) => bp.minWidth <= frameWidth);
}
