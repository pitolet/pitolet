import {
  componentContentBaseStyles,
  matchingVariantKeys,
  resolveStyles,
  styleToCssProps,
  type ComponentDef,
  type PitoletNode,
  type InstanceNode,
  type NodeId,
  type StyleSheet,
} from '@pitolet/schema';
import { createElement, memo, type CSSProperties } from 'react';
import { useEditor } from '../store/index.js';
import { isVoidElementTag } from '../store/nodeSafety.js';
import { assetUrl } from '../sync/serverBase.js';
import {
  renderSpans,
  safeTag,
  safeTextTag,
  sanitizeAttrs,
  type RenderContext,
} from './NodeRenderer.js';

/**
 * Renders a component instance: the master's subtree with variant patches
 * and per-node instance overrides composed into each node's base styles.
 * Hit-testing sees the INSTANCE id on every element (data-node-id), so
 * selecting/deleting inside an instance targets the instance itself.
 */
export const InstanceRenderer = memo(function InstanceRenderer({
  instance,
  ctx,
}: {
  instance: InstanceNode;
  ctx: RenderContext;
}) {
  const component = useEditor((s) => s.doc?.components[instance.componentId]);
  const master = useEditor((s) => (component ? s.doc?.nodes[component.rootId] : undefined));
  const previewState = useEditor((s) =>
    s.editingContext.state && s.selection.includes(instance.id) ? s.editingContext.state : null,
  );
  if (!component || !master) return null;

  return (
    <MasterNode
      nodeId={component.contentRootId}
      instance={instance}
      component={component}
      ctx={ctx}
      previewState={previewState}
      isRoot
    />
  );
});

function MasterNode({
  nodeId,
  instance,
  component,
  ctx,
  previewState,
  isRoot = false,
}: {
  nodeId: NodeId;
  instance: InstanceNode;
  component: ComponentDef;
  ctx: RenderContext;
  previewState: 'hover' | 'focus' | 'active' | null;
  isRoot?: boolean;
}) {
  const node = useEditor((s) => s.doc?.nodes[nodeId]);
  if (!node) return null;

  const override = instance.overrides[nodeId];
  const visible = override?.visible ?? variantVisible(component, instance, nodeId) ?? node.visible;
  if (!visible) return null;

  const styles = composeStyles(node, component, instance, nodeId, isRoot);
  const resolved = resolveStyles(styles, {
    frameWidth: ctx.frameWidth,
    breakpoints: ctx.breakpoints,
    tokens: ctx.tokens,
    activeStates: isRoot && previewState ? [previewState] : undefined,
  });
  const css = styleToCssProps(resolved, {
    parentDisplay: ctx.parentDisplay,
    parentDirection: ctx.parentDirection,
  }) as CSSProperties;

  // The whole subtree hit-tests as the instance.
  const common = {
    'data-node-id': isRoot ? instance.id : undefined,
    style: css,
    tabIndex: isCanvasFocusableTag(node.tag) ? -1 : undefined,
    draggable: false,
    ...sanitizeAttrs(node.attrs),
  };

  switch (node.type) {
    case 'text': {
      const content = override?.content ?? node.content;
      return createElement(safeTextTag(node.tag), common, renderSpans(content));
    }
    case 'image': {
      const src = override?.src ?? node.src;
      const url = 'url' in src ? src.url : assetUrl(src.asset);
      return createElement('img', { ...common, src: url, alt: node.alt, draggable: false });
    }
    case 'instance':
      return null; // Nested components are rejected by document validation.
    default: {
      const tag = safeTag(node.tag);
      return createElement(
        tag,
        common,
        isVoidElementTag(tag)
          ? undefined
          : node.children.map((childId) => (
              <MasterNode
                key={childId}
                nodeId={childId}
                instance={instance}
                component={component}
                ctx={{
                  ...ctx,
                  parentDisplay: resolved.display,
                  parentDirection: resolved.flexDirection,
                }}
                previewState={previewState}
              />
            )),
      );
    }
  }
}

function isCanvasFocusableTag(tag: string): boolean {
  return ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag.toLowerCase());
}

function composeStyles(
  node: PitoletNode,
  component: ComponentDef,
  instance: InstanceNode,
  nodeId: NodeId,
  isRoot: boolean,
): StyleSheet {
  const base = componentContentBaseStyles(component, node);
  for (const key of matchingVariantKeys(instance.variant, component.variantProps)) {
    const patch = component.variants[key]?.[nodeId];
    if (patch?.styles) Object.assign(base, patch.styles);
  }
  const override = instance.overrides[nodeId];
  if (override?.styles) Object.assign(base, override.styles);
  const composed: StyleSheet = { ...node.styles, base };
  if (!isRoot) return composed;
  return mergeStyleSheets(composed, instance.styles);
}

function mergeStyleSheets(base: StyleSheet, override: StyleSheet): StyleSheet {
  const breakpoints = { ...base.breakpoints };
  for (const [key, layer] of Object.entries(override.breakpoints ?? {})) {
    breakpoints[key] = { ...breakpoints[key], ...layer };
  }
  const states = { ...base.states };
  for (const [key, layer] of Object.entries(override.states ?? {})) {
    if (layer)
      states[key as keyof typeof states] = { ...states[key as keyof typeof states], ...layer };
  }
  return {
    base: { ...base.base, ...override.base },
    ...(Object.keys(breakpoints).length > 0 ? { breakpoints } : {}),
    ...(Object.keys(states).length > 0 ? { states } : {}),
  };
}

function variantVisible(
  component: ComponentDef,
  instance: InstanceNode,
  nodeId: NodeId,
): boolean | undefined {
  let visible: boolean | undefined;
  for (const key of matchingVariantKeys(instance.variant, component.variantProps)) {
    const patch = component.variants[key]?.[nodeId];
    if (patch?.visible !== undefined) visible = patch.visible;
  }
  return visible;
}
