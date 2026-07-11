import { rootFrameOf, type PitoletNode, type StyleDecl } from '@pitolet/schema';
import { nanoid } from 'nanoid';
import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../store/index.js';

/**
 * Inspector read/write plumbing. Reads target the base style layer (per-
 * breakpoint/state editing contexts arrive in M6 and reroute here).
 */

export interface StyleReadout<T> {
  /** The shared value across the selection, or null when mixed. */
  value: T | null;
  mixed: boolean;
  /** Value of the first selected node (for mixed placeholders). */
  first: T | undefined;
}

/**
 * Read one StyleDecl field across the selection at the CURRENT editing
 * context: state layer → breakpoint layer → cascaded base (mobile-first).
 */
export function useStyleValue<K extends keyof StyleDecl>(key: K): StyleReadout<StyleDecl[K]> {
  const values = useEditor(
    useShallow((s) =>
      s.selection.map((id) => {
        const node = s.doc?.nodes[id];
        if (!node || !s.doc) return undefined;
        return readAtContext(node.styles, key, s.editingContext, s.doc.breakpoints);
      }),
    ),
  );
  return toReadout(values);
}

function readAtContext<K extends keyof StyleDecl>(
  styles: { base: StyleDecl; breakpoints?: Record<string, Partial<StyleDecl>>; states?: Partial<Record<string, Partial<StyleDecl>>> },
  key: K,
  ctx: { breakpointId: string | null; state: string | null },
  breakpoints: Array<{ id: string; minWidth: number }>,
): StyleDecl[K] | undefined {
  if (ctx.state) {
    const stateValue = styles.states?.[ctx.state]?.[key];
    if (stateValue !== undefined) return stateValue as StyleDecl[K];
  }
  if (ctx.breakpointId) {
    // Cascade: base, then each breakpoint up to and including the edited one.
    const target = breakpoints.find((b) => b.id === ctx.breakpointId);
    let value = styles.base[key];
    if (target) {
      for (const bp of breakpoints) {
        if (bp.minWidth <= target.minWidth) {
          const layerValue = styles.breakpoints?.[bp.id]?.[key];
          if (layerValue !== undefined) value = layerValue as StyleDecl[K];
        }
      }
    }
    return value;
  }
  return styles.base[key];
}

/** Read a derived value per selected node (for nested/virtual fields). */
export function useStyleDerived<T>(read: (decl: StyleDecl, node: PitoletNode) => T): StyleReadout<T> {
  const values = useEditor(
    useShallow((s) =>
      s.selection.map((id) => {
        const node = s.doc?.nodes[id];
        return node ? read(node.styles.base, node) : undefined;
      }),
    ),
  );
  return toReadout(values as (T | undefined)[]);
}

export function useSelectedNodes(): PitoletNode[] {
  return useEditor(
    useShallow((s) =>
      s.selection
        .map((id) => s.doc?.nodes[id])
        .filter((n): n is PitoletNode => n !== undefined),
    ),
  );
}

/**
 * Write a style mutation across every selected node. Writes go to the base
 * layer, EXCEPT while a variant is being edited and the node lives inside
 * that component's master subtree — then they record into the variant patch.
 */
export function setStyle(
  label: string,
  write: (decl: StyleDecl, node: PitoletNode) => void,
  coalesceKey?: string,
): void {
  const store = useEditor.getState();
  const ids = store.selection;
  const editingVariant = store.editingVariant;
  const editingContext = store.editingContext;
  if (ids.length === 0) return;
  store.dispatchEdit(
    label,
    (draft) => {
      for (const id of ids) {
        const node = draft.nodes[id];
        if (!node) continue;
        if (editingContext.state) {
          node.styles.states = node.styles.states ?? {};
          const stateKey = editingContext.state;
          node.styles.states[stateKey] = node.styles.states[stateKey] ?? {};
          write(node.styles.states[stateKey] as StyleDecl, node as PitoletNode);
          continue;
        }
        if (editingContext.breakpointId) {
          node.styles.breakpoints = node.styles.breakpoints ?? {};
          const bp = editingContext.breakpointId;
          node.styles.breakpoints[bp] = node.styles.breakpoints[bp] ?? {};
          write(node.styles.breakpoints[bp] as StyleDecl, node as PitoletNode);
          continue;
        }
        if (editingVariant) {
          // Is this node inside a component master?
          const rootId = rootFrameOf(draft.nodes as Record<string, PitoletNode>, id);
          const root = draft.nodes[rootId];
          if (root?.type === 'frame' && root.isComponentMaster) {
            const component = draft.components[root.isComponentMaster];
            if (component) {
              component.variants[editingVariant] = component.variants[editingVariant] ?? {};
              const bucket = component.variants[editingVariant]!;
              bucket[id] = bucket[id] ?? {};
              bucket[id]!.styles = bucket[id]!.styles ?? {};
              write(bucket[id]!.styles as StyleDecl, node as PitoletNode);
              continue;
            }
          }
        }
        write(node.styles.base as StyleDecl, node as PitoletNode);
      }
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

/**
 * A per-gesture coalesce key: scrub drags dispatch many edits that merge
 * into one undo entry. Call begin() on gesture start; use current between.
 */
export function useCoalesceKey(): { begin: () => void; current: () => string } {
  const ref = useRef(nanoid(6));
  return {
    begin: () => {
      ref.current = nanoid(6);
    },
    current: () => ref.current,
  };
}

function toReadout<T>(values: (T | undefined)[]): StyleReadout<T> {
  if (values.length === 0) return { value: null, mixed: false, first: undefined };
  const first = values[0];
  const allEqual = values.every((v) => deepEqual(v, first));
  return {
    value: allEqual ? (first ?? null) : null,
    mixed: !allEqual,
    first,
  };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
