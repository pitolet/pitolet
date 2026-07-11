import {
  cloneSubtree,
  createInstance,
  newId,
  subtreeIds,
  type ComponentDef,
  type FrameNode,
  type PitoletDocument,
  type NodeId,
  type VariantProp,
} from '@pitolet/schema';
import type { Draft } from 'immer';

type Doc = Draft<PitoletDocument>;

/**
 * Turn a node's subtree into a component. The subtree MOVES to a master
 * frame placed beside the canvas content; an instance replaces it in situ
 * (Figma-style "create component").
 */
export function defineComponent(draft: Doc, nodeId: NodeId): NodeId | null {
  const node = draft.nodes[nodeId];
  if (!node || node.type === 'instance') return null;

  const componentId = newId();
  const def: ComponentDef = {
    id: componentId,
    name: node.name,
    rootId: '',
    variantProps: [],
    variants: {},
  };

  if (node.type === 'frame' && node.parent === null) {
    // A top-level frame becomes a master in place — no instance needed.
    node.isComponentMaster = componentId;
    def.rootId = node.id;
    draft.components[componentId] = def;
    return null;
  }

  // Detach subtree into a new master frame placed below existing frames.
  const parentId = node.parent!;
  const parent = draft.nodes[parentId]!;
  const indexInParent = parent.children.indexOf(nodeId);

  let maxBottom = 100;
  let minX = 100;
  for (const rootId of draft.rootOrder) {
    const frame = draft.nodes[rootId];
    if (frame?.type === 'frame') {
      const h = frame.canvas.height === 'auto' ? 400 : frame.canvas.height;
      maxBottom = Math.max(maxBottom, frame.canvas.y + h + 120);
      minX = Math.min(minX, frame.canvas.x);
    }
  }

  const master: FrameNode = {
    id: newId(),
    type: 'frame',
    name: node.name,
    parent: null,
    children: [nodeId],
    tag: 'div',
    visible: true,
    locked: false,
    canvas: { x: minX, y: maxBottom, width: 480, height: 'auto' },
    styles: { base: { display: 'flex', flexDirection: 'column', padding: sidesPx(24) } },
    isComponentMaster: componentId,
  };
  draft.nodes[master.id] = master;
  draft.rootOrder.push(master.id);
  node.parent = master.id;

  def.rootId = master.id;
  draft.components[componentId] = def;

  // Replace the original spot with an instance.
  const instance = createInstance({ componentId, name: node.name });
  instance.parent = parentId;
  draft.nodes[instance.id] = instance;
  parent.children.splice(indexInParent, 1, instance.id);
  return instance.id;
}

/** Insert a fresh instance of a component into a container. */
export function insertInstance(
  draft: Doc,
  componentId: string,
  parentId: NodeId,
  index?: number,
): NodeId | null {
  const def = draft.components[componentId];
  const parent = draft.nodes[parentId];
  if (!def || !parent || (parent.type !== 'frame' && parent.type !== 'element')) return null;
  const defaults: Record<string, string> = {};
  for (const prop of def.variantProps) defaults[prop.name] = prop.default;
  const instance = createInstance({ componentId, name: def.name, variant: defaults });
  instance.parent = parentId;
  draft.nodes[instance.id] = instance;
  parent.children.splice(index ?? parent.children.length, 0, instance.id);
  return instance.id;
}

/**
 * Detach: replace the instance with a deep copy of the master's content
 * (with variant + instance overrides baked in).
 */
export function detachInstance(draft: Doc, instanceId: NodeId): NodeId | null {
  const instance = draft.nodes[instanceId];
  if (!instance || instance.type !== 'instance') return null;
  const def = draft.components[instance.componentId];
  const master = def ? draft.nodes[def.rootId] : undefined;
  if (!def || !master) return null;

  // Clone the master CONTENT (children of the master frame, or the frame itself if used directly).
  const contentRoot = master.children.length === 1 ? master.children[0]! : def.rootId;
  const clone = cloneSubtree(draft.nodes as PitoletDocument['nodes'], contentRoot);

  // Bake variant + instance overrides into the clone. (Traversal order is
  // identical between master and clone, so ids pair up positionally.)
  const masterIds = subtreeIds(draft.nodes as PitoletDocument['nodes'], contentRoot);
  const cloneIds = subtreeIds(clone.nodes, clone.rootId);
  const idMap = new Map<NodeId, NodeId>();
  for (let i = 0; i < cloneIds.length && i < masterIds.length; i++) {
    idMap.set(cloneIds[i]!, masterIds[i]!);
  }
  const variantProps: VariantProp[] = JSON.parse(JSON.stringify(def.variantProps));
  for (const [cloneId, node] of Object.entries(clone.nodes)) {
    draft.nodes[cloneId] = node;
    const masterId = idMap.get(cloneId);
    if (!masterId) continue;
    for (const prop of variantProps) {
      const key = `${prop.name}=${instance.variant[prop.name] ?? prop.default}`;
      const patch = def.variants[key]?.[masterId];
      if (patch?.styles) Object.assign(node.styles.base, patch.styles);
      if (patch?.visible !== undefined) node.visible = patch.visible;
    }
    const override = instance.overrides[masterId];
    if (override) {
      if (override.styles) Object.assign(node.styles.base, override.styles);
      if (override.visible !== undefined) node.visible = override.visible;
      if (override.content && node.type === 'text') node.content = override.content;
      if (override.src && node.type === 'image') node.src = override.src;
    }
  }

  const root = draft.nodes[clone.rootId]!;
  root.parent = instance.parent;
  root.name = instance.name;
  if (instance.parent) {
    const parent = draft.nodes[instance.parent]!;
    const at = parent.children.indexOf(instanceId);
    parent.children.splice(at, 1, clone.rootId);
  }
  delete draft.nodes[instanceId];
  return clone.rootId;
}

function sidesPx(v: number) {
  const l = { value: v, unit: 'px' as const };
  return { top: l, right: l, bottom: l, left: l };
}
