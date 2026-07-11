import { nanoid } from 'nanoid';
import { oklch } from './color.js';
import { DEFAULT_BREAKPOINTS, SCHEMA_VERSION, type PitoletDocument } from './document.js';
import type {
  ElementNode,
  FrameNode,
  ImageNode,
  ImageSrc,
  InstanceNode,
  NodeId,
  TextNode,
  TextSpan,
} from './nodes.js';
import { emptyStyleSheet, px, rem, sides, type StyleDecl } from './styles.js';
import type { TokenSet } from './tokens.js';

export const newId = (): string => nanoid(10);

/**
 * Canonical node constructors. Everything that creates nodes — editor tools,
 * MCP insert_nodes expansion, sample documents, tests — goes through these,
 * so defaults are defined exactly once.
 */

export function createFrame(
  init: {
    name?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number | 'auto';
    styles?: StyleDecl;
  } = {},
): FrameNode {
  return {
    id: newId(),
    type: 'frame',
    name: init.name ?? 'Frame',
    parent: null,
    children: [],
    tag: 'div',
    visible: true,
    locked: false,
    canvas: {
      x: init.x ?? 0,
      y: init.y ?? 0,
      width: init.width ?? 1280,
      height: init.height ?? 800,
    },
    styles: {
      base: {
        display: 'flex',
        flexDirection: 'column',
        fills: [{ type: 'solid', color: { $token: 'color.background' } }],
        ...init.styles,
      },
    },
  };
}

export function createElement(
  init: { name?: string; tag?: string; styles?: StyleDecl } = {},
): ElementNode {
  return {
    id: newId(),
    type: 'element',
    name: init.name ?? 'Box',
    parent: null,
    children: [],
    tag: init.tag ?? 'div',
    visible: true,
    locked: false,
    styles: {
      base: {
        display: 'flex',
        flexDirection: 'column',
        ...init.styles,
      },
    },
  };
}

export function createText(
  init: { name?: string; tag?: string; text?: string; content?: TextSpan[]; styles?: StyleDecl } = {},
): TextNode {
  return {
    id: newId(),
    type: 'text',
    name: init.name ?? 'Text',
    parent: null,
    children: [],
    tag: init.tag ?? 'p',
    visible: true,
    locked: false,
    content: init.content ?? [{ text: init.text ?? 'Text' }],
    styles: { base: { ...init.styles } },
  };
}

export function createImage(
  init: { name?: string; src?: ImageSrc; alt?: string; styles?: StyleDecl } = {},
): ImageNode {
  return {
    id: newId(),
    type: 'image',
    name: init.name ?? 'Image',
    parent: null,
    children: [],
    tag: 'img',
    visible: true,
    locked: false,
    src: init.src ?? { url: '' },
    alt: init.alt ?? '',
    styles: {
      base: {
        width: px(320),
        height: px(240),
        objectFit: 'cover',
        ...init.styles,
      },
    },
  };
}

export function createInstance(init: {
  componentId: string;
  name?: string;
  variant?: Record<string, string>;
}): InstanceNode {
  return {
    id: newId(),
    type: 'instance',
    name: init.name ?? 'Instance',
    parent: null,
    children: [],
    tag: 'div',
    visible: true,
    locked: false,
    componentId: init.componentId,
    variant: init.variant ?? {},
    overrides: {},
    styles: emptyStyleSheet(),
  };
}

// ---------------------------------------------------------------------------
// Default document
// ---------------------------------------------------------------------------

/**
 * The starter token set for new documents. Deliberately mirrors the shape of
 * Pitolet's own UI token system — the tool is built with the same primitives
 * it exposes (dogfooding contract).
 */
export function defaultTokens(): TokenSet {
  return {
    color: {
      background: { $value: oklch(1, 0, 0), $description: 'Page background' },
      foreground: { $value: oklch(0.21, 0.02, 250), $description: 'Primary text' },
      muted: { $value: oklch(0.96, 0.005, 250), $description: 'Muted surface' },
      'muted-foreground': { $value: oklch(0.52, 0.02, 250), $description: 'Secondary text' },
      primary: { $value: oklch(0.55, 0.16, 235), $description: 'Brand / actions' },
      'primary-foreground': { $value: oklch(0.99, 0.003, 235), $description: 'Text on primary' },
      accent: { $value: oklch(0.72, 0.12, 195), $description: 'Accent highlights' },
      border: { $value: oklch(0.91, 0.008, 250), $description: 'Hairlines & borders' },
    },
    spacing: {
      '1': { $value: px(4) },
      '2': { $value: px(8) },
      '3': { $value: px(12) },
      '4': { $value: px(16) },
      '5': { $value: px(20) },
      '6': { $value: px(24) },
      '8': { $value: px(32) },
      '10': { $value: px(40) },
      '12': { $value: px(48) },
      '16': { $value: px(64) },
      '20': { $value: px(80) },
      '24': { $value: px(96) },
    },
    radius: {
      sm: { $value: px(4) },
      md: { $value: px(8) },
      lg: { $value: px(12) },
      xl: { $value: px(16) },
      full: { $value: px(9999) },
    },
    shadow: {
      sm: {
        $value: [{ x: 0, y: 1, blur: 2, spread: 0, color: oklch(0.2, 0.02, 250, 0.08) }],
      },
      md: {
        $value: [
          { x: 0, y: 2, blur: 8, spread: -1, color: oklch(0.2, 0.02, 250, 0.1) },
          { x: 0, y: 1, blur: 2, spread: 0, color: oklch(0.2, 0.02, 250, 0.06) },
        ],
      },
      lg: {
        $value: [
          { x: 0, y: 12, blur: 32, spread: -4, color: oklch(0.2, 0.02, 250, 0.14) },
          { x: 0, y: 2, blur: 6, spread: -1, color: oklch(0.2, 0.02, 250, 0.08) },
        ],
      },
    },
    typography: {
      fontFamily: {
        sans: { $value: 'Inter' },
        mono: { $value: 'JetBrains Mono' },
      },
      fontSize: {
        xs: { $value: px(12) },
        sm: { $value: px(14) },
        base: { $value: px(16) },
        lg: { $value: px(18) },
        xl: { $value: px(20) },
        '2xl': { $value: px(24) },
        '3xl': { $value: px(30) },
        '4xl': { $value: px(36) },
        '5xl': { $value: px(48) },
        '6xl': { $value: px(60) },
      },
    },
  };
}

export function createDocument(init: { name?: string; id?: string } = {}): PitoletDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: init.id ?? newId(),
    name: init.name ?? 'Untitled',
    rootOrder: [],
    nodes: {},
    components: {},
    tokens: defaultTokens(),
    breakpoints: [...DEFAULT_BREAKPOINTS],
    assets: {},
    comments: {},
  };
}

/** Convenience for building docs in code (tests, samples): attach a child. */
export function attach(
  doc: PitoletDocument,
  parentId: NodeId | null,
  node: FrameNode | ElementNode | TextNode | ImageNode | InstanceNode,
  index?: number,
): typeof node {
  doc.nodes[node.id] = node;
  node.parent = parentId;
  if (parentId === null) {
    if (node.type !== 'frame') throw new Error('only frames can be top-level');
    doc.rootOrder.splice(index ?? doc.rootOrder.length, 0, node.id);
  } else {
    const parent = doc.nodes[parentId];
    if (!parent) throw new Error(`no such parent ${parentId}`);
    parent.children.splice(index ?? parent.children.length, 0, node.id);
  }
  return node;
}

/** Standard spacing helpers used across sample docs and tools. */
export const spacingToken = (name: string) => ({ $token: `spacing.${name}` });
export { px, rem, sides };
