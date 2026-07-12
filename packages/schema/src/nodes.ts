import type { StyleDecl, StyleSheet } from './styles.js';

export type NodeId = string;
export type ComponentId = string;
export type AssetId = string;

export type NodeType = 'frame' | 'element' | 'text' | 'image' | 'instance';

/** Semantic HTML tags a node may render as (drives codegen output & a11y). */
export const CONTAINER_TAGS = [
  'div',
  'section',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'article',
  'figure',
  'form',
  'ul',
  'ol',
  'li',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'fieldset',
  'legend',
  'a',
  'label',
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
] as const;

export const TEXT_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'blockquote',
  'figcaption',
  'code',
  'a',
  'button',
  'label',
  'option',
  'td',
  'th',
] as const;

interface NodeBase {
  id: NodeId;
  type: NodeType;
  name: string;
  /** null ⇔ top-level canvas frame (or a component master root). */
  parent: NodeId | null;
  /** Ordered child ids; always [] for text/image leaves. */
  children: NodeId[];
  /** Semantic HTML tag this node renders as. */
  tag: string;
  visible: boolean;
  locked: boolean;
  styles: StyleSheet;
  /** Extra HTML attributes carried into codegen (href, alt, aria-*, placeholder…). */
  attrs?: Record<string, string>;
}

/** An artboard on the canvas. The only node kind with canvas coordinates. */
export interface FrameNode extends NodeBase {
  type: 'frame';
  canvas: { x: number; y: number; width: number; height: number | 'auto' };
  /** Set when this frame is the master of a component. */
  isComponentMaster?: ComponentId;
}

/** Generic container/box (div, section, button, a, …). */
export interface ElementNode extends NodeBase {
  type: 'element';
}

export interface TextSpan {
  text: string;
  marks?: { bold?: true; italic?: true; link?: string };
}

export interface TextNode extends NodeBase {
  type: 'text';
  content: TextSpan[];
}

export type ImageSrc = { asset: AssetId } | { url: string };

export interface ImageNode extends NodeBase {
  type: 'image';
  src: ImageSrc;
  alt: string;
}

export interface InstanceOverride {
  content?: TextSpan[];
  src?: ImageSrc;
  styles?: Partial<StyleDecl>;
  visible?: boolean;
}

export interface InstanceNode extends NodeBase {
  type: 'instance';
  componentId: ComponentId;
  /** Selected variant value per variant prop, e.g. { intent: 'ghost' }. */
  variant: Record<string, string>;
  /** Keyed by node id in the master subtree. */
  overrides: Record<NodeId, InstanceOverride>;
}

export type PitoletNode = FrameNode | ElementNode | TextNode | ImageNode | InstanceNode;

export function isFrame(node: PitoletNode): node is FrameNode {
  return node.type === 'frame';
}

/** Top-level = renders at canvas coordinates (root frames). */
export function isTopLevel(node: PitoletNode): node is FrameNode {
  return node.type === 'frame' && node.parent === null;
}
