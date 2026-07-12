import {
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

/**
 * Secondary target: semantic HTML + a plain stylesheet. Styles come from the
 * SAME styleToCssProps the editor canvas renders with — this target is
 * pixel-identical to the canvas by construction.
 */
export function nodeToHtml(
  doc: PitoletDocument,
  nodeId: NodeId,
): { html: string; css: string } {
  const cssRules: string[] = [];
  const classCounter = new Map<string, number>();

  const html = render(nodeId, 0, {});
  return { html: html ?? '', css: cssRules.join('\n\n') };

  function render(
    id: NodeId,
    depth: number,
    parent: { display?: Display; direction?: FlexDirection },
    /** Set while flattening a component instance's master subtree. */
    flatten?: { instance: InstanceNode },
  ): string | null {
    const node = doc.nodes[id];
    if (!node) return null;

    // Component instances flatten: render the master content with variant
    // patches and per-node overrides baked in.
    if (node.type === 'instance') {
      const component = doc.components[node.componentId];
      const master = component ? doc.nodes[component.rootId] : undefined;
      if (!component || !master) return null;
      const contentRoot =
        master.children.length === 1 ? master.children[0]! : component.rootId;
      return render(contentRoot, depth, parent, { instance: node });
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
    let baseDecl = node.styles.base;
    if (flatten) {
      const component = doc.components[flatten.instance.componentId]!;
      baseDecl = { ...baseDecl };
      for (const key of matchingVariantKeys(flatten.instance.variant, component.variantProps)) {
        const patch = component.variants[key]?.[id]?.styles;
        if (patch) Object.assign(baseDecl, patch);
      }
      if (override?.styles) Object.assign(baseDecl, override.styles);
    }
    const resolved = resolveTokenRefs(baseDecl, doc.tokens) as StyleDecl;
    const css = styleToCssProps(resolved, {
      parentDisplay: parent.display,
      parentDirection: parent.direction,
    });

    const className = uniqueClassName(node.name);
    const declarations = Object.entries(css)
      .map(([prop, value]) => `  ${kebab(prop)}: ${value};`)
      .join('\n');
    if (declarations) cssRules.push(`.${className} {\n${declarations}\n}`);

    // Breakpoint overrides → real media queries (mobile-first).
    for (const bp of doc.breakpoints) {
      const layer = node.styles.breakpoints?.[bp.id];
      if (!layer) continue;
      const layerCss = styleToCssProps(
        resolveTokenRefs(layer, doc.tokens) as StyleDecl,
        { parentDisplay: parent.display, parentDirection: parent.direction },
      );
      const decls = Object.entries(layerCss)
        .map(([prop, value]) => `    ${kebab(prop)}: ${value};`)
        .join('\n');
      if (decls) {
        cssRules.push(
          `@media (min-width: ${bp.minWidth}px) {\n  .${className} {\n${decls}\n  }\n}`,
        );
      }
    }

    // Interaction states → real pseudo-class rules.
    for (const state of ['hover', 'focus', 'active'] as const) {
      const layer = node.styles.states?.[state];
      if (!layer) continue;
      const layerCss = styleToCssProps(
        resolveTokenRefs(layer, doc.tokens) as StyleDecl,
        { parentDisplay: parent.display, parentDirection: parent.direction },
      );
      const decls = Object.entries(layerCss)
        .map(([prop, value]) => `  ${kebab(prop)}: ${value};`)
        .join('\n');
      if (decls) cssRules.push(`.${className}:${state} {\n${decls}\n}`);
    }

    const attrs = [`class="${className}"`];
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      if (BOOLEAN_ATTRS.has(key)) attrs.push(key);
      else attrs.push(`${key}="${escapeHtml(value)}"`);
    }
    const attrString = ` ${attrs.join(' ')}`;

    switch (node.type) {
      case 'text': {
        const content = override?.content ?? node.content;
        return `${pad}<${node.tag}${attrString}>${spansToHtml(content)}</${node.tag}>`;
      }
      case 'image': {
        const src = override?.src ?? node.src;
        const url = 'url' in src ? src.url : `assets/${src.asset}`;
        return `${pad}<img${attrString} src="${escapeHtml(url)}" alt="${escapeHtml(node.alt)}">`;
      }
      case 'frame':
      case 'element': {
        const children = node.children
          .map((childId) =>
            render(
              childId,
              depth + 1,
              { display: resolved.display, direction: resolved.flexDirection },
              flatten,
            ),
          )
          .filter((c): c is string => c !== null);
        if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrString}>`;
        if (children.length === 0) return `${pad}<${node.tag}${attrString}></${node.tag}>`;
        return `${pad}<${node.tag}${attrString}>\n${children.join('\n')}\n${pad}</${node.tag}>`;
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

const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'selected']);
const VOID_TAGS = new Set(['input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr']);

function spansToHtml(spans: TextSpan[]): string {
  return spans
    .map((span) => {
      let text = escapeHtml(span.text);
      if (span.marks?.link !== undefined) text = `<a href="${escapeHtml(span.marks.link)}">${text}</a>`;
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
