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
import {
  booleanAttributeEnabled,
  allocateIdentifierNames,
  breakpointVariantNames,
  safeAttributes,
  safeImageUrl,
  safeNavigationUrl,
  safeTag,
} from './safety.js';

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
export function nodeToJsx(doc: PitoletDocument, nodeId: NodeId, options: JsxOptions = {}): string {
  const maps = new TokenMaps(doc.tokens);
  return (
    renderNode(doc, nodeId, maps, 0, {}, options, breakpointVariantNames(doc.breakpoints)) ?? ''
  );
}

interface ParentCtx {
  parentDisplay?: Display;
  parentDirection?: FlexDirection;
  breakpoints?: Record<
    string,
    {
      parentDisplay?: Display;
      parentDirection?: FlexDirection;
    }
  >;
}

function renderNode(
  doc: PitoletDocument,
  nodeId: NodeId,
  maps: TokenMaps,
  depth: number,
  parent: ParentCtx,
  options: JsxOptions,
  breakpointNames: Map<string, string>,
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
  let effectiveDecl = { ...node.styles.base };
  let previousParent: {
    parentDisplay?: Display;
    parentDirection?: FlexDirection;
  } = {
    parentDisplay: parent.parentDisplay,
    parentDirection: parent.parentDirection,
  };
  // Mobile-first breakpoint overrides → responsive prefixes (sm:, md:, …).
  for (const bp of doc.breakpoints) {
    const layer = node.styles.breakpoints?.[bp.id];
    if (layer) effectiveDecl = { ...effectiveDecl, ...layer };
    const currentParent = parent.breakpoints?.[bp.id] ?? previousParent;
    const parentChanged =
      currentParent.parentDisplay !== previousParent.parentDisplay ||
      currentParent.parentDirection !== previousParent.parentDirection;
    if (!layer && !parentChanged) {
      previousParent = currentParent;
      continue;
    }
    const responsiveCtx = {
      maps,
      ...currentParent,
      previousParentDisplay: previousParent.parentDisplay,
      previousParentDirection: previousParent.parentDirection,
      isOverrideLayer: true,
    };
    all.push(
      ...styleDeclToClasses(effectiveDecl, responsiveCtx).map(
        (className) => `${breakpointNames.get(bp.id)}:${className}`,
      ),
    );
    previousParent = currentParent;
  }
  // Interaction states → hover:/focus:/active: prefixes.
  for (const state of ['hover', 'focus', 'active'] as const) {
    const layer = node.styles.states?.[state];
    if (layer) {
      const stateDecl = { ...node.styles.base, ...layer };
      all.push(
        ...styleDeclToClasses(stateDecl, { ...ctx, isOverrideLayer: true }).map(
          (className) => `${state}:${className}`,
        ),
      );
    }
  }
  const classes = twMerge(all.join(' '));

  const attrs: string[] = [];
  if (classes) attrs.push(`className="${escapeAttr(classes)}"`);
  if (options.debugIds) attrs.push(`data-node-id="${escapeAttr(node.id)}"`);
  if (options.annotate) attrs.push(`data-ptl-id="${escapeAttr(node.id)}"`);
  for (const [key, value] of safeAttributes(node.attrs)) {
    if (node.type === 'image' && key === 'alt') continue;
    if (BOOLEAN_ATTRS.has(key)) {
      if (booleanAttributeEnabled(value)) attrs.push(jsxAttrName(key));
    } else attrs.push(`${jsxAttrName(key)}="${escapeAttr(value)}"`);
  }

  const tag = safeTag(node.tag, node.type === 'text' ? 'span' : 'div');
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
      const source =
        'url' in node.src
          ? `"${escapeAttr(safeImageUrl(node.src.url))}"`
          : `{new URL(${JSON.stringify(`../assets/${node.src.asset}`)}, import.meta.url).href}`;
      return `${pad}<img${attrString} src=${source} alt="${escapeAttr(node.alt)}" />`;
    }
    case 'instance':
      return renderInstance(doc, node, maps, depth, parent, options, breakpointNames);
    case 'frame':
    case 'element': {
      if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrString} />`;
      const childCtx: ParentCtx = {
        parentDisplay: resolveDisplay(node),
        parentDirection: resolveDirection(node),
        breakpoints: childBreakpointContexts(node, doc),
      };
      const children = node.children
        .map((childId) =>
          renderNode(doc, childId, maps, depth + 1, childCtx, options, breakpointNames),
        )
        .filter((c): c is string => c !== null);
      if (children.length === 0) return `${pad}<${tag}${attrString} />`;
      return `${pad}<${tag}${attrString}>\n${children.join('\n')}\n${pad}</${tag}>`;
    }
  }
}

const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'selected']);

function renderInstance(
  doc: PitoletDocument,
  node: Extract<PitoletNode, { type: 'instance' }>,
  maps: TokenMaps,
  depth: number,
  parent: ParentCtx,
  options: JsxOptions,
  breakpointNames: Map<string, string>,
): string | null {
  const pad = '  '.repeat(depth);
  const component = doc.components[node.componentId];
  if (!component) return null;
  const name = componentNameForId(doc, component.id);
  const propNames = variantPropNames(component.variantProps.map((prop) => prop.name));
  const props = component.variantProps
    .filter((p) => node.variant[p.name] !== undefined && node.variant[p.name] !== p.default)
    .map((p) => ` ${propNames.get(p.name)}="${escapeAttr(node.variant[p.name]!)}"`)
    .join('');

  const instanceClasses = nodeClasses(doc, node, maps, parent, breakpointNames);
  const classProp = instanceClasses ? ` className=${JSON.stringify(instanceClasses)}` : '';

  // A content override on the component's label text node becomes children.
  const labelId = singleTextNodeId(doc, component.contentRootId);
  const contentOverride = labelId ? node.overrides[labelId]?.content : undefined;
  const overrideEntries = Object.entries(node.overrides)
    .map(([id, override]) => {
      const fields: string[] = [];
      if (override.content && id !== labelId) {
        fields.push(
          `content: ${JSON.stringify(override.content.map((span) => span.text).join(''))}`,
        );
      }
      if (override.src) {
        const source =
          'url' in override.src
            ? safeImageUrl(override.src.url)
            : `new URL(${JSON.stringify(`../assets/${override.src.asset}`)}, import.meta.url).href`;
        fields.push(`src: ${'url' in override.src ? JSON.stringify(source) : source}`);
      }
      if (override.styles) {
        const classes = twMerge(styleDeclToClasses(override.styles, { maps }).join(' '));
        if (classes) fields.push(`className: ${JSON.stringify(classes)}`);
      }
      if (override.visible !== undefined) fields.push(`visible: ${override.visible}`);
      return fields.length > 0 ? `${JSON.stringify(id)}: { ${fields.join(', ')} }` : null;
    })
    .filter((entry): entry is string => entry !== null);
  const overridesProp =
    overrideEntries.length > 0 ? ` overrides={{ ${overrideEntries.join(', ')} }}` : '';
  void options;
  if (contentOverride) {
    const label = escapeJsxText(contentOverride.map((s) => s.text).join(''));
    return `${pad}<${name}${props}${classProp}${overridesProp}>${label}</${name}>`;
  }
  return `${pad}<${name}${props}${classProp}${overridesProp} />`;
}

function nodeClasses(
  doc: PitoletDocument,
  node: PitoletNode,
  maps: TokenMaps,
  parent: ParentCtx,
  breakpointNames: Map<string, string>,
): string {
  const context = {
    maps,
    parentDisplay: parent.parentDisplay,
    parentDirection: parent.parentDirection,
  };
  const all = [...styleDeclToClasses(node.styles.base, context)];
  let effectiveDecl = { ...node.styles.base };
  let previousParent: {
    parentDisplay?: Display;
    parentDirection?: FlexDirection;
  } = {
    parentDisplay: parent.parentDisplay,
    parentDirection: parent.parentDirection,
  };
  for (const breakpoint of doc.breakpoints) {
    const layer = node.styles.breakpoints?.[breakpoint.id];
    if (layer) effectiveDecl = { ...effectiveDecl, ...layer };
    const currentParent = parent.breakpoints?.[breakpoint.id] ?? previousParent;
    const parentChanged =
      currentParent.parentDisplay !== previousParent.parentDisplay ||
      currentParent.parentDirection !== previousParent.parentDirection;
    if (!layer && !parentChanged) {
      previousParent = currentParent;
      continue;
    }
    const overrideContext = {
      maps,
      ...currentParent,
      previousParentDisplay: previousParent.parentDisplay,
      previousParentDirection: previousParent.parentDirection,
      isOverrideLayer: true,
    };
    all.push(
      ...styleDeclToClasses(effectiveDecl, overrideContext).map(
        (name) => `${breakpointNames.get(breakpoint.id)}:${name}`,
      ),
    );
    previousParent = currentParent;
  }
  for (const state of ['hover', 'focus', 'active'] as const) {
    const layer = node.styles.states?.[state];
    if (layer)
      all.push(
        ...styleDeclToClasses(
          { ...node.styles.base, ...layer },
          { ...context, isOverrideLayer: true },
        ).map((name) => `${state}:${name}`),
      );
  }
  return twMerge(all.join(' '));
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

export function componentNames(doc: PitoletDocument): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const id of Object.keys(doc.components).sort()) {
    const base = componentName(doc.components[id]!.name) || 'Component';
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}${suffix++}`;
    used.add(name);
    result.set(id, name);
  }
  return result;
}

