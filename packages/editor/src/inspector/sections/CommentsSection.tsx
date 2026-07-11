import { newId, type PitoletComment } from '@pitolet/schema';
import { Sparkles, User } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../../store/index.js';
import { Section } from '../fields.js';
import './CommentsSection.css';

/**
 * Comments on the selected node — the shared notepad between the human and
 * their coding agent (agents read/write these via MCP get_comments/add_comment).
 */
export function CommentsSection() {
  const nodeId = useEditor((s) => (s.selection.length === 1 ? s.selection[0]! : null));
  const comments = useEditor(
    useShallow((s) =>
      nodeId
        ? Object.values(s.doc?.comments ?? {}).filter((c) => c.nodeId === nodeId)
        : [],
    ),
  );
  const [draft, setDraft] = useState('');

  if (!nodeId) return null;
  const open = comments.filter((c) => !c.resolved).sort((a, b) => a.createdAt - b.createdAt);
  const resolvedCount = comments.length - open.length;

  const addComment = () => {
    const text = draft.trim();
    if (!text) return;
    const comment: PitoletComment = {
      id: newId(),
      nodeId,
      text,
      author: 'you',
      createdAt: Date.now(),
    };
    useEditor.getState().dispatchEdit('Add comment', (draftDoc) => {
      draftDoc.comments = draftDoc.comments ?? {};
      draftDoc.comments[comment.id] = comment;
    });
    setDraft('');
  };

  return (
    <Section
      title={`Comments${open.length > 0 ? ` · ${open.length}` : ''}`}
      actions={
        resolvedCount > 0 ? (
          <span className="ptl-insp-hint">{resolvedCount} resolved</span>
        ) : undefined
      }
    >
      {open.map((comment) => (
        <CommentRow key={comment.id} comment={comment} />
      ))}
      <div className="ptl-comment-compose">
        <textarea
          className="ptl-comment-input"
          placeholder="Leave a note. Your agent reads these too."
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment();
          }}
        />
        {draft.trim() && (
          <button type="button" className="ptl-comment-send" onClick={addComment}>
            Comment
          </button>
        )}
      </div>
    </Section>
  );
}

function CommentRow({ comment }: { comment: PitoletComment }) {
  const isAgent = comment.author === 'agent';
  return (
    <div className={`ptl-comment ${isAgent ? 'ptl-comment--agent' : ''}`}>
      <span className="ptl-comment-avatar">
        {isAgent ? <Sparkles size={11} /> : <User size={11} />}
      </span>
      <div className="ptl-comment-body">
        <div className="ptl-comment-meta">
          <span className="ptl-comment-author">{isAgent ? 'Agent' : 'You'}</span>
          <span className="ptl-comment-time">{timeAgo(comment.createdAt)}</span>
        </div>
        <div className="ptl-comment-text">{comment.text}</div>
      </div>
      <div className="ptl-comment-actions">
        <button
          type="button"
          className="ptl-comment-action"
          title="Resolve"
          onClick={() =>
            useEditor.getState().dispatchEdit('Resolve comment', (draft) => {
              const c = draft.comments?.[comment.id];
              if (c) c.resolved = true;
            })
          }
        >
          ✓
        </button>
        <button
          type="button"
          className="ptl-comment-action ptl-comment-action--delete"
          title="Delete"
          onClick={() =>
            useEditor.getState().dispatchEdit('Delete comment', (draft) => {
              delete draft.comments?.[comment.id];
            })
          }
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function timeAgo(time: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
