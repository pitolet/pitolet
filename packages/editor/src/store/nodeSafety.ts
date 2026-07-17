import type { PitoletDocument, PitoletNode, NodeId } from '@pitolet/schema';

/** HTML elements that must never receive children. */
export const VOID_ELEMENT_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export function isVoidElementTag(tag: string): boolean {
  return VOID_ELEMENT_TAGS.has(tag.toLowerCase());
}

export function canNodeContainChildren(node: PitoletNode | undefined): boolean {
  return Boolean(
    node && (node.type === 'frame' || node.type === 'element') && !isVoidElementTag(node.tag),
  );
}

export function nearestChildContainer(
  doc: Pick<PitoletDocument, 'nodes'>,
  hitId: NodeId,
): NodeId | null {
  let current: NodeId | null = hitId;
  const visited = new Set<NodeId>();
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const node: PitoletNode | undefined = doc.nodes[current];
    if (!node) return null;
    if (canNodeContainChildren(node)) return current;
    current = node.parent;
  }
  return null;
}
