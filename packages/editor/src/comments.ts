import type { PitoletComment, PitoletDocument } from '@pitolet/schema';

export type CommentFilter = 'open' | 'resolved';

export interface CommentEntry {
  comment: PitoletComment;
  nodeName: string;
  nodeExists: boolean;
}

export function commentsForView(
  doc: PitoletDocument | null,
  filter: CommentFilter,
): CommentEntry[] {
  if (!doc) return [];
  return Object.values(doc.comments ?? {})
    .filter((comment) => (filter === 'resolved' ? comment.resolved : !comment.resolved))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((comment) => ({
      comment,
      nodeName: doc.nodes[comment.nodeId]?.name ?? 'Missing layer',
      nodeExists: Boolean(doc.nodes[comment.nodeId]),
    }));
}

export function commentCounts(doc: PitoletDocument | null): { open: number; resolved: number } {
  let open = 0;
  let resolved = 0;
  for (const comment of Object.values(doc?.comments ?? {})) {
    if (comment.resolved) resolved += 1;
    else open += 1;
  }
  return { open, resolved };
}

export function nodeCommentCounts(
  doc: PitoletDocument | null,
  nodeId: string | null,
): { open: number; resolved: number } {
  let open = 0;
  let resolved = 0;
  if (!doc || !nodeId) return { open, resolved };
  for (const comment of Object.values(doc.comments ?? {})) {
    if (comment.nodeId !== nodeId) continue;
    if (comment.resolved) resolved += 1;
    else open += 1;
  }
  return { open, resolved };
}

export function commentTimeAgo(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
