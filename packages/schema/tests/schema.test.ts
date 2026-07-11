import { describe, expect, it } from 'vitest';
import {
  attach,
  cloneSubtree,
  colorToCss,
  createDocument,
  createElement,
  createFrame,
  createText,
  mergeCascade,
  oklch,
  parseColor,
  pruneCommentsForNodes,
  px,
  resolveStyles,
  sides,
  structuralProblems,
  styleToCssProps,
  subtreeIds,
  validateDocument,
  type PitoletComment,
  type StyleSheet,
} from '../src/index.js';

function sampleDoc() {
  const doc = createDocument({ name: 'Test' });
  const frame = attach(doc, null, createFrame({ name: 'Home', width: 1280, height: 800 }));
  const hero = attach(doc, frame.id, createElement({ name: 'Hero' }));
  const title = attach(doc, hero.id, createText({ tag: 'h1', text: 'Hello' }));
  return { doc, frame, hero, title };
}

describe('factory + zod', () => {
  it('factory output round-trips through validation', () => {
    const { doc } = sampleDoc();
    const parsed = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });

  it('rejects unknown style properties', () => {
    const { doc, hero } = sampleDoc();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.nodes[hero.id].styles.base.bogus = 12;
    expect(() => validateDocument(raw)).toThrow();
  });

  it('rejects malformed nodes (fuzzed field deletion)', () => {
    const { doc, title } = sampleDoc();
    for (const field of ['id', 'type', 'styles', 'children', 'content']) {
      const raw = JSON.parse(JSON.stringify(doc));
      delete raw.nodes[title.id][field];
      expect(() => validateDocument(raw), `deleting ${field} should fail`).toThrow();
    }
  });

  it('finds structural incoherence', () => {
    const { doc, hero } = sampleDoc();
    const broken = structuredClone(doc);
    broken.nodes[hero.id]!.parent = 'nonexistent';
    expect(structuralProblems(broken).length).toBeGreaterThan(0);
    expect(structuralProblems(doc)).toEqual([]);
  });
});

describe('comments', () => {
  it('round-trips through validation and prunes on node delete', () => {
    const { doc, title } = sampleDoc();
    const comment: PitoletComment = {
      id: 'c1',
      nodeId: title.id,
      text: 'make bigger',
      author: 'agent',
      createdAt: 1_700_000_000_000,
    };
    doc.comments = { c1: comment };
    const parsed = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed.comments!.c1).toEqual(comment);

    pruneCommentsForNodes(doc.comments, [title.id]);
    expect(doc.comments.c1).toBeUndefined();
  });

  it('rejects malformed comments', () => {
    const { doc, title } = sampleDoc();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.comments = { bad: { id: 'bad', nodeId: title.id, author: 'you', createdAt: 0 } }; // no text
    expect(() => validateDocument(raw)).toThrow();
  });
});

describe('cascade resolution', () => {
  const breakpoints = [
    { id: 'sm', name: 'S', minWidth: 640 },
    { id: 'md', name: 'M', minWidth: 768 },
    { id: 'lg', name: 'L', minWidth: 1024 },
  ];

  const sheet: StyleSheet = {
    base: { opacity: 0.5, padding: sides(px(8)) },
    breakpoints: {
      md: { opacity: 0.8 },
      lg: { opacity: 1, padding: sides(px(32)) },
    },
    states: { hover: { opacity: 0.1 } },
  };

  it('applies only layers at or below frame width, ascending', () => {
    expect(mergeCascade(sheet, 375, breakpoints).opacity).toBe(0.5);
    expect(mergeCascade(sheet, 800, breakpoints).opacity).toBe(0.8);
    expect(mergeCascade(sheet, 1280, breakpoints).opacity).toBe(1);
    expect(mergeCascade(sheet, 1280, breakpoints).padding).toEqual(sides(px(32)));
    expect(mergeCascade(sheet, 800, breakpoints).padding).toEqual(sides(px(8)));
  });

  it('applies active states on top', () => {
    expect(mergeCascade(sheet, 1280, breakpoints, ['hover']).opacity).toBe(0.1);
  });

  it('resolves token refs and drops unknown tokens', () => {
    const doc = createDocument();
    const resolved = resolveStyles(
      {
        base: {
          color: { $token: 'color.primary' },
          fontSize: { $token: 'typography.fontSize.nope' },
        },
      },
      { frameWidth: 1280, breakpoints: doc.breakpoints, tokens: doc.tokens },
    );
    expect(resolved.color).toEqual(doc.tokens.color.primary!.$value);
    expect(resolved.fontSize).toBeUndefined();
  });
});

