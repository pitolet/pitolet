import type { PatchOp, PitoletDocument, NodeId } from '@pitolet/schema';

/** A node is locked when it or any of its ancestors is locked. */
export function isEffectivelyLocked(doc: Pick<PitoletDocument, 'nodes'>, id: NodeId): boolean {
  let current: NodeId | null = id;
  const visited = new Set<NodeId>();
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    const node: PitoletDocument['nodes'][string] | undefined = doc.nodes[current];
    if (!node) return false;
    if (node.locked) return true;
    current = node.parent;
  }
  return false;
}

/** Every node whose own lock protects this node, nearest first. */
export function lockingNodeIds(doc: Pick<PitoletDocument, 'nodes'>, id: NodeId): NodeId[] {
  let current: NodeId | null = id;
  const visited = new Set<NodeId>();
  const locking: NodeId[] = [];
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const node: PitoletDocument['nodes'][string] | undefined = doc.nodes[current];
    if (!node) break;
    if (node.locked) locking.push(current);
    current = node.parent;
  }
  return locking;
}

/**
 * Find the closest canvas target that is not protected by a lock. A locked
 * child clicks through to its first unlocked ancestor; a locked root has no
 * editable canvas target.
 */
export function closestUnlockedAncestor(
  doc: Pick<PitoletDocument, 'nodes'>,
  id: NodeId,
): NodeId | null {
  let current: NodeId | null = id;
  const visited = new Set<NodeId>();
  while (current) {
    if (visited.has(current)) return null;
    visited.add(current);
    if (!isEffectivelyLocked(doc, current)) return current;
    current = doc.nodes[current]?.parent ?? null;
  }
  return null;
}

/** Visibility and lock toggles remain available from the layer tree. */
function isAllowedLockedNodeOp(op: PatchOp): boolean {
  return (
    op.path.length === 3 &&
    op.path[0] === 'nodes' &&
    (op.path[2] === 'locked' || op.path[2] === 'visible')
  );
}

/** Reject a whole recipe if it attempts to change a protected node. */
export function editsLockedNode(doc: PitoletDocument, ops: PatchOp[]): boolean {
  return ops.some((op) => {
    if (op.path[0] !== 'nodes' || typeof op.path[1] !== 'string') return false;
    if (!isEffectivelyLocked(doc, op.path[1])) return false;
    return !isAllowedLockedNodeOp(op);
  });
}
