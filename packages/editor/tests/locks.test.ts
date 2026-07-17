import { createSampleDocument, type PatchOp } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import {
  closestUnlockedAncestor,
  editsLockedNode,
  isEffectivelyLocked,
  lockingNodeIds,
} from '../src/store/locks.js';

describe('layer locks', () => {
  it('protects descendants and clicks through to the nearest unlocked ancestor', () => {
    const doc = createSampleDocument();
    const root = doc.rootOrder[0]!;
    const parent = doc.nodes[root]!.children[1]!;
    const child = doc.nodes[parent]!.children[0]!;
    doc.nodes[parent]!.locked = true;

    expect(isEffectivelyLocked(doc, child)).toBe(true);
    expect(lockingNodeIds(doc, child)).toEqual([parent]);
    expect(closestUnlockedAncestor(doc, child)).toBe(root);

    doc.nodes[root]!.locked = true;
    expect(lockingNodeIds(doc, child)).toEqual([parent, root]);
    expect(closestUnlockedAncestor(doc, child)).toBeNull();
  });

  it('blocks design changes but permits lock and visibility toggles', () => {
    const doc = createSampleDocument();
    const root = doc.rootOrder[0]!;
    doc.nodes[root]!.locked = true;

    const rename: PatchOp[] = [{ op: 'replace', path: ['nodes', root, 'name'], value: 'Nope' }];
    const unlock: PatchOp[] = [{ op: 'replace', path: ['nodes', root, 'locked'], value: false }];
    const hide: PatchOp[] = [{ op: 'replace', path: ['nodes', root, 'visible'], value: false }];

    expect(editsLockedNode(doc, rename)).toBe(true);
    expect(editsLockedNode(doc, unlock)).toBe(false);
    expect(editsLockedNode(doc, hide)).toBe(false);
  });
});