describe('css conversion', () => {
  it('maps layout, box, and appearance', () => {
    const css = styleToCssProps({
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'between',
      gap: { row: px(8), column: px(12) },
      padding: sides(px(16)),
      width: px(320),
      fills: [{ type: 'solid', color: oklch(1, 0, 0) }],
      radius: { tl: px(8), tr: px(8), br: px(8), bl: px(8) },
    });
    expect(css.display).toBe('flex');
    expect(css.alignItems).toBe('flex-start'.replace('flex-start', 'center')); // center passes through
    expect(css.justifyContent).toBe('space-between');
    expect(css.gap).toBe('8px 12px');
    expect(css.paddingTop).toBe('16px');
    expect(css.width).toBe('320px');
    expect(css.backgroundColor).toBe('oklch(1 0 0)');
    expect(css.borderRadius).toBe('8px');
  });

  it('translates fill sizing by flex context', () => {
    const inRow = styleToCssProps(
      { width: 'fill' },
      { parentDisplay: 'flex', parentDirection: 'row' },
    );
    expect(inRow.flexGrow).toBe(1);
    expect(inRow.flexBasis).toBe('0%');

    const crossAxis = styleToCssProps(
      { width: 'fill' },
      { parentDisplay: 'flex', parentDirection: 'column' },
    );
    expect(crossAxis.alignSelf).toBe('stretch');

    const inBlock = styleToCssProps({ width: 'fill' }, { parentDisplay: 'block' });
    expect(inBlock.width).toBe('100%');
  });

  it('layers multiple fills with top layer first', () => {
    const css = styleToCssProps({
      fills: [
        { type: 'solid', color: oklch(1, 0, 0) },
        { type: 'linear', angle: 90, stops: [
          { color: oklch(0.5, 0.1, 200), position: 0 },
          { color: oklch(0.8, 0.1, 200, 0.5), position: 1 },
        ] },
      ],
    });
    expect(String(css.backgroundImage).startsWith('linear-gradient(90deg')).toBe(true);
    expect(String(css.backgroundImage)).toContain('linear-gradient(oklch(1 0 0), oklch(1 0 0))');
  });
});

describe('color', () => {
  it('round-trips hex through oklch', () => {
    const c = parseColor('#3b82f6')!;
    expect(c.space).toBe('oklch');
    expect(colorToCss(c)).toMatch(/^oklch\(/);
  });
});

describe('traverse', () => {
  it('clones subtrees with fresh, consistent ids', () => {
    const { doc, hero, title } = sampleDoc();
    const clone = cloneSubtree(doc.nodes, hero.id);
    expect(clone.rootId).not.toBe(hero.id);
    const cloneRoot = clone.nodes[clone.rootId]!;
    expect(cloneRoot.parent).toBeNull();
    expect(cloneRoot.children).toHaveLength(1);
    const clonedTitle = clone.nodes[cloneRoot.children[0]!]!;
    expect(clonedTitle.id).not.toBe(title.id);
    expect(clonedTitle.parent).toBe(clone.rootId);
    if (clonedTitle.type === 'text') expect(clonedTitle.content[0]!.text).toBe('Hello');
  });

  it('subtreeIds walks depth-first', () => {
    const { doc, frame, hero, title } = sampleDoc();
    expect(subtreeIds(doc.nodes, frame.id)).toEqual([frame.id, hero.id, title.id]);
  });
});
