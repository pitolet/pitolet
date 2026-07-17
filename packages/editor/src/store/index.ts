import {
  rootFrameOf,
  type PitoletDocument,
  type NodeId,
  type PatchActor,
  type PatchOp,
  type StateName,
} from '@pitolet/schema';
import { applyPatches, enablePatches, produceWithPatches, type Draft } from 'immer';
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { History, type HistoryEntry } from './history.js';
import { editsLockedNode } from './locks.js';
import { flashNodes } from '../canvas/agentGlow.js';
import { overlaySync } from '../canvas/overlaySync.js';

enablePatches();

export type Tool = 'select' | 'frame' | 'text' | 'element' | 'image';

export interface OutgoingPatch {
  patchId: string;
  label: string;
  ops: PatchOp[];
}

type PendingHistoryEffect =
  { kind: 'edit' } | { kind: 'undo'; entry: HistoryEntry } | { kind: 'redo'; entry: HistoryEntry };

interface PendingPatch extends OutgoingPatch {
  historyEffect: PendingHistoryEffect;
  preconditions: PatchCondition[];
  postconditions: PatchCondition[];
  /** The patch left the client without a definitive acknowledgement or rejection. */
  uncertain: boolean;
}

interface PatchCondition {
  path: Array<string | number>;
  exists: boolean;
  value?: unknown;
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

export interface EditingVariant {
  componentId: string;
  key: string;
}

export interface EditingInstanceOverride {
  instanceId: NodeId;
  nodeId: NodeId;
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

/** Whether a patch can change component instance totals or inherited locks. */
export function patchAffectsStructure(ops: PatchOp[]): boolean {
  return ops.some((op) => {
    if (op.path[0] !== 'nodes') return false;
    if (op.path.length <= 2) return true;
    const field = op.path[2];
    return (
      field === 'children' ||
      field === 'parent' ||
      field === 'locked' ||
      field === 'type' ||
      field === 'componentId'
    );
  });
}

export interface EditorState {
  doc: PitoletDocument | null;
  docRev: number;
  /** Advances only when hierarchy, lock inheritance, or instance membership changes. */
  structureVersion: number;
  connected: boolean;
  /** A requested document change is waiting for saves or the next full document. */
  switchingDocument: boolean;
  /** Fatal boot failure that cannot be healed by WebSocket reconnects. */
  connectionError: string | null;
  setConnectionError: (message: string | null) => void;
  /** Visible feedback for a rejected or otherwise unsaved local edit. */
  syncIssue: string | null;
  setSyncIssue: (message: string | null) => void;
  /** Local patches sent to the server but not acknowledged yet. */
  pendingPatchIds: string[];
  /** Time of the latest fully acknowledged state, or document load. */
  lastSavedAt: number | null;
  historyStatus: HistoryStatus;
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
  /** Frame temporarily resized by the breakpoint switcher. */
  responsivePreviewFrameId: NodeId | null;
  editingTextId: NodeId | null;
  codePanelOpen: boolean;
  leftPanelTab: 'layers' | 'tokens' | 'components';
  rightPanelMode: 'design' | 'comments';
  setRightPanelMode: (mode: 'design' | 'comments') => void;
  /** The component variant currently being previewed and edited. */
  editingVariant: EditingVariant | null;
  /** Inner master node whose styles are being overridden on one selected instance. */
  editingInstanceOverride: EditingInstanceOverride | null;
  /** Recent changes (newest first), all origins, session-only. */
  activity: ActivityEntry[];
  /** Epoch ms until which the "Agent editing" badge shows (0 = idle). */
  agentActiveUntil: number;
  /** Show unresolved comment pins on the canvas while reviewing comments. */
  showComments: boolean;
  setShowComments: (show: boolean) => void;
  /** Ask the inspector to reveal a section after another surface selects a node. */
  inspectorFocus: 'comments' | null;
  setInspectorFocus: (section: 'comments' | null) => void;
  focusNodeRequest: { id: NodeId; nonce: number } | null;
  requestFocusNode: (id: NodeId) => void;

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
  /** Replace the confirmed base after reconnect while preserving local work. */
  reconcileDocument: (
    doc: PitoletDocument,
    rev: number,
    appliedPatchIds?: string[],
    uncertainPatchId?: string | null,
  ) => boolean;
  applyRemotePatch: (
    ops: PatchOp[],
    rev: number,
    label: string,
    origin: string,
    actor?: PatchActor,
  ) => boolean;
  handleReject: (patchId: string, reason: string) => boolean;
  handleAck: (patchId: string, rev: number) => boolean;
  setConnected: (connected: boolean) => void;
  setSwitchingDocument: (switching: boolean) => void;

