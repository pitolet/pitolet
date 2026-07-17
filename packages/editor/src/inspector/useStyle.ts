import {
  componentContentBaseStyles,
  matchingVariantKeys,
  rootFrameOf,
  type PitoletDocument,
  type PitoletNode,
  type StyleDecl,
  type StyleSheet,
} from '@pitolet/schema';
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
  /** Whether every selected node defines this property in the active layer. */
  overridden: boolean;
  /** Whether only part of a multi-selection defines it in the active layer. */
  partiallyOverridden: boolean;
  /** Where the displayed value comes from when the source is shared. */
  source: string | null;
  /** True while editing a breakpoint or interaction-state layer. */
  contextual: boolean;
}

export interface StyleContextReading<T> {
  value: T | undefined;
  source: string;
  local: boolean;
  contextual: boolean;
}

/**
 * Read one StyleDecl field across the selection at the CURRENT editing
 * context: state layer → breakpoint layer → cascaded base (mobile-first).
 */
export function useStyleValue<K extends keyof StyleDecl>(key: K): StyleReadout<StyleDecl[K]> {
  const values = useEditor(
    useShallow((s) =>
      s.selection.map((id) => {
        if (!s.doc) return undefined;
        const target = effectiveInspectorTarget(s.doc, id, s.editingInstanceOverride);
        if (!target) return undefined;
        return readStyleAtContext(target.styles, key, s.editingContext, s.doc.breakpoints).value;
      }),
    ),
  );
  const sources = useEditor(
    useShallow((s) =>
      s.selection.map((id) => {
        if (!s.doc) return 'base';
        const target = effectiveInspectorTarget(s.doc, id, s.editingInstanceOverride);
        return target
          ? readStyleAtContext(target.styles, key, s.editingContext, s.doc.breakpoints).source
          : 'base';
      }),
    ),
  );
  const locals = useEditor(
    useShallow((s) =>
      s.selection.map((id) => {
        if (!s.doc) return false;
        const target = effectiveInspectorTarget(s.doc, id, s.editingInstanceOverride);
        return target
          ? readStyleAtContext(target.styles, key, s.editingContext, s.doc.breakpoints).local
          : false;
      }),
    ),
  );
  const contextual = useEditor(
    (s) => s.editingContext.breakpointId !== null || s.editingContext.state !== null,
  );
  const readings = values.map((value, index) => ({
    value,
    source: sources[index] ?? 'base',
    local: locals[index] ?? false,
    contextual,
  }));
  return toContextReadout(readings);
}

/** Resolve one property and retain enough provenance for inspector feedback. */
export function readStyleAtContext<K extends keyof StyleDecl>(
  styles: {
    base: StyleDecl;
    breakpoints?: Record<string, Partial<StyleDecl>>;
    states?: Partial<Record<string, Partial<StyleDecl>>>;
  },
  key: K,
  ctx: { breakpointId: string | null; state: string | null },
  breakpoints: Array<{ id: string; minWidth: number }>,
): StyleContextReading<StyleDecl[K]> {
  if (ctx.state) {
    const stateValue = styles.states?.[ctx.state]?.[key];
    if (stateValue !== undefined) {
      return {
        value: stateValue as StyleDecl[K],
        source: `:${ctx.state}`,
        local: true,
        contextual: true,
      };
    }
  }
  if (ctx.breakpointId) {
    // Cascade: base, then each breakpoint up to and including the edited one.
    const target = breakpoints.find((b) => b.id === ctx.breakpointId);
    let value = styles.base[key];
    let source = 'base';
    if (target) {
      for (const bp of breakpoints) {
        if (bp.minWidth <= target.minWidth) {
          const layerValue = styles.breakpoints?.[bp.id]?.[key];
          if (layerValue !== undefined) {
            value = layerValue as StyleDecl[K];
            source = bp.id;
          }
        }
      }
    }
    return {
      value,
      source,
      local: !ctx.state && source === ctx.breakpointId,
      contextual: true,
    };
  }
  return {
    value: styles.base[key],
    source: 'base',
    local: !ctx.state,
    contextual: ctx.state !== null,
  };
}

