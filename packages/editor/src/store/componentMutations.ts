import {
  cloneSubtree,
  componentContentBaseStyles,
  createInstance,
  newId,
  parseVariantKey,
  pruneCommentsForNodes,
  resolveVariantPatch,
  subtreeIds,
  type ComponentDef,
  type FrameNode,
  type PitoletDocument,
  type NodeId,
  type StateName,
  type StyleSheet,
  type VariantProp,
} from '@pitolet/schema';
import type { Draft } from 'immer';
import { canNodeContainChildren } from './nodeSafety.js';

type Doc = Draft<PitoletDocument>;

const COMPONENT_MASTER_WIDTH = 480;
const COMPONENT_MASTER_GAP = 120;

/** Place a new master to the right of every existing root frame. */
export function nextComponentMasterPosition(doc: Pick<PitoletDocument, 'nodes' | 'rootOrder'>): {
  x: number;
  y: number;
} {
  const roots = doc.rootOrder
    .map((id) => doc.nodes[id])
    .filter((node): node is FrameNode => node?.type === 'frame');
  if (roots.length === 0) return { x: 100, y: 100 };

  const ordinaryRoots = roots.filter((frame) => !frame.isComponentMaster);
  const verticalAnchors = ordinaryRoots.length > 0 ? ordinaryRoots : roots;
  return {
    x:
      Math.max(...roots.map((frame) => frame.canvas.x + frame.canvas.width)) + COMPONENT_MASTER_GAP,
    y: Math.min(...verticalAnchors.map((frame) => frame.canvas.y)),
  };
}

/** Return the component whose master contains a node, including the master itself. */
export function componentMasterIdForNode(
  doc: Pick<PitoletDocument, 'nodes'>,
  nodeId: NodeId,
): string | null {
  let current = doc.nodes[nodeId];
  const visited = new Set<NodeId>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.type === 'frame' && current.isComponentMaster) return current.isComponentMaster;
    current = current.parent ? doc.nodes[current.parent] : undefined;
  }
  return null;
}

/** Component creation is only valid for ordinary page content. */
export function canDefineComponent(doc: Pick<PitoletDocument, 'nodes'>, nodeId: NodeId): boolean {
  const node = doc.nodes[nodeId];
  return Boolean(
    node &&
    node.type !== 'instance' &&
    !(node.type === 'frame' && node.isComponentMaster) &&
    componentMasterIdForNode(doc, nodeId) === null,
  );
}

/** Whether a container can safely receive a component instance. */
export function canInsertInstance(
  doc: Pick<PitoletDocument, 'nodes' | 'components'>,
  componentId: string,
  parentId: NodeId,
): boolean {
  const parent = doc.nodes[parentId];
  if (!doc.components[componentId] || !parent) return false;
  if (!canNodeContainChildren(parent)) return false;
  return componentMasterIdForNode(doc, parentId) === null;
}

/**
 * Resolve the explicit insertion target shown in the Components panel.
 * No selection falls back to the first ordinary page frame. An ambiguous
 * selection, or any selection inside a master, deliberately has no target.
 */
export function componentInsertionTarget(
  doc: Pick<PitoletDocument, 'nodes' | 'rootOrder'>,
  selection: NodeId[],
): NodeId | null {
  if (selection.length === 0) {
    return (
      doc.rootOrder.find((id) => {
        const node = doc.nodes[id];
        return node?.type === 'frame' && !node.isComponentMaster;
      }) ?? null
    );
  }
  if (selection.length !== 1) return null;

  const selectedId = selection[0]!;
  if (componentMasterIdForNode(doc, selectedId)) return null;

  let current = doc.nodes[selectedId];
  const visited = new Set<NodeId>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (canNodeContainChildren(current)) {
      return current.id;
    }
    current = current.parent ? doc.nodes[current.parent] : undefined;
  }
  return null;
}

/**
 * Turn a node's subtree into a component. The subtree MOVES to a master
 * frame placed to the right of the canvas content; an instance replaces it in situ
 * (Figma-style "create component").
 */