export function componentNameForId(doc: PitoletDocument, id: string): string {
  return componentNames(doc).get(id) ?? 'Component';
}

export function variantPropNames(names: string[]): Map<string, string> {
  return allocateIdentifierNames(names, 'variant', [
    'className',
    'children',
    'overrides',
    'variantKey',
  ]);
}

function spansToJsx(spans: TextSpan[]): string {
  return spans
    .map((span) => {
      let text = escapeJsxText(span.text);
      if (span.marks?.link !== undefined && safeNavigationUrl(span.marks.link)) {
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

function childBreakpointContexts(
  node: PitoletNode,
  doc: PitoletDocument,
): NonNullable<ParentCtx['breakpoints']> {
  const contexts: NonNullable<ParentCtx['breakpoints']> = {};
  let effective = { ...node.styles.base };
  for (const breakpoint of doc.breakpoints) {
    const layer = node.styles.breakpoints?.[breakpoint.id];
    if (layer) effective = { ...effective, ...layer };
    contexts[breakpoint.id] = {
      parentDisplay: effective.display,
      parentDirection: effective.flexDirection,
    };
  }
  return contexts;
}

function jsxAttrName(key: string): string {
  if (key === 'class') return 'className';
  if (key === 'for') return 'htmlFor';
  if (key === 'colspan') return 'colSpan';
  if (key === 'rowspan') return 'rowSpan';
  if (key === 'autocomplete') return 'autoComplete';
  if (key === 'inputmode') return 'inputMode';
  return key;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

const VOID_TAGS = new Set(['input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr']);
