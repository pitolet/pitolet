import { createSampleDocument } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import {
  canDropLayer,
  layerRangeSelection,
  layerSearchMatches,
  visibleLayerOrder,
} from '../src/panels/LayersPanel.js';
import { attach, createFrame, createText } from '@pitolet/schema';

describe('layer navigation helpers', () => {
  it('keeps matching layers and their ancestors visible during search', () => {
    const doc = createSampleDocument();
    const headline = Object.values(doc.nodes).find((node) => node.name === 'Headline');
    expect(headline).toBeDefined();
    const matches = layerSearchMatches(doc, 'headline');

    expect(matches?.has(headline!.id)).toBe(true);
    let parent = headline!.parent;
    while (parent) {
      expect(matches?.has(parent)).toBe(true);
      parent = doc.nodes[parent]?.parent ?? null;
    }
  });

  it('omits collapsed descendants from keyboard order', () => {
    const doc = createSampleDocument();
    const pageId = doc.rootOrder[0]!;
    const visible = visibleLayerOrder(doc, new Set([pageId]), null);
    expect(visible).toContain(pageId);
    expect(visible).not.toContain(doc.nodes[pageId]!.children[0]!);
  });

  it('selects a contiguous visible range in either direction', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(layerRangeSelection(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(layerRangeSelection(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(layerRangeSelection(order, 'missing', 'c')).toEqual(['c']);
  });

  it('keeps layer moves on their side of component-master boundaries', () => {
    const doc = createSampleDocument();
    const pageId = doc.rootOrder[0]!;
    const pageChildId = doc.nodes[pageId]!.children[0]!;
    const master = attach(doc, null, createFrame({ name: 'Button', width: 240, height: 80 }));
    const masterChild = attach(doc, master.id, createText({ text: 'Buy' }));
    expect(master.type).toBe('frame');
    if (master.type !== 'frame') return;
    master.isComponentMaster = 'button';
    doc.components.button = {
      id: 'button',
      name: 'Button',
      rootId: master.id,
      contentRootId: master.id,
      variantProps: [],
      variants: {},
    };

    expect(canDropLayer(doc, master.id, pageId, 'after')).toBe(true);
    expect(canDropLayer(doc, master.id, pageId, 'inside')).toBe(false);
    expect(canDropLayer(doc, pageChildId, master.id, 'inside')).toBe(false);
    expect(canDropLayer(doc, masterChild.id, pageId, 'inside')).toBe(false);
    expect(canDropLayer(doc, masterChild.id, master.id, 'inside')).toBe(true);
  });
});