export function defineComponent(draft: Doc, nodeId: NodeId): NodeId | null {
  const node = draft.nodes[nodeId];
  if (!node || !canDefineComponent(draft as PitoletDocument, nodeId)) return null;

  const componentId = newId();
  const def: ComponentDef = {
    id: componentId,
    name: node.name,
    rootId: '',
    contentRootId: node.id,
    variantProps: [],
    variants: {},
  };

  if (node.type === 'frame' && node.parent === null) {
    // A top-level frame becomes a master in place — no instance needed.
    node.isComponentMaster = componentId;
    def.rootId = node.id;
    def.contentRootId = node.id;
    draft.components[componentId] = def;
    return null;
  }

  // Detach the subtree into a new master frame beside existing frames. This
  // uses horizontal bounds only, so long auto-height pages cannot overlap it.
  const parentId = node.parent!;
  const parent = draft.nodes[parentId]!;
  const indexInParent = parent.children.indexOf(nodeId);
  const masterPosition = nextComponentMasterPosition(draft as PitoletDocument);

  const master: FrameNode = {
    id: newId(),
    type: 'frame',
    name: node.name,
    parent: null,
    children: [nodeId],
    tag: 'div',
    visible: true,
    locked: false,
    canvas: { ...masterPosition, width: COMPONENT_MASTER_WIDTH, height: 'auto' },
    styles: { base: { display: 'flex', flexDirection: 'column', padding: sidesPx(24) } },
    isComponentMaster: componentId,
  };
  draft.nodes[master.id] = master;
  draft.rootOrder.push(master.id);
  node.parent = master.id;

  def.rootId = master.id;
  def.contentRootId = nodeId;
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
  if (!def || !parent || !canInsertInstance(draft as PitoletDocument, componentId, parentId)) {
    return null;
  }
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
  const contentRoot = def.contentRootId;
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
  const activeVariant = Object.fromEntries(
    variantProps.map((prop) => [prop.name, instance.variant[prop.name] ?? prop.default]),
  );
  for (const [cloneId, node] of Object.entries(clone.nodes)) {
    draft.nodes[cloneId] = node;
    const masterId = idMap.get(cloneId);
    if (!masterId) continue;
    if (masterId === contentRoot) {
      const sourceNode = draft.nodes[masterId];
      if (sourceNode) {
        Object.assign(
          node.styles.base,
          componentContentBaseStyles(
            def as ComponentDef,
            sourceNode as PitoletDocument['nodes'][string],
          ),
        );
      }
    }
    const variantPatch = resolveVariantPatch(def as ComponentDef, activeVariant, masterId);
    if (variantPatch?.styles) Object.assign(node.styles.base, variantPatch.styles);
    if (variantPatch?.visible !== undefined) node.visible = variantPatch.visible;
    const override = instance.overrides[masterId];
    if (override) {
      if (override.styles) Object.assign(node.styles.base, override.styles);
      if (override.visible !== undefined) node.visible = override.visible;
      if (override.content && node.type === 'text') node.content = override.content;
      if (override.src && node.type === 'image') node.src = override.src;
    }
    if (masterId === contentRoot) mergeStyleSheet(node.styles, instance.styles);
  }

  const root = draft.nodes[clone.rootId]!;
  root.parent = instance.parent;
  root.name = instance.name;
  if (root.type === 'frame') root.isComponentMaster = undefined;
  root.visible = instance.visible && root.visible;
  root.locked = instance.locked || root.locked;
  if (instance.parent) {
    const parent = draft.nodes[instance.parent]!;
    const at = parent.children.indexOf(instanceId);
    parent.children.splice(at, 1, clone.rootId);
  }
  for (const comment of Object.values(draft.comments ?? {})) {
    if (comment.nodeId === instanceId) comment.nodeId = clone.rootId;
  }
  delete draft.nodes[instanceId];
  return clone.rootId;
}

