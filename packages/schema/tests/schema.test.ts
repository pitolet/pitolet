import { describe, expect, it } from 'vitest';
import {
  attach,
  cloneSubtree,
  colorToCss,
  createDocument,
  createElement,
  createFrame,
  createInstance,
  createText,
  mergeCascade,
  migrateDocument,
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
  zClientMessage,
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

  it('accepts explicit responsive resets for item alignment and positioning', () => {
    const { doc, hero } = sampleDoc();
    hero.styles.breakpoints = {
      md: { alignSelf: 'auto', position: 'static', gridTemplateColumns: [], shadows: [] },
    };
    const parsed = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed.nodes[hero.id]?.styles.breakpoints?.md).toMatchObject({
      alignSelf: 'auto',
      position: 'static',
      gridTemplateColumns: [],
      shadows: [],
    });
  });

  it('rejects unknown style properties', () => {
    const { doc, hero } = sampleDoc();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.nodes[hero.id].styles.base.bogus = 12;
    expect(() => validateDocument(raw)).toThrow();
  });

  it('rejects unknown node and nested value properties instead of silently stripping them', () => {
    const { doc, frame, hero } = sampleDoc();
    const unknownNodeField = JSON.parse(JSON.stringify(doc));
    unknownNodeField.nodes[hero.id].unexpected = { executable: true };
    expect(() => validateDocument(unknownNodeField)).toThrow(/unrecognized key/i);

    const unknownLengthField = JSON.parse(JSON.stringify(doc));
    unknownLengthField.nodes[hero.id].styles.base.padding = {
      top: { value: 0, unit: 'px', unexpected: true },
      right: { value: 0, unit: 'px' },
      bottom: { value: 0, unit: 'px' },
      left: { value: 0, unit: 'px' },
    };
    expect(() => validateDocument(unknownLengthField)).toThrow(/unrecognized key/i);

    if (frame.type !== 'frame') throw new Error('expected frame');
    frame.isComponentMaster = 'card';
    doc.components.card = {
      id: 'card',
      name: 'Card',
      rootId: frame.id,
      contentRootId: hero.id,
      variantProps: [{ name: 'tone', values: ['plain'], default: 'plain' }],
      variants: {},
    };
    const unknownVariantPropField = JSON.parse(JSON.stringify(doc));
    unknownVariantPropField.components.card.variantProps[0].unexpected = true;
    expect(() => validateDocument(unknownVariantPropField)).toThrow(/unrecognized key/i);
  });

  it('rejects children inside semantic void elements', () => {
    const { doc, hero } = sampleDoc();
    hero.tag = 'input';
    expect(() => validateDocument(doc)).toThrow(/void element/);
  });

  it('rejects children on leaf node types', () => {
    const { doc, title } = sampleDoc();
    const illegalChild = createElement({ name: 'Illegal child' });
    illegalChild.parent = title.id;
    doc.nodes[illegalChild.id] = illegalChild;
    title.children.push(illegalChild.id);
    expect(() => validateDocument(doc)).toThrow(/text node .* cannot contain children/);
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

  it('rejects cycles, unreachable nodes, and duplicate references during full validation', () => {
    const cycle = sampleDoc();
    cycle.title.children.push(cycle.frame.id);
    cycle.frame.parent = cycle.title.id;
    expect(structuralProblems(cycle.doc)).toContain(
      `document tree contains a cycle at ${cycle.frame.id}`,
    );
    expect(() => validateDocument(cycle.doc)).toThrow(/invalid document structure/);

    const unreachable = sampleDoc();
    const orphan = createElement({ name: 'Orphan' });
    unreachable.doc.nodes[orphan.id] = orphan;
    expect(structuralProblems(unreachable.doc)).toContain(
      `document contains 1 unreachable node(s), including ${orphan.id}`,
    );
    expect(() => validateDocument(unreachable.doc)).toThrow(/unreachable/);

    const duplicate = sampleDoc();
    duplicate.frame.children.push(duplicate.hero.id);
    expect(structuralProblems(duplicate.doc)).toContain(
      `node ${duplicate.frame.id} repeats child ${duplicate.hero.id}`,
    );
    expect(() => validateDocument(duplicate.doc)).toThrow(/repeats child/);
  });

  it('enforces bounded node count and tree depth', () => {
    const countLimited = sampleDoc();
    expect(structuralProblems(countLimited.doc, { maxNodes: 2 })[0]).toMatch(
      /3 nodes; maximum is 2/,
    );

    const deep = createDocument({ name: 'Deep' });
    let parent = attach(deep, null, createFrame({ name: 'Root' }));
    for (let index = 0; index < 4; index += 1) {
      parent = attach(deep, parent.id, createElement({ name: `Level ${index + 1}` }));
    }
    expect(structuralProblems(deep, { maxDepth: 4 })).toContain(
      `document tree exceeds maximum depth 4 at ${parent.id}`,
    );
  });

  it('requires unique ascending breakpoints', () => {
    const { doc } = sampleDoc();
    doc.breakpoints = [
      { id: 'desktop', name: 'Desktop', minWidth: 1200 },
      { id: 'tablet', name: 'Tablet', minWidth: 768 },
    ];
    expect(structuralProblems(doc)).toContain(
      'breakpoints must be sorted by strictly increasing minimum width',
    );
    expect(() => validateDocument(doc)).toThrow(/strictly increasing/);

    doc.breakpoints = [
      { id: 'tablet', name: 'Tablet', minWidth: 768 },
      { id: 'desktop', name: 'Desktop', minWidth: 768 },
    ];
    expect(structuralProblems(doc)).toContain('breakpoints repeat minimum width 768');
    expect(() => validateDocument(doc)).toThrow(/repeat minimum width/);
  });

  it('requires a one-to-one match between component definitions and master frames', () => {
    const { doc } = sampleDoc();
    const rootId = doc.rootOrder[0]!;
    const root = doc.nodes[rootId]!;
    expect(root.type).toBe('frame');
    if (root.type !== 'frame') return;

    doc.components.button = {
      id: 'button',
      name: 'Button',
      rootId,
      contentRootId: rootId,
      variantProps: [],
      variants: {},
    };
    root.isComponentMaster = 'button';
    expect(structuralProblems(doc)).toEqual([]);

    const ghost = structuredClone(root);
    ghost.id = 'ghost-master';
    ghost.isComponentMaster = 'button';
    doc.nodes[ghost.id] = ghost;
    doc.rootOrder.push(ghost.id);
    expect(structuralProblems(doc)).toContain(
      `master frame ${ghost.id} claims component button, whose root is ${rootId}`,
    );

    root.isComponentMaster = 'missing';
    expect(structuralProblems(doc)).toContain(
      `component button root ${rootId} is not marked as its master`,
    );
  });

  it('migrates legacy component content roots once and validates schema version 2', () => {
    const doc = createDocument({ name: 'Legacy kit' });
    const master = attach(doc, null, createFrame({ name: 'Button' }));
    const button = attach(doc, master.id, createElement({ name: 'Button root', tag: 'button' }));
    if (master.type !== 'frame') throw new Error('expected frame');
    master.isComponentMaster = 'button';
    doc.components.button = {
      id: 'button',
      name: 'Button',
      rootId: master.id,
      contentRootId: button.id,
      variantProps: [],
      variants: {},
    };

    const raw = JSON.parse(JSON.stringify(doc));
    raw.schemaVersion = 1;
    delete raw.components.button.contentRootId;
    expect(() => validateDocument(raw)).toThrow();

    const migrated = migrateDocument(raw);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.components.button?.contentRootId).toBe(button.id);
    expect(structuralProblems(migrated)).toEqual([]);
  });

  it('rejects invalid variant selectors, external patches, and nested instances', () => {
    const { doc, frame, hero } = sampleDoc();
    if (frame.type !== 'frame') throw new Error('expected frame');
    frame.isComponentMaster = 'card';
    doc.components.card = {
      id: 'card',
      name: 'Card',
      rootId: frame.id,
      contentRootId: hero.id,
      variantProps: [{ name: 'tone', values: ['plain', 'strong'], default: 'plain' }],
      variants: {},
    };

    const badSelector = structuredClone(doc);
    badSelector.components.card!.variants['tone=missing'] = { [hero.id]: { visible: false } };
    expect(structuralProblems(badSelector)).toContain(
      'component card variant selector tone=missing is not declared',
    );

    const external = attach(doc, null, createFrame({ name: 'Elsewhere' }));
    doc.components.card!.variants['tone=strong'] = { [external.id]: { visible: false } };
    expect(structuralProblems(doc)).toContain(
      `component card variant tone=strong patches node outside its master: ${external.id}`,
    );

    const nested = createInstance({ componentId: 'card' });
    attach(doc, hero.id, nested);
    expect(structuralProblems(doc)).toContain(
      `component card contains nested instance ${nested.id}; nested components are unsupported`,
    );
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
    expect(crossAxis.width).toBe('100%');
    expect(crossAxis.alignSelf).toBeUndefined();

    const inBlock = styleToCssProps({ width: 'fill' }, { parentDisplay: 'block' });
    expect(inBlock.width).toBe('100%');
  });

  it('treats reverse flex directions as the same sizing axis', () => {
    const inReverseRow = styleToCssProps(
      { width: 'fill' },
      { parentDisplay: 'flex', parentDirection: 'row-reverse' },
    );
    expect(inReverseRow).toMatchObject({
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: '0%',
      minWidth: 0,
    });
    expect(inReverseRow.width).toBeUndefined();

    const inReverseColumn = styleToCssProps(
      { width: 'fill' },
      { parentDisplay: 'flex', parentDirection: 'column-reverse' },
    );
    expect(inReverseColumn.width).toBe('100%');
    expect(inReverseColumn.flexGrow).toBeUndefined();
  });

  it('preserves cross-axis alignment when fill is constrained', () => {
    const width = styleToCssProps(
      { width: 'fill', maxWidth: px(880), alignSelf: 'center' },
      { parentDisplay: 'flex', parentDirection: 'column' },
    );
    expect(width).toMatchObject({
      width: '100%',
      maxWidth: '880px',
      alignSelf: 'center',
    });

    const height = styleToCssProps(
      { height: 'fill', maxHeight: px(480), alignSelf: 'end' },
      { parentDisplay: 'flex', parentDirection: 'row' },
    );
    expect(height).toMatchObject({
      height: '100%',
      maxHeight: '480px',
      alignSelf: 'flex-end',
    });
  });

  it('layers multiple fills with top layer first', () => {
    const css = styleToCssProps({
      fills: [
        { type: 'solid', color: oklch(1, 0, 0) },
        {
          type: 'linear',
          angle: 90,
          stops: [
            { color: oklch(0.5, 0.1, 200), position: 0 },
            { color: oklch(0.8, 0.1, 200, 0.5), position: 1 },
          ],
        },
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

  it('subtreeIds terminates on malformed cycles and duplicate edges', () => {
    const { doc, frame, hero, title } = sampleDoc();
    hero.children.push(frame.id);
    frame.children.push(hero.id);
    expect(subtreeIds(doc.nodes, frame.id)).toEqual([frame.id, hero.id, title.id]);
  });
});

describe('wire protocol limits', () => {
  it('rejects deeply nested patch values before applying them', () => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 80; depth += 1) value = { nested: value };
    expect(
      zClientMessage.safeParse({
        t: 'patch',
        docId: 'doc',
        patchId: 'patch',
        baseRev: 0,
        label: 'Hostile nested value',
        ops: [{ op: 'replace', path: ['name'], value }],
      }).success,
    ).toBe(false);
  });
});
