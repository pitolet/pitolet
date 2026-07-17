import { createSampleDocument } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { getSelectionActionState } from '../src/commands/selectionActions.js';

describe('getSelectionActionState', () => {
  it('enables grouping only for editable siblings', () => {
    const doc = createSampleDocument();
    const parent = Object.values(doc.nodes).find(
      (node) => node.parent !== null && node.children.length >= 2,
    );
    expect(parent).toBeDefined();
    if (!parent) return;

    const siblings = parent.children.slice(0, 2);
    expect(getSelectionActionState(doc, siblings)).toMatchObject({
      hasSelection: true,
      editable: true,
      canGroup: true,
      allLocked: false,
      allHidden: false,
    });

    doc.nodes[siblings[0]!]!.locked = true;
    expect(getSelectionActionState(doc, siblings)).toMatchObject({
      editable: false,
      canGroup: false,
    });
  });

  it('reports the shared lock and visibility state of the selection', () => {
    const doc = createSampleDocument();
    const parent = Object.values(doc.nodes).find((node) => node.children.length >= 2);
    expect(parent).toBeDefined();
    if (!parent) return;

    const selection = parent.children.slice(0, 2);
    selection.forEach((id) => {
      doc.nodes[id]!.locked = true;
      doc.nodes[id]!.visible = false;
    });

    expect(getSelectionActionState(doc, selection)).toMatchObject({
      allLocked: true,
      allHidden: true,
    });
  });

  it('rejects missing nodes and selections across different parents', () => {
    const doc = createSampleDocument();
    const nested = Object.values(doc.nodes).find((node) => node.parent !== null);
    const root = doc.rootOrder[0];
    expect(nested).toBeDefined();
    expect(root).toBeDefined();
    if (!nested || !root) return;

    expect(getSelectionActionState(doc, [nested.id, root]).canGroup).toBe(false);
    expect(getSelectionActionState(doc, ['missing'])).toMatchObject({
      hasSelection: false,
      editable: false,
      canGroup: false,
    });
  });

  it('keeps generic delete and duplicate actions away from component masters', () => {
    const doc = createSampleDocument();
    const rootId = doc.rootOrder[0]!;
    const root = doc.nodes[rootId]!;
    expect(root.type).toBe('frame');
    if (root.type !== 'frame') return;
    root.isComponentMaster = 'button';
    doc.components.button = {
      id: 'button',
      name: 'Button',
      rootId,
      contentRootId: rootId,
      variantProps: [],
      variants: {},
    };

    expect(getSelectionActionState(doc, [rootId])).toMatchObject({
      hasSelection: true,
      editable: false,
      containsComponentMaster: true,
    });
  });

  it('reports visibility from the active component variant', () => {
    const doc = createSampleDocument();
    const rootId = doc.rootOrder[0]!;
    const childId = doc.nodes[rootId]!.children[0]!;
    const root = doc.nodes[rootId]!;
    if (root.type !== 'frame') throw new Error('expected frame');
    root.isComponentMaster = 'hero';
    doc.components.hero = {
      id: 'hero',
      name: 'Hero',
      rootId,
      contentRootId: rootId,
      variantProps: [{ name: 'mode', values: ['show', 'hide'], default: 'show' }],
      variants: { 'mode=hide': { [childId]: { visible: false } } },
    };

    expect(getSelectionActionState(doc, [childId]).allHidden).toBe(false);
    expect(
      getSelectionActionState(doc, [childId], {
        componentId: 'hero',
        key: 'mode=hide',
      }).allHidden,
    ).toBe(true);
  });

  it('allows duplicating but not deleting a component content root', () => {
    const doc = createSampleDocument();
    const rootId = doc.rootOrder[0]!;
    const contentRootId = doc.nodes[rootId]!.children[0]!;
    const root = doc.nodes[rootId]!;
    if (root.type !== 'frame') throw new Error('expected frame');
    root.isComponentMaster = 'hero';
    doc.components.hero = {
      id: 'hero',
      name: 'Hero',
      rootId,
      contentRootId,
      variantProps: [],
      variants: {},
    };

    expect(getSelectionActionState(doc, [contentRootId])).toMatchObject({
      editable: true,
      canDuplicate: true,
      canDelete: false,
      containsComponentContentRoot: true,
    });
  });
});