/** Duplicate a complete component definition and remap every master-node reference. */
export function duplicateComponent(
  draft: Doc,
  componentId: string,
): { componentId: string; rootId: NodeId } | null {
  const source = draft.components[componentId];
  const master = source ? draft.nodes[source.rootId] : undefined;
  if (!source || master?.type !== 'frame') return null;

  const clone = cloneSubtree(draft.nodes as PitoletDocument['nodes'], source.rootId);
  const sourceIds = subtreeIds(draft.nodes as PitoletDocument['nodes'], source.rootId);
  const cloneIds = subtreeIds(clone.nodes, clone.rootId);
  const idMap = new Map<NodeId, NodeId>();
  sourceIds.forEach((id, index) => {
    const cloneId = cloneIds[index];
    if (cloneId) idMap.set(id, cloneId);
  });
  for (const [id, node] of Object.entries(clone.nodes)) draft.nodes[id] = node;

  const nextComponentId = newId();
  const nextName = uniqueComponentName(draft as PitoletDocument, `${source.name} copy`);
  const root = draft.nodes[clone.rootId];
  if (root?.type !== 'frame') return null;
  root.isComponentMaster = nextComponentId;
  root.name = nextName;
  const duplicatePosition = nextComponentMasterPosition(draft as PitoletDocument);
  root.canvas.x = duplicatePosition.x;
  root.canvas.y = duplicatePosition.y;
  const rootIndex = draft.rootOrder.indexOf(source.rootId);
  draft.rootOrder.splice(rootIndex >= 0 ? rootIndex + 1 : draft.rootOrder.length, 0, root.id);

  const variants: ComponentDef['variants'] = {};
  for (const [key, patches] of Object.entries(source.variants)) {
    const remapped: ComponentDef['variants'][string] = {};
    for (const [sourceId, patch] of Object.entries(patches)) {
      const nextId = idMap.get(sourceId);
      if (nextId) remapped[nextId] = JSON.parse(JSON.stringify(patch));
    }
    variants[key] = remapped;
  }

  draft.components[nextComponentId] = {
    id: nextComponentId,
    name: nextName,
    rootId: root.id,
    contentRootId: idMap.get(source.contentRootId) ?? root.id,
    variantProps: JSON.parse(JSON.stringify(source.variantProps)),
    variants,
  };
  return { componentId: nextComponentId, rootId: root.id };
}

/** Delete a component safely by detaching every live instance first. */
export function deleteComponent(draft: Doc, componentId: string): number | null {
  const component = draft.components[componentId];
  if (!component) return null;
  const instanceIds = Object.values(draft.nodes)
    .filter((node) => node.type === 'instance' && node.componentId === componentId)
    .map((node) => node.id);
  for (const instanceId of instanceIds) detachInstance(draft, instanceId);

  const deletedIds = subtreeIds(draft.nodes as PitoletDocument['nodes'], component.rootId);
  for (const id of deletedIds) delete draft.nodes[id];
  draft.rootOrder = draft.rootOrder.filter((id) => id !== component.rootId);
  pruneCommentsForNodes(draft.comments, deletedIds);
  delete draft.components[componentId];
  return instanceIds.length;
}

export function renameComponent(draft: Doc, componentId: string, name: string): boolean {
  const component = draft.components[componentId];
  const nextName = name.trim();
  if (!component || !nextName) return false;
  const previousName = component.name;
  component.name = nextName;
  const root = draft.nodes[component.rootId];
  if (root) root.name = nextName;
  for (const node of Object.values(draft.nodes)) {
    if (
      node.type === 'instance' &&
      node.componentId === componentId &&
      node.name === previousName
    ) {
      node.name = nextName;
    }
  }
  return true;
}

export function addVariantProperty(
  draft: Doc,
  componentId: string,
  name: string,
  firstValue: string,
): boolean {
  const component = draft.components[componentId];
  const cleanName = name.trim();
  const cleanValue = firstValue.trim();
  if (
    !component ||
    !validVariantName(cleanName) ||
    !validVariantValue(cleanValue) ||
    component.variantProps.some((prop) => prop.name === cleanName)
  ) {
    return false;
  }
  component.variantProps.push({ name: cleanName, values: [cleanValue], default: cleanValue });
  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'instance' && node.componentId === componentId) {
      node.variant[cleanName] = cleanValue;
    }
  }
  return true;
}

