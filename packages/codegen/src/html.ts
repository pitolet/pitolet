import {
  componentContentBaseStyles,
  matchingVariantKeys,
  resolveTokenRefs,
  styleToCssProps,
  type Display,
  type FlexDirection,
  type PitoletDocument,
  type InstanceNode,
  type NodeId,
  type StyleDecl,
  type TextSpan,
} from '@pitolet/schema';
import {
  booleanAttributeEnabled,
  safeAttributes,
  safeCssValue,
  safeImageUrl,
  safeNavigationUrl,
  safeTag,
} from './safety.js';

/**
 * Secondary target: semantic HTML + a plain stylesheet. Styles come from the
 * SAME styleToCssProps the editor canvas renders with — this target is
 * pixel-identical to the canvas by construction.
 */
export function nodeToHtml(doc: PitoletDocument, nodeId: NodeId): { html: string; css: string } {
  const cssRules: string[] = [];
  const classCounter = new Map<string, number>();

  const html = render(nodeId, 0, {});
  return { html: html ?? '', css: cssRules.join('\n\n') };

  function render(
    id: NodeId,
    depth: number,
    parent: LayoutContext,
    /** Set while flattening a component instance's master subtree. */
    flatten?: { instance: InstanceNode; contentRootId: NodeId },
  ): string | null {
    const node = doc.nodes[id];
    if (!node) return null;

    // Component instances flatten: render the master content with variant
    // patches and per-node overrides baked in.
    if (node.type === 'instance') {
      if (!node.visible) return null;
      const component = doc.components[node.componentId];
      const master = component ? doc.nodes[component.rootId] : undefined;
      if (!component || !master) return null;
      return render(component.contentRootId, depth, parent, {
        instance: node,
        contentRootId: component.contentRootId,
      });
    }

    const override = flatten ? flatten.instance.overrides[id] : undefined;
    let visible = node.visible;
    if (flatten) {
      const component = doc.components[flatten.instance.componentId]!;
      for (const key of matchingVariantKeys(flatten.instance.variant, component.variantProps)) {
        const v = component.variants[key]?.[id]?.visible;
        if (v !== undefined) visible = v;
      }
      if (override?.visible !== undefined) visible = override.visible;
    }
    if (!visible) return null;
    const pad = '  '.repeat(depth);

    // Base rule = base layer only; breakpoint/state layers emit their own
    // media-query and pseudo-class rules below (mobile-first, no doubling).
    let baseDecl = flatten
      ? componentContentBaseStyles(doc.components[flatten.instance.componentId]!, node)
      : node.styles.base;
    if (flatten) {
      const component = doc.components[flatten.instance.componentId]!;
      baseDecl = { ...baseDecl };
      for (const key of matchingVariantKeys(flatten.instance.variant, component.variantProps)) {
        const patch = component.variants[key]?.[id]?.styles;
        if (patch) Object.assign(baseDecl, patch);
      }
      if (override?.styles) Object.assign(baseDecl, override.styles);
      if (id === flatten.contentRootId) Object.assign(baseDecl, flatten.instance.styles.base);
    }
    const resolved = resolveTokenRefs(baseDecl, doc.tokens) as StyleDecl;
    const baseParentContext = {
      parentDisplay: parent.display,
      parentDirection: parent.direction,
    };
    const css = styleToCssProps(resolved, baseParentContext);

    const className = uniqueClassName(node.name);
    const declarations = cssDeclarations(css, 2);
    if (declarations) cssRules.push(`.${className} {\n${declarations}\n}`);

    // Breakpoint overrides → real media queries (mobile-first). Convert the
    // full effective declaration at every width, then emit only its CSS delta.
    // Some schema values depend on surrounding context: flexDirection needs
    // the inherited base display, and fill sizing changes when a parent flips
    // from column to row. Converting a sparse layer by itself loses both.
    let effectiveDecl = baseDecl;
    let previousCss = css;
    const childBreakpointContexts: NonNullable<LayoutContext['breakpoints']> = {};
    for (const bp of doc.breakpoints) {
      const nodeLayer = node.styles.breakpoints?.[bp.id];
      const instanceLayer =
        flatten && id === flatten.contentRootId
          ? flatten.instance.styles.breakpoints?.[bp.id]
          : undefined;
      const layer = nodeLayer || instanceLayer ? { ...nodeLayer, ...instanceLayer } : undefined;
      if (layer) effectiveDecl = { ...effectiveDecl, ...layer };
      const effectiveResolved = resolveTokenRefs(effectiveDecl, doc.tokens) as StyleDecl;
      const parentContext = parent.breakpoints?.[bp.id] ?? baseParentContext;
      const effectiveCss = styleToCssProps(effectiveResolved, parentContext);
      const layerCss = cssDelta(previousCss, effectiveCss);
      const decls = cssDeclarations(layerCss, 4);
      if (decls) {
        cssRules.push(
          `@media (min-width: ${bp.minWidth}px) {\n  .${className} {\n${decls}\n  }\n}`,
        );
      }
      childBreakpointContexts[bp.id] = {
        parentDisplay: effectiveResolved.display,
        parentDirection: effectiveResolved.flexDirection,
      };
      previousCss = effectiveCss;
    }

    // Interaction states → real pseudo-class rules.
    for (const state of ['hover', 'focus', 'active'] as const) {
      const nodeLayer = node.styles.states?.[state];
      const instanceLayer =
        flatten && id === flatten.contentRootId
          ? flatten.instance.styles.states?.[state]
          : undefined;
      const layer = nodeLayer || instanceLayer ? { ...nodeLayer, ...instanceLayer } : undefined;
      if (!layer) continue;
      const stateDecl = { ...baseDecl, ...layer };
      const stateCss = styleToCssProps(resolveTokenRefs(stateDecl, doc.tokens) as StyleDecl, {
        parentDisplay: parent.display,
        parentDirection: parent.direction,
      });
      const decls = cssDeclarations(cssDelta(css, stateCss), 2);
      if (decls) cssRules.push(`.${className}:${state} {\n${decls}\n}`);
    }

    const attrs = [`class="${className}"`];
    for (const [key, value] of safeAttributes(node.attrs)) {
      if (node.type === 'image' && key === 'alt') continue;
      if (BOOLEAN_ATTRS.has(key)) {
        if (booleanAttributeEnabled(value)) attrs.push(key);
      } else attrs.push(`${key}="${escapeHtml(value)}"`);
    }
    const attrString = ` ${attrs.join(' ')}`;

    switch (node.type) {
      case 'text': {
        const content = override?.content ?? node.content;
        const tag = safeTag(node.tag, 'span');
        return `${pad}<${tag}${attrString}>${spansToHtml(content)}</${tag}>`;
      }
      case 'image': {
        const src = override?.src ?? node.src;
        const url = 'url' in src ? safeImageUrl(src.url) : `assets/${src.asset}`;
        return `${pad}<img${attrString} src="${escapeHtml(url)}" alt="${escapeHtml(node.alt)}">`;
      }
      case 'frame':
      case 'element': {
        const tag = safeTag(node.tag, 'div');
        const children = node.children
          .map((childId) =>
            render(
              childId,
              depth + 1,
              {
                display: resolved.display,
                direction: resolved.flexDirection,
                breakpoints: childBreakpointContexts,
              },
              flatten,
            ),
          )
          .filter((c): c is string => c !== null);
        if (VOID_TAGS.has(tag)) return `${pad}<${tag}${attrString}>`;
        if (children.length === 0) return `${pad}<${tag}${attrString}></${tag}>`;
        return `${pad}<${tag}${attrString}>\n${children.join('\n')}\n${pad}</${tag}>`;
      }
      default:
        return null;
    }
  }

  function uniqueClassName(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'node';
    const count = classCounter.get(base) ?? 0;
    classCounter.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }
}

