import {
  attach,
  createDocument,
  createFrame,
  createSampleDocument,
  oklch,
  px,
  sides,
  type StyleSheet,
} from '@pitolet/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { breakpointDisplayLabel, responsivePreviewWidth } from '../src/canvas/responsivePreview.js';
import {
  clearContextLayer,
  contextOverrideLabel,
  contextOverrideCount,
} from '../src/inspector/sections/ResponsiveContextSection.js';
import { sizeConstraintWarnings } from '../src/inspector/sections/SizeSection.js';
import { readStyleAtContext, setStyle } from '../src/inspector/useStyle.js';
import { history, setPatchSender, useEditor } from '../src/store/index.js';

const breakpoints = [
  { id: 'sm', minWidth: 640 },
  { id: 'md', minWidth: 768 },
  { id: 'lg', minWidth: 1024 },
];

describe('responsive style provenance', () => {
  const styles: StyleSheet = {
    base: { display: 'flex' },
    breakpoints: {
      sm: { display: 'block' },
      lg: { display: 'grid' },
    },
    states: { hover: { opacity: 0.8 } },
  };

  it('reports the breakpoint a value is inherited from', () => {
    expect(
      readStyleAtContext(styles, 'display', { breakpointId: 'md', state: null }, breakpoints),
    ).toEqual({ value: 'block', source: 'sm', local: false, contextual: true });
  });

  it('treats a state as the active layer even when a breakpoint is selected', () => {
    expect(
      readStyleAtContext(styles, 'display', { breakpointId: 'md', state: 'hover' }, breakpoints),
    ).toEqual({ value: 'block', source: 'sm', local: false, contextual: true });
    expect(
      readStyleAtContext(styles, 'opacity', { breakpointId: 'md', state: 'hover' }, breakpoints),
    ).toEqual({ value: 0.8, source: ':hover', local: true, contextual: true });
  });
});

describe('responsive compound style writes', () => {
  beforeEach(() => {
    history.clear();
    setPatchSender(() => {});
  });

  it('copies inherited compound values before editing one nested field', () => {
    const doc = createDocument({ name: 'Responsive compounds' });
    const frame = attach(
      doc,
      null,
      createFrame({
        styles: {
          border: { width: px(1), style: 'solid', color: oklch(0.5, 0, 0) },
          padding: sides(px(12)),
          radius: { tl: px(4), tr: px(8), br: px(12), bl: px(16) },
          shadows: [{ x: 0, y: 2, blur: 8, spread: 0, color: oklch(0.2, 0, 0) }],
        },
      }),
    );
    const store = useEditor.getState();
    store.setDocument(doc, 0);
    store.setConnected(true);
    store.select([frame.id]);
    store.setEditingContext({ breakpointId: 'md', state: null });

    setStyle('Edit inherited compounds', (decl) => {
      if (decl.border) decl.border.width = px(3);
      if (decl.padding) decl.padding.left = px(24);
      if (decl.radius) decl.radius.tl = px(20);
      if (decl.shadows?.[0]) decl.shadows[0].blur = 16;
    });

    expect(useEditor.getState().doc!.nodes[frame.id]!.styles.breakpoints?.md).toMatchObject({
      border: { width: px(3), style: 'solid', color: oklch(0.5, 0, 0) },
      padding: { top: px(12), right: px(12), bottom: px(12), left: px(24) },
      radius: { tl: px(20), tr: px(8), br: px(12), bl: px(16) },
      shadows: [{ x: 0, y: 2, blur: 16, spread: 0, color: oklch(0.2, 0, 0) }],
    });
  });
});

describe('responsive preview', () => {
  it('temporarily sizes the active frame without requiring a selection', () => {
    const doc = createSampleDocument();
    const rootId = doc.rootOrder[0]!;

    expect(responsivePreviewWidth(rootId, rootId, doc.breakpoints, 'md')).toBe(768);
    expect(responsivePreviewWidth(rootId, rootId, doc.breakpoints, null)).toBeNull();
    expect(responsivePreviewWidth('another-frame', rootId, doc.breakpoints, 'md')).toBeNull();
  });

  it('uses friendly labels for imported breakpoints without changing built-in shorthand', () => {
    expect(breakpointDisplayLabel({ id: 'md', name: 'Medium', minWidth: 768 })).toBe('md');
    expect(breakpointDisplayLabel({ id: 'import-768', name: 'Tablet', minWidth: 768 })).toBe(
      'tablet',
    );
    expect(breakpointDisplayLabel({ id: 'import-920', name: '920px', minWidth: 920 })).toBe(
      '920px',
    );
  });
});

describe('context reset', () => {
  it('counts and clears exactly the active layer', () => {
    const styles: StyleSheet = {
      base: { display: 'flex' },
      breakpoints: { md: { display: 'block', gap: { row: px(8), column: px(8) } } },
      states: { hover: { opacity: 0.8 } },
    };
    const context = { breakpointId: 'md', state: null };
    expect(contextOverrideCount(styles, context)).toBe(2);
    expect(clearContextLayer(styles, context)).toBe(2);
    expect(styles.breakpoints).toBeUndefined();
    expect(styles.states?.hover?.opacity).toBe(0.8);
  });

  it('explains an empty interaction-state layer clearly', () => {
    expect(contextOverrideLabel({ breakpointId: null, state: 'hover' }, 0)).toBe(
      'No :hover styles yet',
    );
    expect(contextOverrideLabel({ breakpointId: 'md', state: null }, 0)).toBe('Inherited');
    expect(contextOverrideLabel({ breakpointId: null, state: 'focus' }, 2)).toBe('2 overrides');
  });
});

describe('size constraint feedback', () => {
  it('warns when constraints conflict or clamp a fixed size', () => {
    expect(
      sizeConstraintWarnings({
        width: px(200),
        minWidth: px(240),
        maxWidth: px(180),
        height: px(500),
        minHeight: undefined,
        maxHeight: px(400),
      }),
    ).toEqual(['Width: minimum is larger than maximum.', 'Height will be clamped to its maximum.']);
  });

  it('does not compare constraints expressed in different units', () => {
    expect(
      sizeConstraintWarnings({
        width: { value: 100, unit: '%' },
        minWidth: px(300),
        maxWidth: undefined,
        height: undefined,
        minHeight: undefined,
        maxHeight: undefined,
      }),
    ).toEqual([]);
  });
});