export function renameVariantProperty(
  draft: Doc,
  componentId: string,
  previousName: string,
  nextName: string,
): boolean {
  const component = draft.components[componentId];
  const cleanName = nextName.trim();
  const prop = component?.variantProps.find((candidate) => candidate.name === previousName);
  if (
    !component ||
    !prop ||
    !validVariantName(cleanName) ||
    component.variantProps.some((candidate) => candidate !== prop && candidate.name === cleanName)
  ) {
    return false;
  }
  rewriteVariantSelectors(component, (selector) => {
    if (selector[previousName] === undefined) return selector;
    const next = { ...selector, [cleanName]: selector[previousName]! };
    delete next[previousName];
    return next;
  });
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'instance' || node.componentId !== componentId) continue;
    if (node.variant[previousName] !== undefined) {
      node.variant[cleanName] = node.variant[previousName]!;
      delete node.variant[previousName];
    }
  }
  prop.name = cleanName;
  return true;
}

export function deleteVariantProperty(draft: Doc, componentId: string, name: string): boolean {
  const component = draft.components[componentId];
  if (!component?.variantProps.some((prop) => prop.name === name)) return false;
  component.variantProps = component.variantProps.filter((prop) => prop.name !== name);
  rewriteVariantSelectors(component, (selector) => {
    if (selector[name] === undefined) return selector;
    const next = { ...selector };
    delete next[name];
    return Object.keys(next).length > 0 ? next : null;
  });
  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'instance' && node.componentId === componentId) delete node.variant[name];
  }
  return true;
}

export function addVariantValue(
  draft: Doc,
  componentId: string,
  propName: string,
  value: string,
): boolean {
  const component = draft.components[componentId];
  const prop = component?.variantProps.find((candidate) => candidate.name === propName);
  const cleanValue = value.trim();
  if (!prop || !validVariantValue(cleanValue) || prop.values.includes(cleanValue)) return false;
  prop.values.push(cleanValue);
  return true;
}

export function renameVariantValue(
  draft: Doc,
  componentId: string,
  propName: string,
  previousValue: string,
  nextValue: string,
): boolean {
  const component = draft.components[componentId];
  const prop = component?.variantProps.find((candidate) => candidate.name === propName);
  const cleanValue = nextValue.trim();
  if (!component || !prop || !validVariantValue(cleanValue) || prop.values.includes(cleanValue)) {
    return false;
  }
  const index = prop.values.indexOf(previousValue);
  if (index < 0) return false;
  prop.values[index] = cleanValue;
  if (prop.default === previousValue) prop.default = cleanValue;
  rewriteVariantSelectors(component, (selector) =>
    selector[propName] === previousValue ? { ...selector, [propName]: cleanValue } : selector,
  );
  for (const node of Object.values(draft.nodes)) {
    if (
      node.type === 'instance' &&
      node.componentId === componentId &&
      node.variant[propName] === previousValue
    ) {
      node.variant[propName] = cleanValue;
    }
  }
  return true;
}

export function removeVariantValue(
  draft: Doc,
  componentId: string,
  propName: string,
  value: string,
): boolean {
  const component = draft.components[componentId];
  const prop = component?.variantProps.find((candidate) => candidate.name === propName);
  if (!component || !prop || prop.values.length <= 1 || !prop.values.includes(value)) return false;
  prop.values = prop.values.filter((candidate) => candidate !== value);
  if (prop.default === value) prop.default = prop.values[0]!;
  rewriteVariantSelectors(component, (selector) =>
    selector[propName] === value ? null : selector,
  );
  for (const node of Object.values(draft.nodes)) {
    if (
      node.type === 'instance' &&
      node.componentId === componentId &&
      node.variant[propName] === value
    ) {
      node.variant[propName] = prop.default;
    }
  }
  return true;
}