  // --- session ---
  select: (ids: NodeId[]) => void;
  setHover: (id: NodeId | null) => void;
  setTool: (tool: Tool) => void;
  setEditingText: (id: NodeId | null) => void;
  setCodePanelOpen: (open: boolean) => void;
  setLeftPanelTab: (tab: 'layers' | 'tokens' | 'components') => void;
  setEditingVariant: (componentId: string, key: string | null) => void;
  setEditingInstanceOverride: (instanceId: NodeId, nodeId: NodeId | null) => void;
  setEditingContext: (ctx: { breakpointId: string | null; state: StateName | null }) => void;
  /** Frame id shown in interactive preview mode, or null. */
  previewFrameId: NodeId | null;
  setPreviewFrame: (id: NodeId | null) => void;
}

export const history = new History();

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

function historyStatus(): HistoryStatus {
  return {
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  };
}

/** Set by connection.ts; dispatchEdit forwards local patches through it. */
let sendPatch: ((patch: OutgoingPatch) => void) | null = null;
export function setPatchSender(sender: ((patch: OutgoingPatch) => void) | null): void {
  sendPatch = sender;
}

/**
 * Confirmed server state and ordered optimistic operations intentionally live
 * outside Zustand. UI subscribers only need the rebuilt document and compact
 * pending id list, not a second large document graph.
 */
let authoritativeDoc: PitoletDocument | null = null;
let pendingPatches: PendingPatch[] = [];

export function pendingOutgoingPatches(): OutgoingPatch[] {
  return pendingPatches.map(({ patchId, label, ops }) => ({ patchId, label, ops }));
}

/**
 * Remember uncertainty in the store rather than only on one Connection
 * instance. This survives a development StrictMode stop/start and guarantees
 * the next authoritative snapshot is checked before the patch can be replayed.
 */
export function markPendingPatchUncertain(patchId: string): void {
  const patch = pendingPatches.find((candidate) => candidate.patchId === patchId);
  if (patch) patch.uncertain = true;
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  docRev: 0,
  structureVersion: 0,
  connected: false,
  switchingDocument: false,
  connectionError: null,
  syncIssue: null,
  pendingPatchIds: [],
  lastSavedAt: null,
  historyStatus: historyStatus(),
  authRequired: false,
  readOnly: false,

  selection: [],
  hoveredId: null,
  activeTool: 'select',
  editingContext: { breakpointId: null, state: null },
  responsivePreviewFrameId: null,
  editingTextId: null,
  codePanelOpen: false,
  leftPanelTab: 'layers',
  rightPanelMode: 'design',
  editingVariant: null,
  editingInstanceOverride: null,
  activity: [],
  agentActiveUntil: 0,
  showComments: false,
  inspectorFocus: null,
  focusNodeRequest: null,
  previewFrameId: null,

  dispatchEdit: (label, recipe, options) => {
    const { doc, selection, readOnly, connected, switchingDocument } = get();
    // Read-only mode: swallow every local mutation. All edit paths (keyboard,
    // context menu, inspector, canvas gestures) funnel through here, so the
    // no-op alone makes the document immutable locally — nothing sent, nothing
    // applied. Remote/MCP patches still land via applyRemotePatch.
    if (readOnly) {
      set({ syncIssue: 'This document is read-only.' });
      return;
    }
    if (!doc) return;
    // Never let apparently-successful offline edits be replaced by the
    // authoritative document when the socket reconnects. A later iteration
    // can queue offline patches; until then, pausing is the honest behavior.
    if (!connected || switchingDocument) {
      set({
        syncIssue: switchingDocument
          ? 'Pitolet is finishing the current save before opening the document.'
          : 'Editing is paused until Pitolet reconnects.',
      });
      return;
    }
    const [next, ops, inverseOps] = produceWithPatches(doc, recipe);
    if (ops.length === 0) return;
    if (editsLockedNode(doc, ops as PatchOp[])) return;
    const patchId = nanoid(8);
    const nextSelection = pruneSelection(get().selection, next);
    set({
      doc: next,
      structureVersion: get().structureVersion + (patchAffectsStructure(ops as PatchOp[]) ? 1 : 0),
      selection: nextSelection,
      editingContext: pruneEditingContext(get().editingContext, nextSelection, next),
      responsivePreviewFrameId: responsiveFrameForSelection(
        next,
        nextSelection,
        get().responsivePreviewFrameId,
      ),
      editingInstanceOverride: pruneEditingInstanceOverride(get().editingInstanceOverride, next),
      pendingPatchIds: [...get().pendingPatchIds, patchId],
    });
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
    pendingPatches.push({
      patchId,
      label,
      ops: ops as PatchOp[],
      historyEffect: { kind: 'edit' },
      preconditions: patchConditions(doc, ops as PatchOp[]),
      postconditions: patchConditions(next, ops as PatchOp[]),
      uncertain: false,
    });
    set({ historyStatus: historyStatus() });
    sendPatch?.({ patchId, label, ops: ops as PatchOp[] });
    pushActivity(set, get, 'you', label, nodeIdsFromOps(ops as PatchOp[]), options?.coalesceKey);
    overlaySync.notify();
  },

  undo: () => {
    const { connected, readOnly, switchingDocument } = get();
    if (readOnly) return;
    if (!connected || switchingDocument) {
      set({
        syncIssue: switchingDocument
          ? 'Pitolet is finishing the current save before opening the document.'
          : 'Editing is paused until Pitolet reconnects.',
      });
      return;
    }
    const entry = history.popUndo();
    const { doc } = get();
    if (!entry || !doc) return;
    const [next, ops] = produceWithPatches(doc, (draft) => {
      applyPatches(draft, entry.inverseOps);
    });
    const patchId = nanoid(8);
    const nextSelection = pruneSelection(entry.selectionBefore, next);
    set({
      doc: next,
      structureVersion: get().structureVersion + (patchAffectsStructure(ops as PatchOp[]) ? 1 : 0),
      selection: nextSelection,
      editingContext: pruneEditingContext(get().editingContext, nextSelection, next),
      responsivePreviewFrameId: responsiveFrameForSelection(
        next,
        nextSelection,
        get().responsivePreviewFrameId,
      ),
      pendingPatchIds: [...get().pendingPatchIds, patchId],
      historyStatus: historyStatus(),
    });
    const outgoing = {
      patchId,
      label: `Undo ${entry.label}`,
      ops: ops as PatchOp[],
    };
    pendingPatches.push({
      ...outgoing,
      historyEffect: { kind: 'undo', entry },
      preconditions: patchConditions(doc, ops as PatchOp[]),
      postconditions: patchConditions(next, ops as PatchOp[]),
      uncertain: false,
    });
    sendPatch?.(outgoing);
    overlaySync.notify();
  },

  redo: () => {
    const { connected, readOnly, switchingDocument } = get();
    if (readOnly) return;
    if (!connected || switchingDocument) {
      set({
        syncIssue: switchingDocument
          ? 'Pitolet is finishing the current save before opening the document.'
          : 'Editing is paused until Pitolet reconnects.',
      });
      return;
    }
    const entry = history.popRedo();
    const { doc } = get();
    if (!entry || !doc) return;
    const [next, ops] = produceWithPatches(doc, (draft) => {
      applyPatches(draft, entry.ops);
    });
    const patchId = nanoid(8);
    const nextSelection = pruneSelection(entry.selectionAfter, next);
    set({
      doc: next,
      structureVersion: get().structureVersion + (patchAffectsStructure(ops as PatchOp[]) ? 1 : 0),
      selection: nextSelection,
      editingContext: pruneEditingContext(get().editingContext, nextSelection, next),
      responsivePreviewFrameId: responsiveFrameForSelection(
        next,
        nextSelection,
        get().responsivePreviewFrameId,
      ),
      pendingPatchIds: [...get().pendingPatchIds, patchId],
      historyStatus: historyStatus(),
    });
    const outgoing = {
      patchId,
      label: `Redo ${entry.label}`,
      ops: ops as PatchOp[],
    };
    pendingPatches.push({
      ...outgoing,
      historyEffect: { kind: 'redo', entry },
      preconditions: patchConditions(doc, ops as PatchOp[]),
      postconditions: patchConditions(next, ops as PatchOp[]),
      uncertain: false,
    });
    sendPatch?.(outgoing);
    overlaySync.notify();
  },

  setDocument: (doc, rev) => {
    // A different document is a hard session boundary. Do not carry selection,
    // preview, comments, activity, history, or transport operations into it.
    authoritativeDoc = doc;
    pendingPatches = [];
    history.clear();
    set({
      doc,
      docRev: rev,
      structureVersion: get().structureVersion + 1,
      switchingDocument: false,
      selection: [],
      hoveredId: null,
      activeTool: 'select',
      editingContext: { breakpointId: null, state: null },
      responsivePreviewFrameId: responsiveFrameForSelection(doc, [], null),
      editingTextId: null,
      rightPanelMode: 'design',
      connectionError: null,
      syncIssue: null,
      pendingPatchIds: [],
      lastSavedAt: Date.now(),
      historyStatus: historyStatus(),
      editingVariant: null,
      editingInstanceOverride: null,
      activity: [],
      agentActiveUntil: 0,
      showComments: false,
      inspectorFocus: null,
      focusNodeRequest: null,
      previewFrameId: null,
    });
    overlaySync.notify();
  },

  reconcileDocument: (doc, rev, appliedPatchIds = [], uncertainPatchId = null) => {
    authoritativeDoc = doc;
    if (appliedPatchIds.length > 0) {
      const applied = new Set(appliedPatchIds);
      pendingPatches = pendingPatches.filter((patch) => !applied.has(patch.patchId));
    }
    if (uncertainPatchId) markPendingPatchUncertain(uncertainPatchId);
    for (let index = pendingPatches.length - 1; index >= 0; index -= 1) {
      const uncertain = pendingPatches[index]!;
      if (!uncertain.uncertain) continue;
      const status = patchCommitStatus(doc, uncertain);
      if (status === 'applied') {
        pendingPatches.splice(index, 1);
      } else if (status === 'absent') {
        // Replaying is safe only after the authoritative snapshot still
        // satisfies every exact precondition captured before the first send.
        uncertain.uncertain = false;
      } else {
        set({
          // Preserve the visible local work while the user decides how to
          // recover. The authoritative snapshot remains outside Zustand and
          // no patch is sent while the connection is paused.
          doc: get().doc ?? doc,
          docRev: rev,
          structureVersion: get().structureVersion + 1,
          syncIssue:
            'Pitolet could not safely tell whether the last change was saved. Editing is paused to prevent a duplicate change.',
          pendingPatchIds: pendingPatches.map((patch) => patch.patchId),
        });
        overlaySync.notify();
        return false;
      }
    }
    const rebuilt = rebuildOptimisticDocument(doc, pendingPatches);
    if (!rebuilt.ok) {
      set({
        doc,
        docRev: rev,
        structureVersion: get().structureVersion + 1,
        syncIssue:
          'Pitolet reconnected, but some local changes could not be replayed. Editing is paused to protect your work.',
        pendingPatchIds: pendingPatches.map((patch) => patch.patchId),
      });
      overlaySync.notify();
      return false;
    }
    const selection = pruneSelection(get().selection, rebuilt.doc);
    set({
      doc: rebuilt.doc,
      docRev: rev,
      structureVersion: get().structureVersion + 1,
      selection,
      editingContext: pruneEditingContext(get().editingContext, selection, rebuilt.doc),
      responsivePreviewFrameId: responsiveFrameForSelection(
        rebuilt.doc,
        selection,
        get().responsivePreviewFrameId,
      ),
      editingInstanceOverride: pruneEditingInstanceOverride(
        get().editingInstanceOverride,
        rebuilt.doc,
      ),
      connectionError: null,
      syncIssue: null,
      pendingPatchIds: pendingPatches.map((patch) => patch.patchId),
      ...(pendingPatches.length === 0 ? { lastSavedAt: Date.now() } : {}),
    });
    overlaySync.notify();
    return true;
  },

  applyRemotePatch: (ops, rev, label, origin, actor) => {
    const { selection, docRev } = get();
    if (!authoritativeDoc) return false;
    // A duplicate is harmless; a gap means at least one authoritative patch
    // was missed and only a full document can safely heal the client.
    if (rev <= docRev) return true;
    if (rev !== docRev + 1) return false;
    let nextAuthoritative: PitoletDocument;
    let inverseOps: PatchOp[];
    try {
      const result = produceWithPatches(authoritativeDoc, (draft) => {
        applyPatches(draft, ops);
      });
      nextAuthoritative = result[0];
      inverseOps = result[2] as PatchOp[];
    } catch (err) {
      console.error('[pitolet] failed to apply remote patch', err);
      return false;
    }
    const rebuilt = rebuildOptimisticDocument(nextAuthoritative, pendingPatches);
    if (!rebuilt.ok) {
      console.error('[pitolet] failed to rebase local patches after a remote edit');
      return false;
    }
    authoritativeDoc = nextAuthoritative;
    const nextSelection = pruneSelection(selection, rebuilt.doc);
    set({
      doc: rebuilt.doc,
      docRev: rev,
      structureVersion: get().structureVersion + (patchAffectsStructure(ops as PatchOp[]) ? 1 : 0),
      selection: nextSelection,
      editingContext: pruneEditingContext(get().editingContext, nextSelection, rebuilt.doc),
      responsivePreviewFrameId: responsiveFrameForSelection(
        rebuilt.doc,
        nextSelection,
        get().responsivePreviewFrameId,
      ),
      editingInstanceOverride: pruneEditingInstanceOverride(
        get().editingInstanceOverride,
        rebuilt.doc,
      ),
    });
    history.push({
      patchId: nanoid(8),
      label,
      ops,
      inverseOps,
      origin: 'remote',
      selectionBefore: selection,
      selectionAfter: get().selection,
    });
    set({ historyStatus: historyStatus() });
    const touched = nodeIdsFromOps(ops);
    if (origin === 'mcp') {
      set({ agentActiveUntil: Date.now() + 4000 });
      flashNodes(touched);
      pushActivity(set, get, 'agent', label, touched, undefined, actor?.name);
    } else {
      pushActivity(set, get, 'peer', label, touched, undefined, actor?.name);
    }
    overlaySync.notify();
    return true;
  },

  handleReject: (patchId, reason) => {
    console.warn(`[pitolet] patch rejected: ${reason}`);
    const index = pendingPatches.findIndex((patch) => patch.patchId === patchId);
    if (index < 0) return false;
    const [rejected] = pendingPatches.splice(index, 1);
    rejectHistoryEffect(rejected!.historyEffect, patchId);
    if (!authoritativeDoc) return false;
    const rebuilt = rebuildOptimisticDocument(authoritativeDoc, pendingPatches);
    if (!rebuilt.ok) {
      set({
        syncIssue: `A change was rejected (${reason}), and later local changes could not be replayed. Editing is paused.`,
        pendingPatchIds: pendingPatches.map((patch) => patch.patchId),
        historyStatus: historyStatus(),
      });
      return false;
    }
    const nextSelection = pruneSelection(get().selection, rebuilt.doc);
    set({
      doc: rebuilt.doc,
      structureVersion:
        get().structureVersion + (patchAffectsStructure(rejected!.ops as PatchOp[]) ? 1 : 0),
      selection: nextSelection,
      editingContext: pruneEditingContext(get().editingContext, nextSelection, rebuilt.doc),
      responsivePreviewFrameId: responsiveFrameForSelection(
        rebuilt.doc,
        nextSelection,
        get().responsivePreviewFrameId,
      ),
      syncIssue: `Your last change was not saved: ${reason}`,
      pendingPatchIds: pendingPatches.map((patch) => patch.patchId),
      historyStatus: historyStatus(),
    });
    overlaySync.notify();
    return true;
  },

  handleAck: (patchId, rev) => {
    const index = pendingPatches.findIndex((patch) => patch.patchId === patchId);
    if (index < 0 || !authoritativeDoc) return false;
    const acknowledged = pendingPatches[index]!;
    let nextAuthoritative = authoritativeDoc;
    const currentRev = get().docRev;
    if (rev > currentRev + 1 || rev < currentRev) return false;
    // rev === currentRev means reconnect deduplication: the full document
    // already contained this patch, so applying it again would duplicate adds.
    if (rev === currentRev + 1) {
      try {
        nextAuthoritative = applyPatches(authoritativeDoc, acknowledged.ops);
      } catch (err) {
        console.error('[pitolet] failed to apply acknowledged patch to confirmed state', err);
        return false;
      }
    }
    pendingPatches.splice(index, 1);
    authoritativeDoc = nextAuthoritative;
    const rebuilt = rebuildOptimisticDocument(authoritativeDoc, pendingPatches);
    if (!rebuilt.ok) return false;
    const nextSelection = pruneSelection(get().selection, rebuilt.doc);
    set({
      doc: rebuilt.doc,
      docRev: rev,
      selection: nextSelection,
      editingContext: pruneEditingContext(get().editingContext, nextSelection, rebuilt.doc),
      responsivePreviewFrameId: responsiveFrameForSelection(
        rebuilt.doc,
        nextSelection,
        get().responsivePreviewFrameId,
      ),
      editingInstanceOverride: pruneEditingInstanceOverride(
        get().editingInstanceOverride,
        rebuilt.doc,
      ),
      pendingPatchIds: pendingPatches.map((patch) => patch.patchId),
      ...(pendingPatches.length === 0 ? { lastSavedAt: Date.now(), syncIssue: null } : {}),
    });
    overlaySync.notify();
    return true;
  },

  setConnected: (connected) =>
    set({
      connected,
      ...(connected ? { connectionError: null } : { activeTool: 'select', editingTextId: null }),
    }),
  setSwitchingDocument: (switchingDocument) =>
    set({
      switchingDocument,
      ...(switchingDocument ? { activeTool: 'select', editingTextId: null } : {}),
    }),
  setConnectionError: (connectionError) => set({ connectionError }),
  setSyncIssue: (syncIssue) => set({ syncIssue }),
  setAuthRequired: (authRequired) => set({ authRequired }),
  setReadOnly: (readOnly) =>
    set({
      readOnly,
      ...(readOnly ? { activeTool: 'select', editingTextId: null } : {}),
    }),

  select: (ids) => {
    const state = get();
    const currentOverride = state.editingInstanceOverride;
    set({
      selection: ids,
      responsivePreviewFrameId: responsiveFrameForSelection(
        state.doc,
        ids,
        state.responsivePreviewFrameId,
      ),
      ...(ids.length === 0 && state.editingContext.state
        ? { editingContext: { ...state.editingContext, state: null } }
        : {}),
      editingInstanceOverride:
        currentOverride && ids.length === 1 && ids[0] === currentOverride.instanceId
          ? currentOverride
          : null,
    });
    overlaySync.notify();
  },
  setHover: (id) => {
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  setTool: (tool) => {
    const state = get();
    set({
      activeTool:
        tool !== 'select' && (state.readOnly || !state.connected || state.switchingDocument)
          ? 'select'
          : tool,
    });
  },
  setEditingText: (id) => {
    const state = get();
    set({
      editingTextId:
        id !== null && (state.readOnly || !state.connected || state.switchingDocument) ? null : id,
    });
  },
  setCodePanelOpen: (open) => set({ codePanelOpen: open }),
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  setRightPanelMode: (rightPanelMode) => set({ rightPanelMode }),
  setEditingVariant: (componentId, key) =>
    set({
      editingVariant: key ? { componentId, key } : null,
      ...(key ? { editingContext: { breakpointId: null, state: null } } : {}),
    }),
  setEditingInstanceOverride: (instanceId, nodeId) => {
    set({
      editingInstanceOverride: nodeId ? { instanceId, nodeId } : null,
      ...(nodeId ? { editingContext: { breakpointId: null, state: null } } : {}),
    });
    overlaySync.notify();
  },
  setEditingContext: (ctx) => {
    const state = get();
    const contextual = ctx.breakpointId !== null || ctx.state !== null;
    const editingContext = {
      ...ctx,
      state: state.selection.length > 0 ? ctx.state : null,
    };
    set({
      editingContext,
      responsivePreviewFrameId: responsiveFrameForSelection(
        state.doc,
        state.selection,
        state.responsivePreviewFrameId,
      ),
      // Variant and inner-instance patches are intentionally flat deltas in
      // the document format. Exit those modes before a contextual write so a
      // breakpoint/state edit cannot accidentally change their global value.
      ...(contextual ? { editingVariant: null, editingInstanceOverride: null } : {}),
    });
    overlaySync.notify();
  },
  setPreviewFrame: (id) => set({ previewFrameId: id }),
  setShowComments: (show) => set({ showComments: show }),
  setInspectorFocus: (inspectorFocus) => set({ inspectorFocus }),
  requestFocusNode: (id) => set({ focusNodeRequest: { id, nonce: Date.now() } }),
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

/** Pick the frame a viewport switch should resize without depending on a live selection. */
export function responsiveFrameForSelection(
  doc: PitoletDocument | null,
  selection: NodeId[],
  current: NodeId | null,
): NodeId | null {
  if (!doc) return null;
  for (const id of selection) {
    if (!doc.nodes[id]) continue;
    const frameId = rootFrameOf(doc.nodes, id);
    const frame = doc.nodes[frameId];
    if (frame?.type === 'frame' && frame.parent === null) return frameId;
  }
  const currentFrame = current ? doc.nodes[current] : undefined;
  if (currentFrame?.type === 'frame' && currentFrame.parent === null) return current!;
  const pageFrame = doc.rootOrder.find((id) => {
    const node = doc.nodes[id];
    return node?.type === 'frame' && !node.isComponentMaster;
  });
  if (pageFrame) return pageFrame;
  return (
    doc.rootOrder.find((id) => {
      const node = doc.nodes[id];
      return node?.type === 'frame' && node.parent === null;
    }) ?? null
  );
}

function pruneEditingContext(
  context: EditorState['editingContext'],
  selection: NodeId[],
  doc: PitoletDocument,
): EditorState['editingContext'] {
  return {
    breakpointId:
      context.breakpointId &&
      doc.breakpoints.some((breakpoint) => breakpoint.id === context.breakpointId)
        ? context.breakpointId
        : null,
    state: selection.length > 0 ? context.state : null,
  };
}

function pruneEditingInstanceOverride(
  editing: EditingInstanceOverride | null,
  doc: PitoletDocument | null,
): EditingInstanceOverride | null {
  if (!editing || !doc) return null;
  const instance = doc.nodes[editing.instanceId];
  return instance?.type === 'instance' && doc.nodes[editing.nodeId] ? editing : null;
}

type RebuildResult =
  { ok: true; doc: PitoletDocument } | { ok: false; patchId: string; error: unknown };

/** Replay optimistic operations over one confirmed server snapshot. */
function rebuildOptimisticDocument(base: PitoletDocument, patches: PendingPatch[]): RebuildResult {
  let doc = base;
  const rebasedInverses: Array<{ patchId: string; inverseOps: PatchOp[] }> = [];
  for (const patch of patches) {
    try {
      const before = doc;
      const result = produceWithPatches(doc, (draft) => {
        applyPatches(draft, patch.ops);
      });
      doc = result[0];
      patch.preconditions = patchConditions(before, patch.ops);
      patch.postconditions = patchConditions(doc, patch.ops);
      if (patch.historyEffect.kind === 'edit') {
        rebasedInverses.push({
          patchId: patch.patchId,
          inverseOps: result[2] as PatchOp[],
        });
      }
    } catch (error) {
      return { ok: false, patchId: patch.patchId, error };
    }
  }
  for (const rebased of rebasedInverses) {
    history.updateInverse(rebased.patchId, rebased.inverseOps);
  }
  return { ok: true, doc };
}

function patchConditions(doc: PitoletDocument, ops: PatchOp[]): PatchCondition[] {
  const paths = new Map<string, Array<string | number>>();
  for (const operation of ops) {
    const last = operation.path.at(-1);
    // Array add/remove operations shift following indexes. Comparing the
    // complete parent array is the only safe way to distinguish "already
    // committed" from "would insert/remove again".
    const path = typeof last === 'number' ? operation.path.slice(0, -1) : operation.path;
    paths.set(JSON.stringify(path), path);
  }
  return [...paths.values()].map((path) => {
    const reading = readPath(doc, path);
    return {
      path,
      exists: reading.exists,
      ...(reading.exists ? { value: reading.value } : {}),
    };
  });
}

function patchCommitStatus(
  doc: PitoletDocument,
  patch: Pick<PendingPatch, 'preconditions' | 'postconditions'>,
): 'applied' | 'absent' | 'ambiguous' {
  if (conditionsMatch(doc, patch.postconditions)) return 'applied';
  if (conditionsMatch(doc, patch.preconditions)) return 'absent';
  return 'ambiguous';
}

function conditionsMatch(doc: PitoletDocument, conditions: PatchCondition[]): boolean {
  return conditions.every((condition) => {
    const reading = readPath(doc, condition.path);
    return (
      reading.exists === condition.exists &&
      (!condition.exists || deepEqualJson(reading.value, condition.value))
    );
  });
}

function readPath(
  value: unknown,
  path: Array<string | number>,
): { exists: boolean; value?: unknown } {
  let current = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { exists: false };
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqualJson(value, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(bRecord, key) &&
        deepEqualJson(aRecord[key], bRecord[key]),
    )
  );
}

function rejectHistoryEffect(effect: PendingHistoryEffect, patchId: string): void {
  if (effect.kind === 'edit') {
    history.discard(patchId);
  } else if (effect.kind === 'undo') {
    history.restoreUndo(effect.entry);
  } else {
    history.restoreRedo(effect.entry);
  }
}
