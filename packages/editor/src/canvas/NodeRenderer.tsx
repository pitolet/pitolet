import {
  parseVariantKey,
  resolveVariantPatch,
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
import { isVoidElementTag } from '../store/nodeSafety.js';
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
  const editingVariant = useEditor((s) => s.editingVariant);
  const masterComponent = useEditor((s) =>
    ctx.masterComponentId ? s.doc?.components[ctx.masterComponentId] : undefined,
  );
  const editingVariantKey =
    editingVariant && editingVariant.componentId === ctx.masterComponentId
      ? editingVariant.key
      : null;
  const editingValues = editingVariantKey ? parseVariantKey(editingVariantKey) : null;
  const variantPatch =
    masterComponent && editingValues
      ? resolveVariantPatch(masterComponent, editingValues, id)
      : undefined;
  // While an interaction state is being edited, selected nodes preview it.
  const previewState = useEditor((s) =>
    s.editingContext.state && s.selection.includes(id) ? s.editingContext.state : null,
  );
  if (!node || !(variantPatch?.visible ?? node.visible)) return null;

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
    tabIndex: isCanvasFocusableTag(node.tag) ? -1 : undefined,
    draggable: false,
    ...sanitizeAttrs(node.attrs),
  };

  switch (node.type) {
    case 'text':
      if (isEditingText) return <TextEditable node={node} css={css} />;
      return createElement(safeTextTag(node.tag), common, renderSpans(node.content));
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
    case 'element': {
      const tag = safeTag(node.tag);
      return createElement(
        tag,
        common,
        !isVoidElementTag(tag) && node.children.length > 0
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
  }
});

export function renderSpans(content: TextSpan[]): ReactNode {
  return content.map((span, i) => {
    let node: ReactNode = span.text;
    if (span.marks?.bold) node = <strong key={i}>{node}</strong>;
    if (span.marks?.italic) node = <em key={i}>{node}</em>;
    if (span.marks?.link !== undefined)
      node = (
        <a
          key={i}
          href={span.marks.link}
          tabIndex={-1}
          draggable={false}
          onClick={(e) => e.preventDefault()}
          onAuxClick={(e) => e.preventDefault()}
        >
          {node}
        </a>
      );
    if (typeof node === 'string') return <span key={i}>{node}</span>;
    return node;
  });
}

const ALLOWED_TAGS = new Set([
  'div',
  'section',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'article',
  'figure',
  'figcaption',
  'form',
  'ul',
  'ol',
  'li',
  'button',
  'a',
  'label',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'code',
  'strong',
  'em',
  'img',
  'input',
  'textarea',
  'select',
  'option',
  'fieldset',
  'legend',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'details',
  'summary',
  'br',
  'hr',
]);

export function safeTag(tag: string): string {
  const normalized = tag.toLowerCase();
  return ALLOWED_TAGS.has(normalized) ? normalized : 'div';
}

/** Text nodes must always render through an element that accepts children. */
export function safeTextTag(tag: string): string {
  const safe = safeTag(tag);
  return isVoidElementTag(safe) ? 'span' : safe;
}

/** Only carry through inert attributes; navigation/interactivity stays dead in-editor. */
export function sanitizeAttrs(attrs?: Record<string, string>): Record<string, string | boolean> {
  if (!attrs) return {};
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith('on') || BLOCKED_CANVAS_ATTRS.has(normalized)) continue;
    if (normalized === 'data-node-id') continue;
    const reactKey = REACT_ATTRS[normalized] ?? key;
    out[reactKey] = BOOLEAN_ATTRS.has(normalized) ? value !== 'false' && value !== '0' : value;
  }
  return out;
}

const REACT_ATTRS: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  autocomplete: 'autoComplete',
  inputmode: 'inputMode',
  readonly: 'readOnly',
};

const BOOLEAN_ATTRS = new Set([
  'checked',
  'disabled',
  'multiple',
  'readonly',
  'required',
  'selected',
]);

const BLOCKED_CANVAS_ATTRS = new Set([
  'action',
  'accesskey',
  'autofocus',
  'children',
  'contenteditable',
  'dangerouslysetinnerhtml',
  'defaultchecked',
  'defaultvalue',
  'download',
  'draggable',
  'formaction',
  'form',
  'href',
  'id',
  'key',
  'method',
  'name',
  'popover',
  'popovertarget',
  'popovertargetaction',
  'ref',
  'src',
  'style',
  'suppresscontenteditablewarning',
  'suppresshydrationwarning',
  'tabindex',
  'target',
  'for',
]);

function isCanvasFocusableTag(tag: string): boolean {
  return ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag.toLowerCase());
}

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
