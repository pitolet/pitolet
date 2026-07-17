import { attach, createDocument, createElement, createFrame } from '@pitolet/schema';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { duplicateNodes, selectionRoots } from '../src/store/mutations.js';

describe('selection-root mutations', () => {
  it('duplicates an ancestor and descendant selection only once', () => {
    const doc = createDocument({ name: 'Duplicate roots' });
    const frame = attach(doc, null, createFrame());
    const parent = attach(doc, frame.id, createElement({ name: 'Parent' }));
    const child = attach(doc, parent.id, createElement({ name: 'Child' }));

    expect(selectionRoots(doc.nodes, [parent.id, child.id, parent.id])).toEqual([parent.id]);
    let clones: string[] = [];
    const next = produce(doc, (draft) => {
      clones = duplicateNodes(draft, [parent.id, child.id]);
    });
    expect(clones).toHaveLength(1);
    expect(Object.keys(next.nodes)).toHaveLength(Object.keys(doc.nodes).length + 2);
    expect(next.nodes[frame.id]!.children).toHaveLength(2);
  });
});
