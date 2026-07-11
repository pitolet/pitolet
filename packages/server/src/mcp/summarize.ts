import {
  isTokenRef,
  type PitoletDocument,
  type PitoletNode,
  type Length,
  type NodeId,
  type Size,
  type StyleDecl,
  type StyleValue,
  type TextSpan,
} from '@pitolet/schema';

function spansToPlainTextFallback(spans: TextSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/**
 * Token-cheap projections of document data for MCP responses. A typical
 * frame summary must stay well under 500 tokens — depth caps, child
 * truncation, and a compact style notation instead of raw JSON.
 */

export interface NodeSummary {
  id: NodeId;
  type: string;
  tag: string;
  name: string;
  childCount: number;
  text?: string;
  styles?: string;
  children?: NodeSummary[];
  truncatedChildren?: number;
}

const MAX_CHILDREN = 20;
export const MAX_DEPTH = 5;

export function summarizeNode(
  doc: PitoletDocument,
  nodeId: NodeId,
  depth: number,
): NodeSummary | null {
  const node = doc.nodes[nodeId];
  if (!node) return null;

  const summary: NodeSummary = {
    id: node.id,
    type: node.type,
    tag: node.tag,
    name: node.name,
    childCount: node.children.length,
  };
  if (node.type === 'text') {
    const text = spansToPlainTextFallback(node.content);
    summary.text = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  const styles = styleSummary(node.styles.base);
  if (styles) summary.styles = styles;

  if (depth > 0 && node.children.length > 0) {
    const visible = node.children.slice(0, MAX_CHILDREN);
    summary.children = visible
      .map((childId) => summarizeNode(doc, childId, depth - 1))
      .filter((c): c is NodeSummary => c !== null);
    if (node.children.length > MAX_CHILDREN) {
      summary.truncatedChildren = node.children.length - MAX_CHILDREN;
    }
  }
  return summary;
}

/**
 * Compact single-line style notation listing only set properties, e.g.
 * "flex col gap=24 p=[16 24] w=fill bg=$color.muted fs=$fontSize.lg w600"
 */
export function styleSummary(s: StyleDecl): string {
  const parts: string[] = [];
  if (s.display === 'flex') {
    parts.push('flex', s.flexDirection === 'column' ? 'col' : 'row');
    if (s.flexWrap === 'wrap') parts.push('wrap');
  } else if (s.display) {
    parts.push(s.display);
  }
  if (s.alignItems) parts.push(`align=${s.alignItems}`);
  if (s.justifyContent) parts.push(`justify=${s.justifyContent}`);
  if (s.gap) {
    const row = lengthStr(s.gap.row);
    const col = lengthStr(s.gap.column);
    parts.push(row === col ? `gap=${row}` : `gap=[${row} ${col}]`);
  }
  if (s.gridTemplateColumns) parts.push(`cols=${s.gridTemplateColumns.length}`);
  if (s.padding) parts.push(`p=${sidesStr(s.padding)}`);
  if (s.margin) parts.push(`m=${sidesStr(s.margin)}`);
  if (s.width !== undefined) parts.push(`w=${sizeStr(s.width)}`);
  if (s.height !== undefined) parts.push(`h=${sizeStr(s.height)}`);
  if (s.maxWidth !== undefined) parts.push(`maxw=${sizeStr(s.maxWidth)}`);
  if (s.position) parts.push(s.position);
  if (s.fontSize !== undefined) parts.push(`fs=${lengthStr(s.fontSize)}`);
  if (s.fontWeight !== undefined && !isTokenRef(s.fontWeight)) parts.push(`w${s.fontWeight}`);
  if (s.fontFamily !== undefined)
    parts.push(`font=${isTokenRef(s.fontFamily) ? tokenStr(s.fontFamily.$token) : s.fontFamily}`);
  if (s.textAlign) parts.push(`text-${s.textAlign}`);
  if (s.color !== undefined) parts.push(`color=${colorStr(s.color)}`);
  if (s.fills && s.fills.length > 0) {
    const first = s.fills[0]!;
    parts.push(first.type === 'solid' ? `bg=${colorStr(first.color)}` : `bg=${first.type}-gradient`);
  }
  if (s.border) parts.push(`border=${colorStr(s.border.color)}`);
  if (s.radius) parts.push(`r=${lengthStr(s.radius.tl)}`);
  if (s.shadows && s.shadows.length > 0) parts.push('shadow');
  if (s.opacity !== undefined) parts.push(`opacity=${s.opacity}`);
  if (s.overflow) parts.push(`overflow=${s.overflow}`);
  return parts.join(' ');
}

function tokenStr(path: string): string {
  return `$${path.replace('typography.', '')}`;
}

function lengthStr(v: StyleValue<Length | number>): string {
  if (isTokenRef(v)) return tokenStr(v.$token);
  if (typeof v === 'number') return String(v);
  return v.unit === 'px' ? String(v.value) : `${v.value}${v.unit}`;
}

function sizeStr(v: StyleValue<Size>): string {
  if (isTokenRef(v)) return tokenStr(v.$token);
  if (v === 'auto' || v === 'fill') return v;
  return v.unit === 'px' ? String(v.value) : `${v.value}${v.unit}`;
}

function sidesStr(sides: { top: StyleValue<Length>; right: StyleValue<Length>; bottom: StyleValue<Length>; left: StyleValue<Length> }): string {
  const t = lengthStr(sides.top);
  const r = lengthStr(sides.right);
  const b = lengthStr(sides.bottom);
  const l = lengthStr(sides.left);
  if (t === r && r === b && b === l) return t;
  if (t === b && l === r) return `[${t} ${r}]`;
  return `[${t} ${r} ${b} ${l}]`;
}

function colorStr(v: StyleValue<{ l: number; c: number; h: number; alpha?: number }>): string {
  if (isTokenRef(v)) return tokenStr(v.$token);
  return `oklch(${v.l} ${v.c} ${v.h}${v.alpha !== undefined ? `/${v.alpha}` : ''})`;
}

/** One-line summary of a whole node for write-tool confirmations. */
export function confirmLine(doc: PitoletDocument, nodeId: NodeId): string {
  const node = doc.nodes[nodeId];
  if (!node) return `${nodeId} (deleted)`;
  const styles = styleSummary(node.styles.base);
  return `${node.name} <${node.tag}> [${node.id}] ${node.children.length} children${styles ? ` — ${styles}` : ''}`;
}

export function summarizeSelectionTargets(doc: PitoletDocument, ids: NodeId[]): NodeSummary[] {
  return ids
    .map((id) => summarizeNode(doc, id, 1))
    .filter((s): s is NodeSummary => s !== null);
}

export type { PitoletNode };
