import {
  cloneSubtree,
  createElement,
  pruneCommentsForNodes,
  subtreeIds,
  type PitoletDocument,
  type NodeId,
} from '@pitolet/schema';
import type { Draft } from 'immer';

type Doc = Draft<PitoletDocument>;

/**
 * Shared mutation recipes — used by keyboard commands, canvas tools, panels,
 * and (via the server) MCP write tools. Always run inside dispatchEdit.
 */

export function deleteNodes(draft: Doc, ids: NodeId[]): void {
  const allDeleted: NodeId[] = [];
  for (const id of ids) {
    const node = draft.nodes[id];
    if (!node) continue; // already removed as part of an ancestor
    if (node.parent) {
      const parent = draft.nodes[node.parent];
      if (parent) parent.children = parent.children.filter((c) => c !== id);
    } else {
      draft.rootOrder = draft.rootOrder.filter((r) => r !== id);
    }
    for (const subId of subtreeIds(draft.nodes as PitoletDocument['nodes'], id)) {
      delete draft.nodes[subId];
      allDeleted.push(subId);
    }
  }
  pruneCommentsForNodes(draft.comments, allDeleted);
}

export function moveFrames(draft: Doc, ids: NodeId[], dx: number, dy: number): void {
  for (const id of ids) {
    const node = draft.nodes[id];
    if (node?.type === 'frame' && node.parent === null) {
      node.canvas.x = Math.round(node.canvas.x + dx);
      node.canvas.y = Math.round(node.canvas.y + dy);
    }
  }
}

/**
 * Duplicate subtrees. Returns the new root ids (for selection). Frames get a
 * +24px canvas offset; in-flow nodes insert right after their source.
 */
export function duplicateNodes(draft: Doc, ids: NodeId[]): NodeId[] {
  const newIds: NodeId[] = [];
  for (const id of ids) {
    const source = draft.nodes[id];
    if (!source) continue;
    const clone = cloneSubtree(draft.nodes as PitoletDocument['nodes'], id);
    for (const [cloneId, node] of Object.entries(clone.nodes)) {
      draft.nodes[cloneId] = node;
    }
    const root = draft.nodes[clone.rootId]!;
    root.name = `${source.name} copy`;
    if (source.parent === null) {
      if (root.type === 'frame') {
        root.canvas.x += 24;
        root.canvas.y += 24;
      }
      const at = draft.rootOrder.indexOf(id);
      draft.rootOrder.splice(at + 1, 0, clone.rootId);
      root.parent = null;
    } else {
      const parent = draft.nodes[source.parent]!;
      const at = parent.children.indexOf(id);
      parent.children.splice(at + 1, 0, clone.rootId);
      root.parent = source.parent;
    }
    newIds.push(clone.rootId);
  }
  return newIds;
}

/**
 * Wrap same-parent siblings in a new flex container. Returns the group id.
 */
export function groupNodes(draft: Doc, ids: NodeId[]): NodeId | null {
  const first = draft.nodes[ids[0] ?? ''];
  if (!first || first.parent === null) return null;
  const parentId = first.parent;
  if (!ids.every((id) => draft.nodes[id]?.parent === parentId)) return null;

  const parent = draft.nodes[parentId]!;
  const ordered = parent.children.filter((c) => ids.includes(c));
  const insertAt = parent.children.indexOf(ordered[0]!);

  const group = createElement({
    name: 'Group',
    styles: { display: 'flex', flexDirection: 'column' },
  });
  group.parent = parentId;
  group.children = ordered;
  draft.nodes[group.id] = group;

  parent.children = parent.children.filter((c) => !ids.includes(c));
  parent.children.splice(insertAt, 0, group.id);
  for (const id of ordered) draft.nodes[id]!.parent = group.id;
  return group.id;
}

export function setFrameBounds(
  draft: Doc,
  id: NodeId,
  bounds: { x: number; y: number; width: number; height: number | 'auto' },
): void {
  const node = draft.nodes[id];
  if (node?.type === 'frame') {
    node.canvas.x = Math.round(bounds.x);
    node.canvas.y = Math.round(bounds.y);
    node.canvas.width = Math.max(16, Math.round(bounds.width));
    node.canvas.height =
      bounds.height === 'auto' ? 'auto' : Math.max(16, Math.round(bounds.height));
  }
}
