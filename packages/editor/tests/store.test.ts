import { createSampleDocument, type PatchOp } from '@pitolet/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { history, setPatchSender, useEditor, type OutgoingPatch } from '../src/store/index.js';
import { deleteNodes } from '../src/store/mutations.js';

describe('editor store', () => {
  let sent: OutgoingPatch[];

  beforeEach(() => {
    sent = [];
    history.clear();
    setPatchSender((p) => sent.push(p));
    useEditor.getState().setDocument(createSampleDocument(), 0);
    sent = []; // setDocument sends nothing, but reset for clarity
  });

  it('dispatchEdit applies optimistically, records history, sends the patch', () => {
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Renamed';
    });
    expect(useEditor.getState().doc?.name).toBe('Renamed');
    expect(history.canUndo).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.label).toBe('Rename');
  });

  it('retains a fatal connection error until a connection or document succeeds', () => {
    const store = useEditor.getState();
    store.setConnectionError('Could not load workspace');
    expect(useEditor.getState().connectionError).toBe('Could not load workspace');

    store.setConnected(true);
    expect(useEditor.getState().connectionError).toBeNull();

    store.setConnectionError('Empty workspace');
    store.setDocument(createSampleDocument(), 0);
    expect(useEditor.getState().connectionError).toBeNull();
  });

  it('undo reverts and sends an inverse patch; redo re-applies', () => {
    const store = useEditor.getState();
    store.dispatchEdit('Rename', (draft) => {
      draft.name = 'Renamed';
    });
    store.undo();
    expect(useEditor.getState().doc?.name).toBe('Welcome');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.label).toBe('Undo Rename');

    store.redo();
    expect(useEditor.getState().doc?.name).toBe('Renamed');
    expect(sent[2]!.label).toBe('Redo Rename');
  });

  it('remote patches apply and are locally undoable', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    const ops: PatchOp[] = [{ op: 'replace', path: ['nodes', frameId, 'canvas', 'x'], value: 999 }];
    store.applyRemotePatch(ops, 1, 'MCP: move', 'mcp');

    const node = useEditor.getState().doc!.nodes[frameId]!;
    expect(node.type === 'frame' && node.canvas.x).toBe(999);

    useEditor.getState().undo();
    const reverted = useEditor.getState().doc!.nodes[frameId]!;
    expect(reverted.type === 'frame' && reverted.canvas.x).toBe(120);
    // The undo went to the server as a new patch.
    expect(sent.at(-1)!.label).toBe('Undo MCP: move');
  });

  it('reject rolls back the optimistic apply and drops the history entry', () => {
    const store = useEditor.getState();
    store.dispatchEdit('Rename', (draft) => {
      draft.name = 'Doomed';
    });
    const patchId = sent[0]!.patchId;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useEditor.getState().handleReject(patchId, 'test rejection');
    warn.mockRestore();

    expect(useEditor.getState().doc?.name).toBe('Welcome');
    expect(history.canUndo).toBe(false);
  });

  it('deleting a node prunes it from selection and removes its subtree', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    const heroId = store.doc!.nodes[frameId]!.children[1]!;
    store.select([heroId]);
    const nodeCountBefore = Object.keys(store.doc!.nodes).length;

    useEditor.getState().dispatchEdit('Delete node', (draft) => deleteNodes(draft, [heroId]));

    const state = useEditor.getState();
    expect(state.doc!.nodes[heroId]).toBeUndefined();
    expect(state.selection).toEqual([]);
    expect(Object.keys(state.doc!.nodes).length).toBeLessThan(nodeCountBefore - 1);
    expect(state.doc!.nodes[frameId]!.children).not.toContain(heroId);

    // Undo restores the whole subtree.
    state.undo();
    expect(Object.keys(useEditor.getState().doc!.nodes).length).toBe(nodeCountBefore);
  });

  it('remote patch actor becomes the activity entry actorName; absent = undefined; different actors do not coalesce', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    const ops: PatchOp[] = [{ op: 'replace', path: ['nodes', frameId, 'canvas', 'x'], value: 1 }];

    const before = useEditor.getState().activity.length;
    store.applyRemotePatch(ops, 1, 'Move Frame', 'editor:peer', { id: 'u1', name: 'Alice' });
    let activity = useEditor.getState().activity;
    expect(activity.length).toBe(before + 1);
    expect(activity[0]!.actorName).toBe('Alice');
    expect(activity[0]!.label).toBe('Move Frame');

    // Same kind+label but a different actor must NOT merge — a new row appears.
    store.applyRemotePatch(ops, 2, 'Move Frame', 'editor:peer', { id: 'u2', name: 'Bob' });
    activity = useEditor.getState().activity;
    expect(activity.length).toBe(before + 2);
    expect(activity[0]!.actorName).toBe('Bob');
    expect(activity[1]!.actorName).toBe('Alice');

    // Same actor + same kind+label DOES still coalesce (one merged row).
    store.applyRemotePatch(ops, 3, 'Move Frame', 'editor:peer', { id: 'u2', name: 'Bob' });
    expect(useEditor.getState().activity.length).toBe(before + 2);

    // No actor → actorName undefined.
    store.applyRemotePatch(ops, 3, 'Anon Edit', 'editor:peer');
    expect(useEditor.getState().activity[0]!.actorName).toBeUndefined();
  });
});
