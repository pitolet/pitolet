import {
  cloneSubtree,
  validateNode,
  type Asset,
  type PitoletNode,
  type NodeId,
  type PitoletDocument,
} from '@pitolet/schema';
import { componentMasterIdForNode } from '../store/componentMutations.js';
import { useEditor } from '../store/index.js';
import { isEffectivelyLocked } from '../store/locks.js';
import { canNodeContainChildren, isVoidElementTag } from '../store/nodeSafety.js';
import { selectionRoots } from '../store/mutations.js';
import { apiUrl, assetUrl } from '../sync/serverBase.js';

const CLIP_PREFIX = 'pitolet-clipboard:';
const MAX_CLIPBOARD_BYTES = 25 * 1024 * 1024;
const MAX_CLIPBOARD_NODES = 10_000;
const MAX_CLIPBOARD_DEPTH = 100;
const MAX_EMBEDDED_ASSET_BYTES = 12 * 1024 * 1024;

interface ClipPayload {
  roots: NodeId[];
  nodes: Record<NodeId, PitoletNode>;
  assets?: Record<string, Asset>;
  assetData?: Record<string, string>;
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
  const roots = selectionRoots(doc.nodes, s.selection);
  const payload: ClipPayload = { roots: [], nodes: {}, assets: {}, assetData: {} };
  const assetIds = new Set<string>();
  for (const id of roots) {
    for (const subId of safeSubtreeIds(doc.nodes, id)) {
      payload.nodes[subId] = doc.nodes[subId]!;
      const node = doc.nodes[subId]!;
      if (node.type === 'image' && 'asset' in node.src) assetIds.add(node.src.asset);
    }
    payload.roots.push(id);
  }
  let embeddedBytes = 0;
  for (const assetId of assetIds) {
    const metadata = doc.assets[assetId];
    if (metadata) payload.assets![assetId] = metadata;
    try {
      const response = await fetch(assetUrl(assetId));
      if (!response.ok) continue;
      const blob = await response.blob();
      if (embeddedBytes + blob.size > MAX_EMBEDDED_ASSET_BYTES) continue;
      payload.assetData![assetId] = await blobToDataUrl(blob);
      embeddedBytes += blob.size;
    } catch {
      // Same-server pastes can still reuse the content-addressed asset id.
    }
  }
  if (Object.keys(payload.assets!).length === 0) delete payload.assets;
  if (Object.keys(payload.assetData!).length === 0) delete payload.assetData;
  try {
    await navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload));
  } catch (error) {
    useEditor
      .getState()
      .setSyncIssue(
        error instanceof Error ? `Could not copy: ${error.message}` : 'Could not copy.',
      );
  }
}

export async function pasteFromClipboard(): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (!text.startsWith(CLIP_PREFIX)) return;
  if (new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) return;

  let payload: ClipPayload | null;
  try {
    payload = validateClipPayload(JSON.parse(text.slice(CLIP_PREFIX.length)));
  } catch {
    return;
  }
  if (!payload) return;

  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc || store.readOnly || !store.connected || store.switchingDocument) return;
  const sourceDocumentId = doc.id;

  // Paste target: selected container, else the selection's parent, else canvas.
  let targetId: NodeId | null = null;
  const selected = store.selection[0] ? doc.nodes[store.selection[0]] : undefined;
  if (selected) {
    targetId = canNodeContainChildren(selected) ? selected.id : selected.parent;
  }
  if (
    targetId &&
    (isEffectivelyLocked(doc, targetId) || !canNodeContainChildren(doc.nodes[targetId]))
  ) {
    return;
  }

  const assetIds = referencedAssetIds(payload.nodes);
  const remappedAssets = await uploadClipboardAssets(payload, assetIds);
  const current = useEditor.getState();
  if (
    current.doc?.id !== sourceDocumentId ||
    current.readOnly ||
    !current.connected ||
    current.switchingDocument
  ) {
    return;
  }

  const newRoots: NodeId[] = [];
  store.dispatchEdit('Paste', (draft) => {
    for (const rootId of payload.roots) {
      if (!canPasteSubtree(draft as PitoletDocument, payload.nodes, rootId, targetId)) continue;
      const clone = cloneSubtree(payload.nodes, rootId);
      for (const [id, node] of Object.entries(clone.nodes)) {
        if (node.type === 'image' && 'asset' in node.src) {
          const originalId = node.src.asset;
          node.src = { asset: remappedAssets[originalId] ?? originalId };
          const metadata = payload.assets?.[originalId];
          if (metadata) draft.assets[node.src.asset] = metadata;
        }
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
        for (const subId of safeSubtreeIds(clone.nodes, clone.rootId)) delete draft.nodes[subId];
        continue;
      }
      newRoots.push(clone.rootId);
    }
  });
  const savedRoots = newRoots.filter((id) => useEditor.getState().doc?.nodes[id]);
  if (savedRoots.length > 0) store.select(savedRoots);
}

