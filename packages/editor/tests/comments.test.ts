import { attach, createDocument, createElement, createFrame } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import {
  commentCounts,
  commentsForView,
  commentTimeAgo,
  nodeCommentCounts,
} from '../src/comments.js';

function fixture() {
  const doc = createDocument({ name: 'Comments' });
  const page = attach(doc, null, createFrame({ name: 'Page' }));
  const first = attach(doc, page.id, createElement({ name: 'First card' }));
  const second = attach(doc, page.id, createElement({ name: 'Second card' }));
  doc.comments = {
    older: {
      id: 'older',
      nodeId: first.id,
      text: 'Older open comment',
      author: 'you',
      createdAt: 100,
    },
    newer: {
      id: 'newer',
      nodeId: second.id,
      text: 'Newer open comment',
      author: 'agent',
      createdAt: 300,
    },
    resolved: {
      id: 'resolved',
      nodeId: first.id,
      text: 'Resolved comment',
      author: 'you',
      createdAt: 200,
      resolved: true,
    },
  };
  return { doc, first, second };
}

describe('comment panel helpers', () => {
  it('separates open and resolved comments and shows newest first', () => {
    const { doc } = fixture();
    expect(commentsForView(doc, 'open').map((entry) => entry.comment.id)).toEqual([
      'newer',
      'older',
    ]);
    expect(commentsForView(doc, 'resolved').map((entry) => entry.comment.id)).toEqual(['resolved']);
    expect(commentCounts(doc)).toEqual({ open: 2, resolved: 1 });
  });

  it('reports counts for the selected layer independently', () => {
    const { doc, first, second } = fixture();
    expect(nodeCommentCounts(doc, first.id)).toEqual({ open: 1, resolved: 1 });
    expect(nodeCommentCounts(doc, second.id)).toEqual({ open: 1, resolved: 0 });
  });

  it('formats relative times with a stable supplied clock', () => {
    const now = 24 * 60 * 60 * 1000;
    expect(commentTimeAgo(now - 30_000, now)).toBe('just now');
    expect(commentTimeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(commentTimeAgo(now - 2 * 60 * 60_000, now)).toBe('2h');
    expect(commentTimeAgo(0, now)).toBe('1d');
  });
});
