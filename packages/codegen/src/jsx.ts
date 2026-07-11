import {
  type Display,
  type FlexDirection,
  type PitoletDocument,
  type PitoletNode,
  type NodeId,
  type TextSpan,
} from '@pitolet/schema';
import { twMerge } from 'tailwind-merge';
import { styleDeclToClasses } from './classes.js';
import { TokenMaps } from './tokenMaps.js';

export interface JsxOptions {
  /** Stamp data-node-id attributes (fidelity harness / round-trip). */
  debugIds?: boolean;
  /**
   * Repo-linking mode: stamp `data-ptl-id` attributes so exported code stays
   * traceable back to design nodes (drift checks, agent round-trips).
   */
  annotate?: boolean;
}

/**
 * Node subtree → JSX string (the body of a component). Deterministic,
 * hand-formatted with 2-space indentation — same input, byte-identical
 * output.
 */
export function nodeToJsx(
  doc: PitoletDocument,
  nodeId: NodeId,
  options: JsxOptions = {},
): string {
  const maps = new TokenMaps(doc.tokens);
  return renderNode(doc, nodeId, maps, 0, {}, options) ?? '';
}

interface ParentCtx {
  parentDisplay?: Display;
  parentDirection?: FlexDirection;
}

function renderNode(
  doc: PitoletDocument,
  nodeId: NodeId,
  maps: TokenMaps,
  depth: number,
  parent: ParentCtx,
  options: JsxOptions,
): string | null {
  const node = doc.nodes[nodeId];
  if (!node || !node.visible) return null;

  const pad = '  '.repeat(depth);
  const ctx = {
    maps,
    parentDisplay: parent.parentDisplay,
    parentDirection: parent.parentDirection,
  };
  const all = [...styleDeclToClasses(node.styles.base, ctx)];
  const overrideCtx = { ...ctx, isOverrideLayer: true };
  // Mobile-first breakpoint overrides → responsive prefixes (sm:, md:, …).
  for (const bp of doc.breakpoints) {
    const layer = node.styles.breakpoints?.[bp.id];
    if (layer) all.push(...styleDeclToClasses(layer, overrideCtx).map((c) => `${bp.id}:${c}`));
  }
  // Interaction states → hover:/focus:/active: prefixes.
  for (const state of ['hover', 'focus', 'active'] as const) {
    const layer = node.styles.states?.[state];
    if (layer) all.push(...styleDeclToClasses(layer, overrideCtx).map((c) => `${state}:${c}`));
  }
  const classes = twMerge(all.join(' '));

  const attrs: string[] = [];
  if (classes) attrs.push(`className="${classes}"`);
  if (options.debugIds) attrs.push(`data-node-id="${node.id}"`);
  if (options.annotate) attrs.push(`data-ptl-id="${node.id}"`);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    attrs.push(`${jsxAttrName(key)}="${escapeAttr(value)}"`);
  }

  const tag = node.tag;
  const attrString = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';

  switch (node.type) {
    case 'text': {
      const content = spansToJsx(node.content);
      if (!content.includes('\n') && content.length + tag.length * 2 + pad.length < 70) {
        return `${pad}<${tag}${attrString}>${content}</${tag}>`;
      }
      return `${pad}<${tag}${attrString}>\n${pad}  ${content}\n${pad}</${tag}>`;
    }
    case 'image': {
      const src = 'url' in node.src ? node.src.url : `/assets/${node.src.asset}`;
      return `${pad}<img${attrString} src="${escapeAttr(src)}" alt="${escapeAttr(node.alt)}" />`;
    }
    case 'instance':
      // Component instances → call sites (full support lands with components).
      return renderInstance(doc, node, maps, depth, options);
    case 'frame':
    case 'element': {
      const childCtx: ParentCtx = {
        parentDisplay: resolveDisplay(node),
        parentDirection: resolveDirection(node),
      };
      const children = node.children
        .map((childId) => renderNode(doc, childId, maps, depth + 1, childCtx, options))
        .filter((c): c is string => c !== null);
      if (children.length === 0) return `${pad}<${tag}${attrString} />`;
      return `${pad}<${tag}${attrString}>\n${children.join('\n')}\n${pad}</${tag}>`;
    }
  }
}

function renderInstance(
  doc: PitoletDocument,
  node: Extract<PitoletNode, { type: 'instance' }>,
  maps: TokenMaps,
  depth: number,
  options: JsxOptions,
): string | null {
  const pad = '  '.repeat(depth);
  const component = doc.components[node.componentId];
  if (!component) return null;
  const name = componentName(component.name);
  const props = component.variantProps
    .filter((p) => node.variant[p.name] !== undefined && node.variant[p.name] !== p.default)
    .map((p) => ` ${p.name}="${escapeAttr(node.variant[p.name]!)}"`)
    .join('');

  // A content override on the component's label text node becomes children.
  const master = doc.nodes[component.rootId];
  const contentRoot =
    master && master.children.length === 1 ? master.children[0]! : component.rootId;
  const labelId = singleTextNodeId(doc, contentRoot);
  const contentOverride = labelId ? node.overrides[labelId]?.content : undefined;
  void maps;
  void options;
  if (contentOverride) {
    const label = escapeJsxText(contentOverride.map((s) => s.text).join(''));
    return `${pad}<${name}${props}>${label}</${name}>`;
  }
  return `${pad}<${name}${props} />`;
}

function singleTextNodeId(doc: PitoletDocument, rootId: NodeId): NodeId | null {
  const ids: NodeId[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.type === 'text') ids.push(id);
    stack.push(...node.children);
  }
  return ids.length === 1 ? ids[0]! : null;
}

export function componentName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const pascal = cleaned
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[A-Za-z]/.test(pascal) ? pascal : `Component${pascal}`;
}

function spansToJsx(spans: TextSpan[]): string {
  return spans
    .map((span) => {
      let text = escapeJsxText(span.text);
      if (span.marks?.link !== undefined) {
        text = `<a href="${escapeAttr(span.marks.link)}">${text}</a>`;
      }
      if (span.marks?.italic) text = `<em>${text}</em>`;
      if (span.marks?.bold) text = `<strong>${text}</strong>`;
      return text;
    })
    .join('');
}

function resolveDisplay(node: PitoletNode): Display | undefined {
  return node.styles.base.display;
}

function resolveDirection(node: PitoletNode): FlexDirection | undefined {
  return node.styles.base.flexDirection;
}

function jsxAttrName(key: string): string {
  if (key === 'class') return 'className';
  if (key === 'for') return 'htmlFor';
  return key;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}
