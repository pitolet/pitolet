import type { PitoletDocument, NodeId } from '@pitolet/schema';

/**
 * Click-target resolution (Figma-style deep select).
 *
 * The "focus container" is implicit: the parent of the current selection.
 * A single click selects the ancestor of the hit node that is a direct child
 * of the focus container; double-click descends one level deeper. Escape
 * ascends. Clicking outside the focused subtree resets to top level.
 */

/** Ancestor chain from the root frame down to (and including) the node. */
export function chainTo(doc: PitoletDocument, id: NodeId): NodeId[] {
  const chain: NodeId[] = [];
  let current: NodeId | null = id;
  while (current !== null) {
    chain.unshift(current);
    current = doc.nodes[current]?.parent ?? null;
  }
  return chain;
}

export function resolveClickTarget(
  doc: PitoletDocument,
  hitId: NodeId,
  selection: NodeId[],
): NodeId {
  const chain = chainTo(doc, hitId);
  if (chain.length === 0) return hitId;

  // If the click lands on/inside an already-selected node, keep that node
  // (so drags on the current selection just work).
  for (let i = chain.length - 1; i >= 0; i--) {
    if (selection.includes(chain[i]!)) return chain[i]!;
  }

  // Focus depth = depth of the current selection's container within this chain.
  const focusDepth = selectionFocusDepth(doc, chain, selection);
  return chain[Math.min(focusDepth, chain.length - 1)]!;
}

/** Command/control-click bypasses focus depth and targets the deepest hit layer. */
export function resolveDirectClickTarget(doc: PitoletDocument, hitId: NodeId): NodeId {
  const chain = chainTo(doc, hitId);
  return chain.at(-1) ?? hitId;
}

/** Double-click descends one level below the current click target. */
export function resolveDoubleClickTarget(
  doc: PitoletDocument,
  hitId: NodeId,
  selection: NodeId[],
): NodeId {
  const chain = chainTo(doc, hitId);
  for (let i = 0; i < chain.length - 1; i++) {
    if (selection.includes(chain[i]!)) return chain[i + 1]!;
  }
  return resolveClickTarget(doc, hitId, selection);
}

/** Escape: select the parent of the current selection (single node). */
export function parentOfSelection(doc: PitoletDocument, selection: NodeId[]): NodeId | null {
  const first = selection[0];
  if (!first) return null;
  return doc.nodes[first]?.parent ?? null;
}

function selectionFocusDepth(doc: PitoletDocument, chain: NodeId[], selection: NodeId[]): number {
  if (selection.length === 0) return 0;
  // The container whose children are currently being edited.
  const container = doc.nodes[selection[0]!]?.parent ?? null;
  if (container === null) return 0;
  const idx = chain.indexOf(container);
  return idx >= 0 ? idx + 1 : 0;
}
