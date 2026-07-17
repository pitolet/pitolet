import type { StateName, StyleSheet } from '@pitolet/schema';
import { RotateCcw } from 'lucide-react';
import { breakpointDisplayLabel } from '../../canvas/responsivePreview.js';
import { useEditor } from '../../store/index.js';

export interface InspectorEditingContext {
  breakpointId: string | null;
  state: StateName | null;
}

export function contextOverrideCount(
  styles: StyleSheet | undefined,
  context: InspectorEditingContext,
): number {
  if (!styles) return 0;
  if (context.state) return Object.keys(styles.states?.[context.state] ?? {}).length;
  if (context.breakpointId) {
    return Object.keys(styles.breakpoints?.[context.breakpointId] ?? {}).length;
  }
  return 0;
}

/** Remove the active layer and return how many declarations were removed. */
export function clearContextLayer(styles: StyleSheet, context: InspectorEditingContext): number {
  const count = contextOverrideCount(styles, context);
  if (context.state && styles.states) {
    delete styles.states[context.state];
    if (Object.keys(styles.states).length === 0) delete styles.states;
  } else if (context.breakpointId && styles.breakpoints) {
    delete styles.breakpoints[context.breakpointId];
    if (Object.keys(styles.breakpoints).length === 0) delete styles.breakpoints;
  }
  return count;
}

export function contextOverrideLabel(
  context: InspectorEditingContext,
  overrideCount: number,
): string {
  if (overrideCount > 0) {
    return `${overrideCount} ${overrideCount === 1 ? 'override' : 'overrides'}`;
  }
  return context.state ? `No :${context.state} styles yet` : 'Inherited';
}

/** Compact context summary shown above the affected inspector controls. */
export function ResponsiveContextSection() {
  const context = useEditor((state) => state.editingContext);
  const breakpoint = useEditor((state) =>
    state.doc?.breakpoints.find((candidate) => candidate.id === state.editingContext.breakpointId),
  );
  const overrideCount = useEditor((state) => {
    if (!state.doc) return 0;
    return state.selection.reduce(
      (total, id) =>
        total + contextOverrideCount(state.doc!.nodes[id]?.styles, state.editingContext),
      0,
    );
  });

  if (!context.breakpointId && !context.state) return null;

  const contextLabel = context.state
    ? `:${context.state}`
    : breakpoint
      ? breakpointDisplayLabel(breakpoint)
      : context.breakpointId;

  return (
    <div className="ptl-responsive-context" role="status">
      <div className="ptl-responsive-context-copy">
        <strong>
          <code>{contextLabel}</code> styles
        </strong>
        <span className="ptl-responsive-context-meta">
          {breakpoint && <span>{breakpoint.minWidth}px preview</span>}
          {context.state && <span>CSS state</span>}
          <span>{contextOverrideLabel(context, overrideCount)}</span>
        </span>
      </div>
      {overrideCount > 0 && (
        <button
          type="button"
          className="ptl-responsive-context-reset"
          title="Clear these overrides"
          onClick={() => {
            const store = useEditor.getState();
            store.dispatchEdit('Reset responsive overrides', (draft) => {
              for (const id of store.selection) {
                const node = draft.nodes[id];
                if (node) clearContextLayer(node.styles, context);
              }
            });
          }}
        >
          <RotateCcw size={11} />
          Clear
        </button>
      )}
    </div>
  );
}