export function setVariantDefault(
  draft: Doc,
  componentId: string,
  propName: string,
  value: string,
): boolean {
  const prop = draft.components[componentId]?.variantProps.find(
    (candidate) => candidate.name === propName,
  );
  if (!prop?.values.includes(value)) return false;
  prop.default = value;
  return true;
}

export function setNodeVisibility(
  draft: Doc,
  nodeId: NodeId,
  visible: boolean,
  editingVariant: { componentId: string; key: string } | null,
): boolean {
  const node = draft.nodes[nodeId];
  if (!node) return false;
  const masterId = componentMasterIdForNode(draft as PitoletDocument, nodeId);
  if (editingVariant && masterId === editingVariant.componentId) {
    const component = draft.components[masterId];
    if (!component) return false;
    const bucket = (component.variants[editingVariant.key] =
      component.variants[editingVariant.key] ?? {});
    const patch = (bucket[nodeId] = bucket[nodeId] ?? {});
    patch.visible = visible;
    return true;
  }
  node.visible = visible;
  return true;
}

export function effectiveNodeVisibility(
  doc: Pick<PitoletDocument, 'nodes' | 'components'>,
  nodeId: NodeId,
  editingVariant: { componentId: string; key: string } | null,
): boolean {
  const node = doc.nodes[nodeId];
  if (!node) return false;
  if (!editingVariant || componentMasterIdForNode(doc, nodeId) !== editingVariant.componentId) {
    return node.visible;
  }
  const component = doc.components[editingVariant.componentId];
  const values = parseVariantKey(editingVariant.key);
  return component && values
    ? (resolveVariantPatch(component, values, nodeId)?.visible ?? node.visible)
    : node.visible;
}

function rewriteVariantSelectors(
  component: Draft<ComponentDef>,
  transform: (selector: Record<string, string>) => Record<string, string> | null,
): void {
  const rewritten: ComponentDef['variants'] = {};
  for (const [key, patches] of Object.entries(component.variants)) {
    const parsed = parseVariantKey(key);
    const next = parsed ? transform(parsed) : null;
    if (!next) continue;
    const nextKey = partialVariantKey(next);
    const bucket = (rewritten[nextKey] = rewritten[nextKey] ?? {});
    for (const [nodeId, patch] of Object.entries(patches)) {
      const current = bucket[nodeId];
      bucket[nodeId] = {
        ...current,
        ...patch,
        ...(current?.styles || patch.styles
          ? { styles: { ...current?.styles, ...patch.styles } }
          : {}),
      };
    }
  }
  component.variants = rewritten;
}

function partialVariantKey(values: Record<string, string>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function validVariantName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function validVariantValue(value: string): boolean {
  return Boolean(value && !/[=,]/.test(value));
}

function mergeStyleSheet(target: Draft<StyleSheet>, source: StyleSheet): void {
  Object.assign(target.base, source.base);
  for (const [breakpoint, styles] of Object.entries(source.breakpoints ?? {})) {
    target.breakpoints ??= {};
    Object.assign((target.breakpoints[breakpoint] = target.breakpoints[breakpoint] ?? {}), styles);
  }
  for (const [state, styles] of Object.entries(source.states ?? {})) {
    target.states ??= {};
    const stateName = state as StateName;
    Object.assign((target.states[stateName] = target.states[stateName] ?? {}), styles);
  }
}

function uniqueComponentName(doc: PitoletDocument, preferred: string): string {
  const names = new Set(Object.values(doc.components).map((component) => component.name));
  if (!names.has(preferred)) return preferred;
  let suffix = 2;
  while (names.has(`${preferred} ${suffix}`)) suffix += 1;
  return `${preferred} ${suffix}`;
}

function sidesPx(v: number) {
  const l = { value: v, unit: 'px' as const };
  return { top: l, right: l, bottom: l, left: l };
}
