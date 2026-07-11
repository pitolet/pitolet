import type { PitoletDocument, NodeId, PatchActor, PatchOp, StateName } from '@pitolet/schema';
import { applyPatches, enablePatches, produceWithPatches, type Draft } from 'immer';
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { History } from './history.js';
import { flashNodes } from '../canvas/agentGlow.js';
import { overlaySync } from '../canvas/overlaySync.js';

enablePatches();

export type Tool = 'select' | 'frame' | 'text' | 'element' | 'image';

export interface OutgoingPatch {
  patchId: string;
  label: string;
  ops: PatchOp[];
}

/** A row in the activity feed — who changed what, when. */
export interface ActivityEntry {
  id: string;
  kind: 'agent' | 'peer' | 'you';
  label: string;
  /** Epoch ms. */
  time: number;
  /** Nodes the change touched (for click-to-select / glow). */
  nodeIds: NodeId[];
  /** Attributed user's display name (multi-user), when the patch carried one. */
  actorName?: string;
}

const ACTIVITY_LIMIT = 100;

/** Node ids an ops list touches (paths like ['nodes', id, ...]). */
export function nodeIdsFromOps(ops: PatchOp[]): NodeId[] {
  const ids = new Set<NodeId>();
  for (const op of ops) {
    if (op.path[0] === 'nodes' && typeof op.path[1] === 'string') ids.add(op.path[1]);
    // Comment ops attribute to the commented node.
    if (op.path[0] === 'comments' && op.op === 'add' && op.value && typeof op.value === 'object') {
      const nodeId = (op.value as { nodeId?: unknown }).nodeId;
      if (typeof nodeId === 'string') ids.add(nodeId);
    }
  }
  return [...ids];
}

export interface EditorState {
  doc: PitoletDocument | null;
  docRev: number;
  connected: boolean;
  /** True once the boot fetch/WS returns 401 — the login screen renders. */
  authRequired: boolean;
  setAuthRequired: (required: boolean) => void;
  /** When true, dispatchEdit is a no-op and edit affordances are gated. */
  readOnly: boolean;
  setReadOnly: (readOnly: boolean) => void;

  selection: NodeId[];
  hoveredId: NodeId | null;
  activeTool: Tool;
  editingContext: { breakpointId: string | null; state: StateName | null };
  editingTextId: NodeId | null;
  codePanelOpen: boolean;
  leftPanelTab: 'layers' | 'tokens' | 'components';
  /** While set (e.g. "intent=ghost"), style edits inside a master record into that variant. */
  editingVariant: string | null;
  /** Recent changes (newest first), all origins, session-only. */
  activity: ActivityEntry[];
  /** Epoch ms until which the "Agent editing" badge shows (0 = idle). */
  agentActiveUntil: number;
  /** Show comment pins on the canvas. */
  showComments: boolean;
  setShowComments: (show: boolean) => void;

  // --- document mutations (single entry point) ---
  dispatchEdit: (
    label: string,
    recipe: (draft: Draft<PitoletDocument>) => void,
    options?: { coalesceKey?: string },
  ) => void;
  undo: () => void;
  redo: () => void;

  // --- sync plumbing (called by connection.ts) ---
  setDocument: (doc: PitoletDocument, rev: number) => void;
  applyRemotePatch: (
    ops: PatchOp[],
    rev: number,
    label: string,
    origin: string,
    actor?: PatchActor,
  ) => void;
  handleReject: (patchId: string, reason: string) => void;
  setConnected: (connected: boolean) => void;

  // --- session ---
  select: (ids: NodeId[]) => void;
  setHover: (id: NodeId | null) => void;
  setTool: (tool: Tool) => void;
  setEditingText: (id: NodeId | null) => void;
  setCodePanelOpen: (open: boolean) => void;
  setLeftPanelTab: (tab: 'layers' | 'tokens' | 'components') => void;
  setEditingVariant: (key: string | null) => void;
  setEditingContext: (ctx: { breakpointId: string | null; state: StateName | null }) => void;
  /** Frame id shown in interactive preview mode, or null. */
  previewFrameId: NodeId | null;
  setPreviewFrame: (id: NodeId | null) => void;
}

export const history = new History();

