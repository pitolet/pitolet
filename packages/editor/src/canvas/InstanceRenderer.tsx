import {
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
import { assetUrl } from '../sync/serverBase.js';
import { renderSpans, type RenderContext } from './NodeRenderer.js';

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
  const master = useEditor((s) =>
    component ? s.doc?.nodes[component.rootId] : undefined,
  );
  if (!component || !master) return null;

  // Instances render the master's CONTENT: its single child when the master
  // frame is just a wrapper, else the frame body itself.
  const contentRootId = master.children.length === 1 ? master.children[0]! : component.rootId;

  return (
    <MasterNode
      nodeId={contentRootId}
      instance={instance}
      component={component}
      ctx={ctx}
      isRoot
    />
  );
});

function MasterNode({
  nodeId,
  instance,
  component,
  ctx,
  isRoot = false,
}: {
  nodeId: NodeId;
  instance: InstanceNode;
  component: ComponentDef;
  ctx: RenderContext;
  isRoot?: boolean;
}) {
  const node = useEditor((s) => s.doc?.nodes[nodeId]);
  if (!node) return null;

  const override = instance.overrides[nodeId];
  const visible = override?.visible ?? variantVisible(component, instance, nodeId) ?? node.visible;
  if (!visible) return null;

  const styles = composeStyles(node, component, instance, nodeId);
  const resolved = resolveStyles(styles, {
    frameWidth: ctx.frameWidth,
    breakpoints: ctx.breakpoints,
    tokens: ctx.tokens,
  });
  const css = styleToCssProps(resolved, {
    parentDisplay: ctx.parentDisplay,
    parentDirection: ctx.parentDirection,
  }) as CSSProperties;

  // The whole subtree hit-tests as the instance.
  const common = { 'data-node-id': isRoot ? instance.id : undefined, style: css };

  switch (node.type) {
    case 'text': {
      const content = override?.content ?? node.content;
      return createElement(node.tag, common, renderSpans(content));
    }
    case 'image': {
      const src = override?.src ?? node.src;
      const url = 'url' in src ? src.url : assetUrl(src.asset);
      return createElement('img', { ...common, src: url, alt: node.alt, draggable: false });
    }
    case 'instance':
      return null; // no nested instances in v1
    default:
      return createElement(
        node.tag,
        common,
        node.children.map((childId) => (
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
          />
        )),
      );
  }
}

function composeStyles(
  node: PitoletNode,
  component: ComponentDef,
  instance: InstanceNode,
  nodeId: NodeId,
): StyleSheet {
  const base = { ...node.styles.base };
  for (const key of matchingVariantKeys(instance.variant, component.variantProps)) {
    const patch = component.variants[key]?.[nodeId];
    if (patch?.styles) Object.assign(base, patch.styles);
  }
  const override = instance.overrides[nodeId];
  if (override?.styles) Object.assign(base, override.styles);
  return { ...node.styles, base };
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
