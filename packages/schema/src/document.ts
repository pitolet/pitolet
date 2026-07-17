import type { AssetId, ComponentId, PitoletNode, NodeId } from './nodes.js';
import type { ComponentDef } from './components.js';
import type { TokenSet } from './tokens.js';

export const SCHEMA_VERSION = 2;

export interface Breakpoint {
  id: string;
  name: string;
  /** Mobile-first: styles in this layer apply at frame widths >= minWidth. */
  minWidth: number;
}

export interface Asset {
  fileName: string;
  width: number;
  height: number;
  mime: string;
  /**
   * Present for imported web-font files. Keeping the face descriptors beside
   * the content-addressed asset lets the editor and generated projects emit
   * a local @font-face rule without hotlinking the source site.
   */
  fontFace?: {
    family: string;
    style?: string;
    weight?: string;
    display?: string;
  };
}

/**
 * A comment pinned to a node — the collaboration medium between humans and
 * coding agents ("make this tighter" → agent reads it via get_comments).
 */
export interface PitoletComment {
  id: string;
  nodeId: NodeId;
  text: string;
  /** 'you' (editor), 'agent' (MCP), or a free-form author label. */
  author: string;
  /** Epoch milliseconds. */
  createdAt: number;
  resolved?: true;
}

export interface PitoletDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  /** Canvas order of top-level frames (later = on top in lists; canvas has no z overlap concept for frames). */
  rootOrder: NodeId[];
  /** Flat node map — every node in the document, including component masters. */
  nodes: Record<NodeId, PitoletNode>;
  components: Record<ComponentId, ComponentDef>;
  tokens: TokenSet;
  /** Sorted ascending by minWidth. */
  breakpoints: Breakpoint[];
  assets: Record<AssetId, Asset>;
  /** Node-pinned comments. Optional for backward compatibility with v1 docs. */
  comments?: Record<string, PitoletComment>;
}

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'sm', name: 'Small', minWidth: 640 },
  { id: 'md', name: 'Medium', minWidth: 768 },
  { id: 'lg', name: 'Large', minWidth: 1024 },
  { id: 'xl', name: 'X-Large', minWidth: 1280 },
];
