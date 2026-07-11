import type { PitoletComment } from './document.js';
import { newId } from './factory.js';
import type { PitoletNode, NodeId } from './nodes.js';

type NodeMap = Record<NodeId, PitoletNode>;

/** Depth-first ids of a subtree, root included. Tolerates dangling child ids. */
export function subtreeIds(nodes: NodeMap, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack: NodeId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes[id];
    if (!node) continue;
    out.push(id);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

/** Ancestor chain from immediate parent up to the root frame. */
export function ancestors(nodes: NodeMap, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  let current = nodes[id]?.parent ?? null;
  while (current !== null) {
    out.push(current);
    current = nodes[current]?.parent ?? null;
  }
  return out;
}

export function isAncestor(nodes: NodeMap, maybeAncestor: NodeId, id: NodeId): boolean {
  return ancestors(nodes, id).includes(maybeAncestor);
}

/** The root frame containing a node (itself if top-level). */
export function rootFrameOf(nodes: NodeMap, id: NodeId): NodeId {
  let current = id;
  for (;;) {
    const parent = nodes[current]?.parent;
    if (parent === null || parent === undefined) return current;
    current = parent;
  }
}

/** Remove comments pinned to any of the given (deleted) nodes. */
export function pruneCommentsForNodes(
  comments: Record<string, PitoletComment> | undefined,
  deletedIds: Iterable<NodeId>,
): void {
  if (!comments) return;
  const deleted = new Set(deletedIds);
  for (const [commentId, comment] of Object.entries(comments)) {
    if (deleted.has(comment.nodeId)) delete comments[commentId];
  }
}

/**
 * Deep-clone a subtree with fresh ids (parent/children remapped). The clone's
 * root has parent null — the caller attaches it. Used by duplicate,
 * copy/paste, and instance detach.
 */
export function cloneSubtree(
  nodes: NodeMap,
  rootId: NodeId,
): { rootId: NodeId; nodes: Record<NodeId, PitoletNode> } {
  const idMap = new Map<NodeId, NodeId>();
  const ids = subtreeIds(nodes, rootId);
  for (const id of ids) idMap.set(id, newId());

  const out: Record<NodeId, PitoletNode> = {};
  for (const id of ids) {
    const source = nodes[id]!;
    // JSON clone (not structuredClone): sources may be immer draft proxies,
    // and the document format is plain JSON by design.
    const clone: PitoletNode = JSON.parse(JSON.stringify(source)) as PitoletNode;
    clone.id = idMap.get(id)!;
    clone.parent = source.parent && idMap.has(source.parent) ? idMap.get(source.parent)! : null;
    clone.children = source.children.filter((c) => idMap.has(c)).map((c) => idMap.get(c)!);
    out[clone.id] = clone;
  }
  return { rootId: idMap.get(rootId)!, nodes: out };
}
