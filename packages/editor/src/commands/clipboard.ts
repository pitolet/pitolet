import {
  cloneSubtree,
  subtreeIds,
  validateNode,
  type PitoletNode,
  type NodeId,
} from '@pitolet/schema';
import { useEditor } from '../store/index.js';

const CLIP_PREFIX = 'pitolet-clipboard:';

interface ClipPayload {
  roots: NodeId[];
  nodes: Record<NodeId, PitoletNode>;
}

/**
 * Copy/paste as self-contained JSON on the system clipboard — works across
 * documents and even across Pitolet instances. Token refs paste as-is and
 * resolve against the target document's tokens (missing ones degrade
 * gracefully).
 */
export async function copySelection(): Promise<void> {
  const s = useEditor.getState();
  const doc = s.doc;
  if (!doc || s.selection.length === 0) return;

  // Skip nodes whose ancestor is also selected (they come along anyway).
  const roots = s.selection.filter(
    (id) => !s.selection.some((other) => other !== id && subtreeIds(doc.nodes, other).includes(id)),
  );
  const payload: ClipPayload = { roots: [], nodes: {} };
  for (const id of roots) {
    for (const subId of subtreeIds(doc.nodes, id)) {
      payload.nodes[subId] = doc.nodes[subId]!;
    }
    payload.roots.push(id);
  }
  await navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload));
}

export async function pasteFromClipboard(): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (!text.startsWith(CLIP_PREFIX)) return;

  let payload: ClipPayload;
  try {
    payload = JSON.parse(text.slice(CLIP_PREFIX.length)) as ClipPayload;
    Object.values(payload.nodes).forEach((n) => validateNode(n));
  } catch {
    return;
  }

  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc) return;

  // Paste target: selected container, else the selection's parent, else canvas.
  let targetId: NodeId | null = null;
  const selected = store.selection[0] ? doc.nodes[store.selection[0]] : undefined;
  if (selected) {
    targetId =
      selected.type === 'frame' || selected.type === 'element'
        ? selected.id
        : selected.parent;
  }

  const newRoots: NodeId[] = [];
  store.dispatchEdit('Paste', (draft) => {
    for (const rootId of payload.roots) {
      const clone = cloneSubtree(payload.nodes, rootId);
      for (const [id, node] of Object.entries(clone.nodes)) {
        // Strip dangling component references from foreign documents.
        if (node.type === 'instance' && !draft.components[node.componentId]) continue;
        draft.nodes[id] = node;
      }
      const root = draft.nodes[clone.rootId];
      if (!root) continue;
      if (root.type === 'frame' && (targetId === null || payload.nodes[rootId]!.parent === null)) {
        root.parent = null;
        root.canvas.x += 40;
        root.canvas.y += 40;
        draft.rootOrder.push(clone.rootId);
      } else if (targetId && draft.nodes[targetId]) {
        root.parent = targetId;
        draft.nodes[targetId]!.children.push(clone.rootId);
      } else {
        // No container: wrap non-frame content is out of scope — skip.
        for (const subId of subtreeIds(clone.nodes, clone.rootId)) delete draft.nodes[subId];
        continue;
      }
      newRoots.push(clone.rootId);
    }
  });
  if (newRoots.length > 0) store.select(newRoots);
}
