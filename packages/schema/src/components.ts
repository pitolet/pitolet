import type { ComponentId, FrameNode, NodeId, PitoletNode } from './nodes.js';
import { px, type Length, type StyleDecl } from './styles.js';

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
  /** The node rendered by instances. May be the master frame itself or a descendant. */
  contentRootId: NodeId;
  variantProps: VariantProp[];
  /**
   * Keyed by a variant selector like "intent=ghost" (multiple props joined
   * with "," in prop-name order: "intent=ghost,size=sm").
   */
  variants: Record<string, Record<NodeId, VariantPatch>>;
}

interface CachedFrameSize {
  canvasWidth: number;
  canvasHeight: number | 'auto';
  width: Length;
  height: Length | 'auto';
}

const frameSizeCache = new WeakMap<FrameNode, CachedFrameSize>();

/**
 * A top-level frame keeps its dimensions in canvas metadata rather than CSS.
 * When that frame is also the instance content root, expose those dimensions
 * as ordinary styles so every renderer and inspector sees the same box.
 */
export function componentContentBaseStyles(component: ComponentDef, node: PitoletNode): StyleDecl {
  const base = { ...node.styles.base };
  if (
    component.contentRootId === component.rootId &&
    node.id === component.contentRootId &&
    node.type === 'frame'
  ) {
    const cached = frameSizeCache.get(node);
    const dimensions: CachedFrameSize =
      cached &&
      cached.canvasWidth === node.canvas.width &&
      cached.canvasHeight === node.canvas.height
        ? cached
        : {
            canvasWidth: node.canvas.width,
            canvasHeight: node.canvas.height,
            width: px(node.canvas.width),
            height: node.canvas.height === 'auto' ? 'auto' : px(node.canvas.height),
          };
    if (dimensions !== cached) frameSizeCache.set(node, dimensions);
    base.width ??= dimensions.width;
    base.height ??= dimensions.height;
  }
  return base;
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
  const single = props.map((p) => `${p.name}=${values[p.name] ?? p.default}`).sort();
  const keys = [...single];
  if (props.length > 1) keys.push(single.join(','));
  return keys;
}

/** Parse a canonical or legacy selector such as "intent=ghost,size=sm". */
export function parseVariantKey(key: string): Record<string, string> | null {
  if (!key.trim()) return null;
  const values: Record<string, string> = {};
  for (const segment of key.split(',')) {
    const at = segment.indexOf('=');
    if (at <= 0 || at === segment.length - 1 || segment.lastIndexOf('=') !== at) return null;
    const name = segment.slice(0, at).trim();
    const value = segment.slice(at + 1).trim();
    if (!name || !value || values[name] !== undefined) return null;
    values[name] = value;
  }
  return values;
}

/** Cartesian product of every declared variant property. */
export function variantCombinations(props: VariantProp[]): Record<string, string>[] {
  if (props.length === 0) return [{}];
  let combinations: Record<string, string>[] = [{}];
  for (const prop of props) {
    combinations = combinations.flatMap((current) =>
      prop.values.map((value) => ({ ...current, [prop.name]: value })),
    );
  }
  return combinations;
}

/** Compose single-property and compound patches in their application order. */
export function resolveVariantPatch(
  component: ComponentDef,
  values: Record<string, string>,
  nodeId: NodeId,
): VariantPatch | undefined {
  let result: VariantPatch | undefined;
  for (const key of matchingVariantKeys(values, component.variantProps)) {
    const patch = component.variants[key]?.[nodeId];
    if (!patch) continue;
    result = {
      ...result,
      ...patch,
      ...(result?.styles || patch.styles ? { styles: { ...result?.styles, ...patch.styles } } : {}),
    };
  }
  return result;
}