/** Reject component payloads that would create dangling or nested component relationships. */
export function canPasteSubtree(
  doc: Pick<PitoletDocument, 'nodes' | 'components'>,
  nodes: Record<NodeId, PitoletNode>,
  rootId: NodeId,
  targetId: NodeId | null,
): boolean {
  const ids = safeSubtreeIds(nodes, rootId);
  if (ids.length === 0) return false;
  const containsInstance = ids.some((id) => nodes[id]?.type === 'instance');
  if (targetId && componentMasterIdForNode(doc, targetId) && containsInstance) return false;
  if (targetId && !canNodeContainChildren(doc.nodes[targetId])) return false;
  return ids.every((id) => {
    const node = nodes[id];
    if (!node) return false;
    if (node.type === 'frame' && node.isComponentMaster) return false;
    return node.type !== 'instance' || Boolean(doc.components[node.componentId]);
  });
}

/** Strict graph validation before any traversal or clone of clipboard data. */
export function validateClipPayload(raw: unknown): ClipPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<ClipPayload>;
  if (!Array.isArray(candidate.roots) || !candidate.nodes || typeof candidate.nodes !== 'object') {
    return null;
  }
  const entries = Object.entries(candidate.nodes);
  if (entries.length === 0 || entries.length > MAX_CLIPBOARD_NODES) return null;
  if (
    candidate.roots.length === 0 ||
    candidate.roots.length > entries.length ||
    candidate.roots.some((root) => typeof root !== 'string')
  ) {
    return null;
  }

  const nodes: Record<NodeId, PitoletNode> = {};
  for (const [id, rawNode] of entries) {
    const node = validateNode(rawNode);
    if (node.id !== id) return null;
    if (isVoidElementTag(node.tag) && node.children.length > 0) return null;
    nodes[id] = node;
  }
  const roots = [...new Set(candidate.roots)];
  if (roots.length !== candidate.roots.length || roots.some((root) => !nodes[root])) return null;

  const owners = new Map<NodeId, NodeId>();
  for (const node of Object.values(nodes)) {
    const children = new Set<NodeId>();
    for (const childId of node.children) {
      if (children.has(childId) || !nodes[childId]) return null;
      children.add(childId);
      if (owners.has(childId)) return null;
      owners.set(childId, node.id);
      if (nodes[childId]!.parent !== node.id) return null;
    }
  }

  const visited = new Set<NodeId>();
  for (const root of roots) {
    const stack: Array<{ id: NodeId; depth: number; exit: boolean }> = [
      { id: root, depth: 1, exit: false },
    ];
    const active = new Set<NodeId>();
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.exit) {
        active.delete(frame.id);
        visited.add(frame.id);
        continue;
      }
      if (frame.depth > MAX_CLIPBOARD_DEPTH || active.has(frame.id)) return null;
      if (visited.has(frame.id)) continue;
      active.add(frame.id);
      stack.push({ ...frame, exit: true });
      for (const child of nodes[frame.id]!.children) {
        stack.push({ id: child, depth: frame.depth + 1, exit: false });
      }
    }
  }
  if (visited.size !== entries.length) return null;

  const assets = validateAssetMap(candidate.assets);
  const assetData =
    candidate.assetData && typeof candidate.assetData === 'object'
      ? Object.fromEntries(
          Object.entries(candidate.assetData).filter(
            ([, value]) => typeof value === 'string' && value.startsWith('data:image/'),
          ),
        )
      : undefined;
  return { roots, nodes, ...(assets ? { assets } : {}), ...(assetData ? { assetData } : {}) };
}

function validateAssetMap(raw: unknown): Record<string, Asset> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const assets: Record<string, Asset> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const asset = value as Partial<Asset>;
    if (
      typeof asset.fileName !== 'string' ||
      typeof asset.mime !== 'string' ||
      !asset.mime.startsWith('image/') ||
      typeof asset.width !== 'number' ||
      !Number.isFinite(asset.width) ||
      asset.width < 0 ||
      typeof asset.height !== 'number' ||
      !Number.isFinite(asset.height) ||
      asset.height < 0
    ) {
      continue;
    }
    assets[id] = {
      fileName: asset.fileName,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
    };
  }
  return Object.keys(assets).length > 0 ? assets : undefined;
}

function safeSubtreeIds(nodes: Record<NodeId, PitoletNode>, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const visited = new Set<NodeId>();
  const stack = [rootId];
  while (stack.length > 0 && out.length <= MAX_CLIPBOARD_NODES) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes[id];
    if (!node) continue;
    out.push(id);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }
  return out;
}

function referencedAssetIds(nodes: Record<NodeId, PitoletNode>): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type === 'image' && 'asset' in node.src) ids.add(node.src.asset);
  }
  return ids;
}

async function uploadClipboardAssets(
  payload: ClipPayload,
  ids: Set<string>,
): Promise<Record<string, string>> {
  const remapped: Record<string, string> = {};
  for (const id of ids) {
    const data = payload.assetData?.[id];
    if (!data) continue;
    try {
      const blob = await (await fetch(data)).blob();
      const response = await fetch(apiUrl('/api/assets'), {
        method: 'POST',
        headers: { 'content-type': payload.assets?.[id]?.mime ?? blob.type },
        body: blob,
      });
      if (!response.ok) continue;
      const result = (await response.json()) as { assetId?: unknown };
      if (typeof result.assetId === 'string') remapped[id] = result.assetId;
    } catch {
      // Preserve the original content-addressed id as a same-server fallback.
    }
  }
  return remapped;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read asset'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not encode asset'));
    reader.readAsDataURL(blob);
  });
}
