import { createSampleDocument, type PatchOp } from '@pitolet/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  history,
  patchAffectsStructure,
  setPatchSender,
  useEditor,
  type OutgoingPatch,
} from '../src/store/index.js';
import { deleteNodes } from '../src/store/mutations.js';

describe('editor store', () => {
  let sent: OutgoingPatch[];

  beforeEach(() => {
    sent = [];
    history.clear();
    setPatchSender((p) => sent.push(p));
    useEditor.getState().setDocument(createSampleDocument(), 0);
    useEditor.getState().setConnected(true);
    sent = []; // setDocument sends nothing, but reset for clarity
  });

  it('dispatchEdit applies optimistically, records history, sends the patch', () => {
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Renamed';
    });
    expect(useEditor.getState().doc?.name).toBe('Renamed');
    expect(history.canUndo).toBe(true);
    expect(useEditor.getState().historyStatus).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Rename',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.label).toBe('Rename');
    expect(useEditor.getState().pendingPatchIds).toEqual([sent[0]!.patchId]);
  });

  it('advances structureVersion only for hierarchy, instance, and lock changes', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    const before = store.structureVersion;

    store.dispatchEdit('Rename', (draft) => {
      draft.nodes[frameId]!.name = 'Renamed frame';
    });
    expect(useEditor.getState().structureVersion).toBe(before);

    store.dispatchEdit('Lock', (draft) => {
      draft.nodes[frameId]!.locked = true;
    });
    expect(useEditor.getState().structureVersion).toBe(before + 1);
    expect(
      patchAffectsStructure([
        { op: 'replace', path: ['nodes', frameId, 'styles', 'base', 'opacity'], value: 0.5 },
      ]),
    ).toBe(false);
  });

  it('shows pending work until the matching server acknowledgement arrives', () => {
    const before = Date.now();
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Renamed';
    });
    const patchId = sent[0]!.patchId;

    expect(useEditor.getState().pendingPatchIds).toEqual([patchId]);
    useEditor.getState().handleAck(patchId, 1);

    expect(useEditor.getState().pendingPatchIds).toEqual([]);
    expect(useEditor.getState().docRev).toBe(1);
    expect(useEditor.getState().lastSavedAt).toBeGreaterThanOrEqual(before);
  });

  it('pauses local edits while disconnected instead of applying unsent work', () => {
    const store = useEditor.getState();
    store.setConnected(false);
    store.dispatchEdit('Rename', (draft) => {
      draft.name = 'Would be lost';
    });

    expect(useEditor.getState().doc?.name).toBe('Welcome');
    expect(useEditor.getState().syncIssue).toBe('Editing is paused until Pitolet reconnects.');
    expect(sent).toHaveLength(0);
  });

  it('returns mutation tools and inline editing to a safe state when editing pauses', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;

    store.setTool('text');
    store.setEditingText(frameId);
    expect(useEditor.getState()).toMatchObject({
      activeTool: 'text',
      editingTextId: frameId,
    });

    store.setSwitchingDocument(true);
    expect(useEditor.getState()).toMatchObject({
      activeTool: 'select',
      editingTextId: null,
    });
    store.setTool('frame');
    store.setEditingText(frameId);
    expect(useEditor.getState().activeTool).toBe('select');
    expect(useEditor.getState().editingTextId).toBeNull();

    store.setSwitchingDocument(false);
    store.setTool('frame');
    expect(useEditor.getState().activeTool).toBe('frame');

    store.setConnected(false);
    expect(useEditor.getState().activeTool).toBe('select');
    store.setTool('element');
    store.setEditingText(frameId);
    expect(useEditor.getState().activeTool).toBe('select');
    expect(useEditor.getState().editingTextId).toBeNull();

    store.setConnected(true);
    store.setTool('element');
    store.setReadOnly(true);
    expect(useEditor.getState()).toMatchObject({
      activeTool: 'select',
      editingTextId: null,
    });
    store.setTool('text');
    store.setEditingText(frameId);
    expect(useEditor.getState().activeTool).toBe('select');
    expect(useEditor.getState().editingTextId).toBeNull();
    store.setReadOnly(false);
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

  it('scopes variant editing to a component and clears it when the document changes', () => {
    const store = useEditor.getState();
    store.setEditingVariant('button', 'state=hover');
    expect(useEditor.getState().editingVariant).toEqual({
      componentId: 'button',
      key: 'state=hover',
    });

    store.setDocument(createSampleDocument(), 1);
    expect(useEditor.getState().editingVariant).toBeNull();
  });

  it('publishes a focus request and clears it with the next document', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    store.requestFocusNode(frameId);
    expect(useEditor.getState().focusNodeRequest).toMatchObject({ id: frameId });

    store.setDocument(createSampleDocument(), 1);
    expect(useEditor.getState().focusNodeRequest).toBeNull();
  });

  it('keeps a responsive preview attached to an active frame without a selection', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    const frame = store.doc!.nodes[frameId]!;
    expect(frame.type).toBe('frame');
    if (frame.type !== 'frame') return;
    const childId = frame.children[0]!;

    expect(store.responsivePreviewFrameId).toBe(frameId);
    store.select([childId]);
    store.setEditingContext({ breakpointId: store.doc!.breakpoints[0]!.id, state: null });
    store.select([]);

    expect(useEditor.getState().responsivePreviewFrameId).toBe(frameId);
    expect(useEditor.getState().editingContext.breakpointId).toBe(store.doc!.breakpoints[0]!.id);
  });

  it('requires a selected layer for interaction-state editing', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;

    store.select([]);
    store.setEditingContext({ breakpointId: null, state: 'hover' });
    expect(useEditor.getState().editingContext.state).toBeNull();

    store.select([frameId]);
    store.setEditingContext({ breakpointId: null, state: 'hover' });
    expect(useEditor.getState().editingContext.state).toBe('hover');

    store.select([]);
    expect(useEditor.getState().editingContext.state).toBeNull();
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
    expect(useEditor.getState().historyStatus).toMatchObject({
      canUndo: false,
      canRedo: true,
      redoLabel: 'Rename',
    });

    store.redo();
    expect(useEditor.getState().doc?.name).toBe('Renamed');
    expect(sent[2]!.label).toBe('Redo Rename');
    expect(useEditor.getState().historyStatus).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Rename',
    });
  });

  it('blocks design edits to locked layers but still allows unlocking them', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    store.dispatchEdit('Lock', (draft) => {
      draft.nodes[frameId]!.locked = true;
    });
    const sentAfterLock = sent.length;

    store.dispatchEdit('Rename locked frame', (draft) => {
      draft.nodes[frameId]!.name = 'Should not change';
    });
    expect(useEditor.getState().doc!.nodes[frameId]!.name).toBe('Landing');
    expect(sent).toHaveLength(sentAfterLock);

    store.dispatchEdit('Unlock', (draft) => {
      draft.nodes[frameId]!.locked = false;
    });
    expect(useEditor.getState().doc!.nodes[frameId]!.locked).toBe(false);
    expect(sent).toHaveLength(sentAfterLock + 1);
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
    expect(useEditor.getState().syncIssue).toBe('Your last change was not saved: test rejection');
    expect(useEditor.getState().pendingPatchIds).toEqual([]);
  });

  it('rebases optimistic work over a peer patch instead of overwriting either change', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    store.dispatchEdit('Rename', (draft) => {
      draft.name = 'Local name';
    });
    const localPatchId = sent[0]!.patchId;

    const remote: PatchOp[] = [
      { op: 'replace', path: ['nodes', frameId, 'canvas', 'x'], value: 777 },
    ];
    expect(store.applyRemotePatch(remote, 1, 'Peer move', 'editor:peer')).toBe(true);
    expect(useEditor.getState().doc?.name).toBe('Local name');
    const afterRemote = useEditor.getState().doc!.nodes[frameId]!;
    expect(afterRemote.type === 'frame' && afterRemote.canvas.x).toBe(777);

    // Confirming the rebased local patch advances the authoritative revision
    // without losing the peer edit already present in that base.
    expect(useEditor.getState().handleAck(localPatchId, 2)).toBe(true);
    expect(useEditor.getState().doc?.name).toBe('Local name');
    const afterAck = useEditor.getState().doc!.nodes[frameId]!;
    expect(afterAck.type === 'frame' && afterAck.canvas.x).toBe(777);
  });

  it('rebuilds from confirmed state when an early queued edit is rejected', () => {
    const store = useEditor.getState();
    store.dispatchEdit(
      'First rename',
      (draft) => {
        draft.name = 'First';
      },
      { coalesceKey: 'name' },
    );
    store.dispatchEdit(
      'Second rename',
      (draft) => {
        draft.name = 'Second';
      },
      { coalesceKey: 'name' },
    );
    const [first, second] = sent;

    expect(store.handleReject(first!.patchId, 'conflict')).toBe(true);
    expect(useEditor.getState().doc?.name).toBe('Second');
    expect(useEditor.getState().pendingPatchIds).toEqual([second!.patchId]);

    // The surviving coalesced segment receives a rebased inverse. After it is
    // accepted, one undo returns to the confirmed value, not the rejected one.
    expect(store.handleAck(second!.patchId, 1)).toBe(true);
    store.undo();
    expect(useEditor.getState().doc?.name).toBe('Welcome');
  });

  it('restores history when an optimistic undo is rejected', () => {
    const store = useEditor.getState();
    store.dispatchEdit('Rename', (draft) => {
      draft.name = 'Saved rename';
    });
    store.handleAck(sent[0]!.patchId, 1);
    store.undo();
    const undoPatch = sent[1]!;
    expect(useEditor.getState().historyStatus.canUndo).toBe(false);
    expect(useEditor.getState().historyStatus.canRedo).toBe(true);

    expect(store.handleReject(undoPatch.patchId, 'not allowed')).toBe(true);
    expect(useEditor.getState().doc?.name).toBe('Saved rename');
    expect(useEditor.getState().historyStatus).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Rename',
    });
  });

  it('reconciles a reconnect snapshot and does not replay patch ids already committed', () => {
    const store = useEditor.getState();
    store.dispatchEdit('Rename', (draft) => {
      draft.name = 'Committed while disconnected';
    });
    const patchId = sent[0]!.patchId;
    const serverDoc = createSampleDocument();
    serverDoc.name = 'Committed while disconnected';

    expect(store.reconcileDocument(serverDoc, 1, [patchId])).toBe(true);
    expect(useEditor.getState().doc?.name).toBe('Committed while disconnected');
    expect(useEditor.getState().pendingPatchIds).toEqual([]);
  });

  it('resets document-scoped editor state on a real document change', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    store.select([frameId]);
    store.setHover(frameId);
    store.setTool('text');
    store.setEditingText(frameId);
    store.setRightPanelMode('comments');
    store.setShowComments(true);
    store.setPreviewFrame(frameId);
    store.applyRemotePatch(
      [{ op: 'replace', path: ['name'], value: 'Peer change' }],
      1,
      'Peer change',
      'editor:peer',
    );

    const next = createSampleDocument();
    next.id = 'next-document';
    next.name = 'Next';
    store.setDocument(next, 0);
    expect(useEditor.getState()).toMatchObject({
      selection: [],
      hoveredId: null,
      activeTool: 'select',
      editingTextId: null,
      rightPanelMode: 'design',
      activity: [],
      agentActiveUntil: 0,
      showComments: false,
      inspectorFocus: null,
      previewFrameId: null,
      pendingPatchIds: [],
    });
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
    store.applyRemotePatch(ops, 4, 'Anon Edit', 'editor:peer');
    expect(useEditor.getState().activity[0]!.actorName).toBeUndefined();
  });
});