interface LayoutContext {
  display?: Display;
  direction?: FlexDirection;
  breakpoints?: Record<
    string,
    {
      parentDisplay?: Display;
      parentDirection?: FlexDirection;
    }
  >;
}

function cssDelta(
  previous: Record<string, string | number>,
  current: Record<string, string | number>,
): Record<string, string | number> {
  const delta: Record<string, string | number> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (previous[key] === current[key]) continue;
    delta[key] = current[key] ?? 'unset';
  }
  return delta;
}

function cssDeclarations(css: Record<string, string | number>, indent: number): string {
  const padding = ' '.repeat(indent);
  return Object.entries(css)
    .map(([prop, value]) => [prop, safeCssValue(value)] as const)
    .filter((entry): entry is readonly [string, string | number] => entry[1] !== null)
    .map(([prop, value]) => `${padding}${kebab(prop)}: ${value};`)
    .join('\n');
}

const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'selected']);
const VOID_TAGS = new Set(['input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr']);

function spansToHtml(spans: TextSpan[]): string {
  return spans
    .map((span) => {
      let text = escapeHtml(span.text);
      if (span.marks?.link !== undefined && safeNavigationUrl(span.marks.link))
        text = `<a href="${escapeHtml(span.marks.link)}">${text}</a>`;
      if (span.marks?.italic) text = `<em>${text}</em>`;
      if (span.marks?.bold) text = `<strong>${text}</strong>`;
      return text;
    })
    .join('');
}

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
