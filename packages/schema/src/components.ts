import type { ComponentId, NodeId } from './nodes.js';
import type { StyleDecl } from './styles.js';

export interface VariantProp {
  name: string;
  values: string[];
  default: string;
}

/** Per-node overrides a variant applies to the master subtree. */
export interface VariantPatch {
  styles?: Partial<StyleDecl>;
  visible?: boolean;
}

export interface ComponentDef {
  id: ComponentId;
  name: string;
  /** The master FrameNode (lives in doc.nodes, visible on canvas). */
  rootId: NodeId;
  variantProps: VariantProp[];
  /**
   * Keyed by a variant selector like "intent=ghost" (multiple props joined
   * with "," in prop-name order: "intent=ghost,size=sm").
   */
  variants: Record<string, Record<NodeId, VariantPatch>>;
}

/** Canonical selector key for a variant value combination. */
export function variantKey(values: Record<string, string>, props: VariantProp[]): string {
  return props
    .map((p) => `${p.name}=${values[p.name] ?? p.default}`)
    .sort()
    .join(',');
}

/**
 * All variant selector keys that match the given values — used to collect
 * patches from both single-prop selectors ("intent=ghost") and combination
 * selectors when several props exist.
 */
export function matchingVariantKeys(
  values: Record<string, string>,
  props: VariantProp[],
): string[] {
  const single = props
    .map((p) => `${p.name}=${values[p.name] ?? p.default}`)
    .sort();
  const keys = [...single];
  if (props.length > 1) keys.push(single.join(','));
  return keys;
}
