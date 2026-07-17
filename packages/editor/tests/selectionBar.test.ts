import { createSampleDocument } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { selectionPath } from '../src/panels/SelectionBar.js';

describe('selectionPath', () => {
  it('returns the full hierarchy from the root frame to the selected layer', () => {
    const doc = createSampleDocument();
    const leaf = Object.values(doc.nodes).find((node) => node.parent && node.children.length === 0);
    expect(leaf).toBeDefined();
    if (!leaf) return;

    const path = selectionPath(doc, leaf.id);
    expect(path.at(-1)?.id).toBe(leaf.id);
    expect(path[0]?.parent).toBeNull();
    for (let index = 1; index < path.length; index++) {
      expect(path[index]?.parent).toBe(path[index - 1]?.id);
    }
  });

  it('returns an empty path for a missing node', () => {
    expect(selectionPath(createSampleDocument(), 'missing')).toEqual([]);
  });
});
