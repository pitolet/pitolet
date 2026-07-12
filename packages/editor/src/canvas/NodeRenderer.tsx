import {
  resolveStyles,
  styleToCssProps,
  type Breakpoint,
  type Display,
  type FlexDirection,
  type PitoletNode,
  type NodeId,
  type StyleDecl,
  type TextSpan,
  type TokenSet,
} from '@pitolet/schema';
import { createElement, memo, type CSSProperties, type ReactNode } from 'react';
import { useEditor } from '../store/index.js';
import { assetUrl } from '../sync/serverBase.js';
import { InstanceRenderer } from './InstanceRenderer.js';
import { TextEditable } from './TextEditable.js';

export interface RenderContext {
  frameWidth: number;
  breakpoints: Breakpoint[];
  tokens: TokenSet;
  parentDisplay?: Display;
  parentDirection?: FlexDirection;
  /** Set while rendering inside a component master frame. */
  masterComponentId?: string;
}

/**
 * Renders one document node as REAL DOM — the exact element tag with the
 * exact CSS the code generator will emit. Subscribes only to its own node:
 * a patch to one node re-renders one component.
 */
export const NodeRenderer = memo(function NodeRenderer({
  id,
  ctx,
}: {
  id: NodeId;
  ctx: RenderContext;
}) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  const isEditingText = useEditor((s) => s.editingTextId === id);
  // While a variant is being edited, master content previews its patch.
  const variantPatch = useEditor((s) =>
    ctx.masterComponentId && s.editingVariant
      ? s.doc?.components[ctx.masterComponentId]?.variants[s.editingVariant]?.[id]
      : undefined,
  );
  // While an interaction state is being edited, selected nodes preview it.
  const previewState = useEditor((s) =>
    s.editingContext.state && s.selection.includes(id) ? s.editingContext.state : null,
  );
  if (!node || !node.visible || variantPatch?.visible === false) return null;

  const styles = variantPatch?.styles
    ? { ...node.styles, base: { ...node.styles.base, ...variantPatch.styles } }
    : node.styles;
  const resolved = resolveStyles(styles, {
    frameWidth: ctx.frameWidth,
    breakpoints: ctx.breakpoints,
    tokens: ctx.tokens,
    activeStates: previewState ? [previewState] : undefined,
  });
  const css = styleToCssProps(resolved, {
    parentDisplay: ctx.parentDisplay,
    parentDirection: ctx.parentDirection,
  }) as CSSProperties;

  const common = {
    'data-node-id': id,
    style: css,
    ...sanitizeAttrs(node.attrs),
  };

  switch (node.type) {
    case 'text':
      if (isEditingText) return <TextEditable node={node} css={css} />;
      return createElement(safeTag(node.tag), common, renderSpans(node.content));
    case 'image': {
      const src = 'url' in node.src ? node.src.url : assetUrl(node.src.asset);
      return createElement('img', {
        ...common,
        src: src || TRANSPARENT_PIXEL,
        alt: node.alt,
        draggable: false,
      });
    }
    case 'instance':
      return <InstanceRenderer instance={node} ctx={ctx} />;
    case 'frame':
    case 'element':
      return createElement(
        safeTag(node.tag),
        common,
        node.children.length > 0
          ? node.children.map((childId) => (
              <NodeRenderer
                key={childId}
                id={childId}
                ctx={{
                  ...ctx,
                  parentDisplay: resolved.display,
                  parentDirection: resolved.flexDirection,
                }}
              />
            ))
          : undefined,
      );
  }
});

export function renderSpans(content: TextSpan[]): ReactNode {
  return content.map((span, i) => {
    let node: ReactNode = span.text;
    if (span.marks?.bold) node = <strong key={i}>{node}</strong>;
    if (span.marks?.italic) node = <em key={i}>{node}</em>;
    if (span.marks?.link !== undefined)
      node = (
        <a key={i} href={span.marks.link} onClick={(e) => e.preventDefault()}>
          {node}
        </a>
      );
    if (typeof node === 'string') return <span key={i}>{node}</span>;
    return node;
  });
}

const ALLOWED_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'main', 'nav', 'aside', 'article', 'figure',
  'figcaption', 'form', 'ul', 'ol', 'li', 'button', 'a', 'label', 'span', 'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'strong', 'em', 'img', 'input',
  'textarea', 'select', 'option', 'fieldset', 'legend', 'table', 'caption', 'thead',
  'tbody', 'tfoot', 'tr', 'td', 'th', 'details', 'summary',
  'br', 'hr',
]);

function safeTag(tag: string): string {
  return ALLOWED_TAGS.has(tag) ? tag : 'div';
}

/** Only carry through inert attributes; navigation/interactivity stays dead in-editor. */
function sanitizeAttrs(attrs?: Record<string, string>): Record<string, string | boolean> {
  if (!attrs) return {};
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'href') continue; // links stay inert on canvas
    if (key.startsWith('on')) continue;
    const reactKey = REACT_ATTRS[key] ?? key;
    out[reactKey] = ['checked', 'disabled', 'selected'].includes(key) ? true : value;
  }
  return out;
}

const REACT_ATTRS: Record<string, string> = {
  for: 'htmlFor',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  autocomplete: 'autoComplete',
  inputmode: 'inputMode',
};

const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Resolved style of a node — shared helper for layout-aware interactions. */
export function useResolvedStyle(id: NodeId, ctx: RenderContext): StyleDecl | null {
  const node = useEditor((s) => s.doc?.nodes[id] as PitoletNode | undefined);
  if (!node) return null;
  return resolveStyles(node.styles, {
    frameWidth: ctx.frameWidth,
    breakpoints: ctx.breakpoints,
    tokens: ctx.tokens,
  });
}