/** Set by connection.ts; dispatchEdit forwards local patches through it. */
let sendPatch: ((patch: OutgoingPatch) => void) | null = null;
export function setPatchSender(sender: ((patch: OutgoingPatch) => void) | null): void {
  sendPatch = sender;
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  docRev: 0,
  connected: false,
  authRequired: false,
  readOnly: false,

  selection: [],
  hoveredId: null,
  activeTool: 'select',
  editingContext: { breakpointId: null, state: null },
  editingTextId: null,
  codePanelOpen: false,
  leftPanelTab: 'layers',
  editingVariant: null,
  activity: [],
  agentActiveUntil: 0,
  showComments: true,
  previewFrameId: null,

  dispatchEdit: (label, recipe, options) => {
    const { doc, selection, readOnly } = get();
    // Read-only mode: swallow every local mutation. All edit paths (keyboard,
    // context menu, inspector, canvas gestures) funnel through here, so the
    // no-op alone makes the document immutable locally — nothing sent, nothing
    // applied. Remote/MCP patches still land via applyRemotePatch.
    if (readOnly) return;
    if (!doc) return;
    const [next, ops, inverseOps] = produceWithPatches(doc, recipe);
    if (ops.length === 0) return;
    const patchId = nanoid(8);
    set({ doc: next, selection: pruneSelection(get().selection, next) });
    history.push({
      patchId,
      label,
      ops: ops as PatchOp[],
      inverseOps: inverseOps as PatchOp[],
      origin: 'local',
      selectionBefore: selection,
      selectionAfter: get().selection,
      coalesceKey: options?.coalesceKey,
    });
    sendPatch?.({ patchId, label, ops: ops as PatchOp[] });
    pushActivity(set, get, 'you', label, nodeIdsFromOps(ops as PatchOp[]), options?.coalesceKey);
    overlaySync.notify();
  },

  undo: () => {
    const entry = history.popUndo();
    const { doc } = get();
    if (!entry || !doc) return;
    const [next, ops] = produceWithPatches(doc, (draft) => {
      applyPatches(draft, entry.inverseOps);
    });
    set({ doc: next, selection: pruneSelection(entry.selectionBefore, next) });
    sendPatch?.({ patchId: nanoid(8), label: `Undo ${entry.label}`, ops: ops as PatchOp[] });
    overlaySync.notify();
  },

  redo: () => {
    const entry = history.popRedo();
    const { doc } = get();
    if (!entry || !doc) return;
    const [next, ops] = produceWithPatches(doc, (draft) => {
      applyPatches(draft, entry.ops);
    });
    set({ doc: next, selection: pruneSelection(entry.selectionAfter, next) });
    sendPatch?.({ patchId: nanoid(8), label: `Redo ${entry.label}`, ops: ops as PatchOp[] });
    overlaySync.notify();
  },

  setDocument: (doc, rev) => {
    // Full doc replacement (initial open or external reload) — history is
    // no longer valid against the new tree.
    history.clear();
    set({ doc, docRev: rev, selection: pruneSelection(get().selection, doc) });
    overlaySync.notify();
  },

  applyRemotePatch: (ops, rev, label, origin, actor) => {
    const { doc, selection } = get();
    if (!doc) return;
    let next: PitoletDocument;
    let inverseOps: PatchOp[];
    try {
      const result = produceWithPatches(doc, (draft) => {
        applyPatches(draft, ops);
      });
      next = result[0];
      inverseOps = result[2] as PatchOp[];
    } catch (err) {
      // Should not happen (server validated) — resync will heal via reload.
      console.error('[pitolet] failed to apply remote patch', err);
      return;
    }
    set({ doc: next, docRev: rev, selection: pruneSelection(selection, next) });
    history.push({
      patchId: nanoid(8),
      label,
      ops,
      inverseOps,
      origin: 'remote',
      selectionBefore: selection,
      selectionAfter: get().selection,
    });
    const touched = nodeIdsFromOps(ops);
    if (origin === 'mcp') {
      set({ agentActiveUntil: Date.now() + 4000 });
      flashNodes(touched);
      pushActivity(set, get, 'agent', label, touched, undefined, actor?.name);
    } else {
      pushActivity(set, get, 'peer', label, touched, undefined, actor?.name);
    }
    overlaySync.notify();
  },

  handleReject: (patchId, reason) => {
    const entry = history.discard(patchId);
    const { doc } = get();
    if (!entry || !doc) return;
    console.warn(`[pitolet] patch rejected: ${reason}`);
    const [next] = produceWithPatches(doc, (draft) => {
      applyPatches(draft, entry.inverseOps);
    });
    set({ doc: next, selection: pruneSelection(entry.selectionBefore, next) });
    overlaySync.notify();
  },

  setConnected: (connected) => set({ connected }),
  setAuthRequired: (authRequired) => set({ authRequired }),
  setReadOnly: (readOnly) => set({ readOnly }),

  select: (ids) => {
    set({ selection: ids });
    overlaySync.notify();
  },
  setHover: (id) => {
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  setTool: (tool) => set({ activeTool: tool }),
  setEditingText: (id) => set({ editingTextId: id }),
  setCodePanelOpen: (open) => set({ codePanelOpen: open }),
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  setEditingVariant: (key) => set({ editingVariant: key }),
  setEditingContext: (ctx) => set({ editingContext: ctx }),
  setPreviewFrame: (id) => set({ previewFrameId: id }),
  setShowComments: (show) => set({ showComments: show }),
}));

type Set = (partial: Partial<EditorState>) => void;
type Get = () => EditorState;

/**
 * Prepend an activity entry. Consecutive same-kind, same-label entries (e.g.
 * a scrub gesture's coalesced edits) merge into one row with a fresh time.
 */
function pushActivity(
  set: Set,
  get: Get,
  kind: ActivityEntry['kind'],
  label: string,
  nodeIds: NodeId[],
  coalesceKey?: string,
  actorName?: string,
): void {
  const activity = get().activity;
  const top = activity[0];
  if (
    top &&
    top.kind === kind &&
    top.label === label &&
    top.actorName === actorName &&
    (coalesceKey || kind !== 'you')
  ) {
    const merged: ActivityEntry = {
      ...top,
      time: Date.now(),
      nodeIds: [...new Set([...top.nodeIds, ...nodeIds])],
    };
    set({ activity: [merged, ...activity.slice(1)] });
    return;
  }
  const entry: ActivityEntry = { id: nanoid(6), kind, label, time: Date.now(), nodeIds, actorName };
  set({ activity: [entry, ...activity].slice(0, ACTIVITY_LIMIT) });
}

function pruneSelection(selection: NodeId[], doc: PitoletDocument | null): NodeId[] {
  if (!doc) return [];
  const pruned = selection.filter((id) => doc.nodes[id] !== undefined);
  return pruned.length === selection.length ? selection : pruned;
}