/** Read a derived value per selected node (for nested/virtual fields). */
export function useStyleDerived<T>(
  read: (decl: StyleDecl, node: PitoletNode) => T,
): StyleReadout<T> {
  const values = useEditor(
    useShallow((s) =>
      s.selection.map((id) => {
        if (!s.doc) return undefined;
        const target = effectiveInspectorTarget(s.doc, id, s.editingInstanceOverride);
        return target
          ? read(
              resolveStyleDeclAtContext(target.styles, s.editingContext, s.doc.breakpoints),
              target.node,
            )
          : undefined;
      }),
    ),
  );
  return toReadout(values as (T | undefined)[]);
}

export function useSelectedNodes(): PitoletNode[] {
  return useEditor(
    useShallow((s) =>
      s.selection
        .map((id) =>
          s.doc ? effectiveInspectorTarget(s.doc, id, s.editingInstanceOverride)?.node : undefined,
        )
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
  const visibleBaseById = new Map<string, StyleDecl>();
  const inheritedById = new Map<string, StyleDecl>();
  if (store.doc) {
    for (const id of ids) {
      const target = effectiveInspectorTarget(store.doc, id, store.editingInstanceOverride);
      if (!target) continue;
      visibleBaseById.set(id, target.styles.base);
      if (!editingContext.state && !editingContext.breakpointId) continue;
      inheritedById.set(
        id,
        editingContext.state
          ? resolveStyleDeclAtContext(
              target.styles,
              { breakpointId: editingContext.breakpointId, state: null },
              store.doc.breakpoints,
            )
          : resolveStyleDeclBeforeBreakpoint(
              target.styles,
              editingContext.breakpointId!,
              store.doc.breakpoints,
            ),
      );
    }
  }
  store.dispatchEdit(
    label,
    (draft) => {
      for (const id of ids) {
        const node = draft.nodes[id];
        if (!node) continue;
        if (node.type === 'instance' && store.editingInstanceOverride?.instanceId === node.id) {
          const target = draft.nodes[store.editingInstanceOverride.nodeId];
          if (!target) continue;
          const override = (node.overrides[target.id] = node.overrides[target.id] ?? {});
          override.styles = override.styles ?? {};
          write(
            inheritedStyleProxy(
              override.styles as StyleDecl,
              visibleBaseById.get(id) ?? target.styles.base,
            ),
            target as PitoletNode,
          );
          if (Object.keys(override.styles).length === 0) delete override.styles;
          if (Object.keys(override).length === 0) delete node.overrides[target.id];
          continue;
        }
        if (editingVariant) {
          // Variant patches are intentionally a base-style delta. Entering a
          // responsive/state context exits variant editing in the store, so a
          // contextual edit can never leak into this flat patch by accident.
          const rootId = rootFrameOf(draft.nodes as Record<string, PitoletNode>, id);
          const root = draft.nodes[rootId];
          if (root?.type === 'frame' && root.isComponentMaster === editingVariant.componentId) {
            const component = draft.components[root.isComponentMaster];
            if (component) {
              component.variants[editingVariant.key] = component.variants[editingVariant.key] ?? {};
              const bucket = component.variants[editingVariant.key]!;
              bucket[id] = bucket[id] ?? {};
              bucket[id]!.styles = bucket[id]!.styles ?? {};
              write(
                inheritedStyleProxy(
                  bucket[id]!.styles as StyleDecl,
                  visibleBaseById.get(id) ?? node.styles.base,
                ),
                node as PitoletNode,
              );
              if (Object.keys(bucket[id]!.styles ?? {}).length === 0) delete bucket[id]!.styles;
              if (Object.keys(bucket[id] ?? {}).length === 0) delete bucket[id];
              if (Object.keys(bucket).length === 0) delete component.variants[editingVariant.key];
              continue;
            }
          }
        }
        if (editingContext.state) {
          node.styles.states = node.styles.states ?? {};
          const stateKey = editingContext.state;
          node.styles.states[stateKey] = node.styles.states[stateKey] ?? {};
          const inherited =
            inheritedById.get(id) ??
            resolveStyleDeclAtContext(
              node.styles,
              { breakpointId: editingContext.breakpointId, state: null },
              draft.breakpoints,
            );
          write(
            inheritedStyleProxy(node.styles.states[stateKey] as StyleDecl, inherited),
            node as PitoletNode,
          );
          if (Object.keys(node.styles.states[stateKey] ?? {}).length === 0) {
            delete node.styles.states[stateKey];
            if (Object.keys(node.styles.states).length === 0) delete node.styles.states;
          }
          continue;
        }
        if (editingContext.breakpointId) {
          node.styles.breakpoints = node.styles.breakpoints ?? {};
          const bp = editingContext.breakpointId;
          node.styles.breakpoints[bp] = node.styles.breakpoints[bp] ?? {};
          const inherited =
            inheritedById.get(id) ??
            resolveStyleDeclBeforeBreakpoint(node.styles, bp, draft.breakpoints);
          write(
            inheritedStyleProxy(node.styles.breakpoints[bp] as StyleDecl, inherited),
            node as PitoletNode,
          );
          if (Object.keys(node.styles.breakpoints[bp] ?? {}).length === 0) {
            delete node.styles.breakpoints[bp];
            if (Object.keys(node.styles.breakpoints).length === 0) delete node.styles.breakpoints;
          }
          continue;
        }
        write(node.styles.base as StyleDecl, node as PitoletNode);
      }
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

/**
 * Resolve the declaration visible in an inspector context. This is also used
 * by derived controls (individual radius/spacing fields), which previously
 * read base styles even while their scalar neighbours read the active layer.
 */
export function resolveStyleDeclAtContext(
  styles: StyleSheet,
  ctx: { breakpointId: string | null; state: string | null },
  breakpoints: Array<{ id: string; minWidth: number }>,
): StyleDecl {
  const resolved: StyleDecl = { ...styles.base };
  if (ctx.breakpointId) {
    const target = breakpoints.find((breakpoint) => breakpoint.id === ctx.breakpointId);
    if (target) {
      for (const breakpoint of [...breakpoints].sort((a, b) => a.minWidth - b.minWidth)) {
        if (breakpoint.minWidth > target.minWidth) break;
        Object.assign(resolved, styles.breakpoints?.[breakpoint.id]);
      }
    }
  }
  if (ctx.state) {
    Object.assign(resolved, styles.states?.[ctx.state as keyof NonNullable<StyleSheet['states']>]);
  }
  return resolved;
}

function resolveStyleDeclBeforeBreakpoint(
  styles: StyleSheet,
  breakpointId: string,
  breakpoints: Array<{ id: string; minWidth: number }>,
): StyleDecl {
  const resolved: StyleDecl = { ...styles.base };
  const target = breakpoints.find((breakpoint) => breakpoint.id === breakpointId);
  if (!target) return resolved;
  for (const breakpoint of [...breakpoints].sort((a, b) => a.minWidth - b.minWidth)) {
    if (breakpoint.minWidth >= target.minWidth) break;
    Object.assign(resolved, styles.breakpoints?.[breakpoint.id]);
  }
  return resolved;
}

/**
 * Lazily seeds a compound value from the inherited declaration the first time
 * a writer reads it. Code such as `decl.border && ...` now edits a local copy
 * instead of silently doing nothing, without copying unrelated inherited
 * properties into the responsive/state layer.
 */
function inheritedStyleProxy(local: StyleDecl, inherited: StyleDecl): StyleDecl {
  return new Proxy(local, {
    get(target, property, receiver) {
      if (
        typeof property === 'string' &&
        Reflect.get(target, property, receiver) === undefined &&
        inherited[property as keyof StyleDecl] !== undefined
      ) {
        Reflect.set(
          target,
          property,
          cloneStyleValue(inherited[property as keyof StyleDecl]),
          receiver,
        );
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function cloneStyleValue<T>(value: T): T {
  return value == null || typeof value !== 'object'
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

export function effectiveInspectorNode(
  doc: PitoletDocument,
  selectedId: string,
  editingOverride: { instanceId: string; nodeId: string } | null,
): PitoletNode | undefined {
  return effectiveInspectorTarget(doc, selectedId, editingOverride)?.node;
}

export function effectiveInspectorStyleSheet(
  doc: PitoletDocument,
  selectedId: string,
  editingOverride: { instanceId: string; nodeId: string } | null,
): StyleSheet | undefined {
  return effectiveInspectorTarget(doc, selectedId, editingOverride)?.styles;
}

function effectiveInspectorTarget(
  doc: PitoletDocument,
  selectedId: string,
  editingOverride: { instanceId: string; nodeId: string } | null,
): { node: PitoletNode; styles: StyleSheet } | undefined {
  const selected = doc.nodes[selectedId];
  if (!selected) return undefined;
  if (selected.type !== 'instance') return { node: selected, styles: selected.styles };

  const component = doc.components[selected.componentId];
  if (!component) return { node: selected, styles: selected.styles };
  const editingInner = editingOverride?.instanceId === selected.id;
  const targetId = editingInner ? editingOverride.nodeId : component.contentRootId;
  const target = doc.nodes[targetId];
  if (!target) return { node: selected, styles: selected.styles };

  const base = componentContentBaseStyles(component, target);
  for (const key of matchingVariantKeys(selected.variant, component.variantProps)) {
    const patch = component.variants[key]?.[targetId];
    if (patch?.styles) Object.assign(base, patch.styles);
  }
  const override = selected.overrides[targetId];
  if (override?.styles) Object.assign(base, override.styles);
  let styles: StyleSheet = { ...target.styles, base };
  if (!editingInner) styles = mergeStyleSheets(styles, selected.styles);
  return { node: target, styles };
}

function mergeStyleSheets(base: StyleSheet, override: StyleSheet): StyleSheet {
  const breakpoints = { ...base.breakpoints };
  for (const [key, layer] of Object.entries(override.breakpoints ?? {})) {
    breakpoints[key] = { ...breakpoints[key], ...layer };
  }
  const states = { ...base.states };
  for (const state of ['hover', 'focus', 'active'] as const) {
    const layer = override.states?.[state];
    if (layer) states[state] = { ...states[state], ...layer };
  }
  return {
    base: { ...base.base, ...override.base },
    ...(Object.keys(breakpoints).length > 0 ? { breakpoints } : {}),
    ...(Object.keys(states).length > 0 ? { states } : {}),
  };
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
  if (values.length === 0) {
    return {
      value: null,
      mixed: false,
      first: undefined,
      overridden: false,
      partiallyOverridden: false,
      source: null,
      contextual: false,
    };
  }
  const first = values[0];
  const allEqual = values.every((v) => deepEqual(v, first));
  return {
    value: allEqual ? (first ?? null) : null,
    mixed: !allEqual,
    first,
    overridden: false,
    partiallyOverridden: false,
    source: null,
    contextual: false,
  };
}

function toContextReadout<T>(readings: Array<StyleContextReading<T> | undefined>): StyleReadout<T> {
  const valid = readings.filter((reading): reading is StyleContextReading<T> => reading != null);
  if (valid.length === 0) return toReadout([]);
  const base = toReadout(valid.map((reading) => reading.value));
  const localCount = valid.filter((reading) => reading.local).length;
  const firstSource = valid[0]!.source;
  const sameSource = valid.every((reading) => reading.source === firstSource);
  return {
    ...base,
    overridden: localCount === valid.length,
    partiallyOverridden: localCount > 0 && localCount < valid.length,
    source: sameSource ? firstSource : 'mixed',
    contextual: valid.some((reading) => reading.contextual),
  };
}

/** Delete a property from the active responsive/state layer across the selection. */
export function resetStyleProperty<K extends keyof StyleDecl>(label: string, key: K): void {
  setStyle(label, (decl) => {
    delete decl[key];
  });
}

/** Build the small inherited/local indicator consumed by inspector rows. */
export function styleContextFor<K extends keyof StyleDecl>(
  readout: StyleReadout<StyleDecl[K]>,
  key: K,
  label: string,
) {
  if (!readout.contextual) return undefined;
  return {
    source: readout.source,
    overridden: readout.overridden,
    partiallyOverridden: readout.partiallyOverridden,
    onReset:
      readout.overridden || readout.partiallyOverridden
        ? () => resetStyleProperty(`Reset ${label}`, key)
        : undefined,
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
