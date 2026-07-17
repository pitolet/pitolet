import { newId, type PitoletComment } from '@pitolet/schema';
import { Tabs } from '@pitolet/ui';
import { Check, MessageSquare, RotateCcw, Sparkles, Trash2, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  commentCounts,
  commentsForView,
  commentTimeAgo,
  type CommentEntry,
  type CommentFilter,
} from '../comments.js';
import { useEditor } from '../store/index.js';
import './CommentsPanel.css';

export function CommentsPanel() {
  const { doc, selection, connected, readOnly, switchingDocument, inspectorFocus } = useEditor(
    useShallow((state) => ({
      doc: state.doc,
      selection: state.selection,
      connected: state.connected,
      readOnly: state.readOnly,
      switchingDocument: state.switchingDocument,
      inspectorFocus: state.inspectorFocus,
    })),
  );
  const [filter, setFilter] = useState<CommentFilter>('open');
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selectedNodeId = selection.length === 1 ? selection[0]! : null;
  const selectedNode = selectedNodeId ? doc?.nodes[selectedNodeId] : undefined;
  const editable = connected && !readOnly && !switchingDocument;
  const counts = useMemo(() => commentCounts(doc), [doc]);
  const entries = useMemo(() => commentsForView(doc, filter), [doc, filter]);

  useEffect(() => setDraft(''), [selectedNodeId]);
  useEffect(() => {
    if (inspectorFocus !== 'comments') return;
    setFilter('open');
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      useEditor.getState().setInspectorFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorFocus]);

  const addComment = () => {
    const text = draft.trim();
    if (!text || !selectedNodeId || !editable) return;
    const comment: PitoletComment = {
      id: newId(),
      nodeId: selectedNodeId,
      text,
      author: 'you',
      createdAt: Date.now(),
    };
    useEditor.getState().dispatchEdit('Add comment', (document) => {
      document.comments = document.comments ?? {};
      document.comments[comment.id] = comment;
    });
    setDraft('');
    setFilter('open');
  };

  return (
    <div className="ptl-comments-panel">
      <header className="ptl-comments-panel-header">
        <div>
          <strong>Comments</strong>
        </div>
        {counts.open > 0 && <span className="ptl-comments-count">{counts.open}</span>}
      </header>

      <div className={`ptl-comments-compose ${!selectedNode ? 'ptl-comments-compose--empty' : ''}`}>
        {selectedNode ? (
          <>
            <div className="ptl-comments-compose-target">
              <MessageSquare size={13} />
              <span>Comment on</span>
              <strong title={selectedNode.name}>{selectedNode.name}</strong>
            </div>
            <textarea
              ref={inputRef}
              className="ptl-comments-input"
              aria-label={`Comment on ${selectedNode.name}`}
              placeholder="Write a comment"
              value={draft}
              rows={3}
              disabled={!editable}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  addComment();
                }
              }}
            />
            <div className="ptl-comments-compose-footer">
              <span>
                {readOnly
                  ? 'View only'
                  : switchingDocument
                    ? 'Opening document'
                    : connected
                      ? '⌘ Enter to add'
                      : 'Reconnect to comment'}
              </span>
              <button
                type="button"
                className="ptl-comments-submit"
                disabled={!draft.trim() || !editable}
                onClick={addComment}
              >
                Comment
              </button>
            </div>
          </>
        ) : (
          <div className="ptl-comments-select-hint">
            <MessageSquare size={16} />
            <div>
              <strong>Select a layer</strong>
              <span>Then write a comment.</span>
            </div>
          </div>
        )}
      </div>

      <div className="ptl-comments-filter">
        <Tabs
          value={filter}
          onValueChange={(value) => setFilter(value as CommentFilter)}
          tabs={[
            { value: 'open', label: `Open ${counts.open}` },
            { value: 'resolved', label: `Resolved ${counts.resolved}` },
          ]}
          size="sm"
        />
      </div>

      <div className="ptl-comments-list">
        {entries.length > 0 ? (
          entries.map((entry) => (
            <CommentCard
              key={entry.comment.id}
              entry={entry}
              selected={entry.comment.nodeId === selectedNodeId}
              readOnly={readOnly}
              editable={editable}
            />
          ))
        ) : (
          <div className="ptl-comments-empty">
            <Check size={17} />
            <strong>{filter === 'open' ? 'No open comments' : 'No resolved comments'}</strong>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  entry,
  selected,
  readOnly,
  editable,
}: {
  entry: CommentEntry;
  selected: boolean;
  readOnly: boolean;
  editable: boolean;
}) {
  const { comment, nodeName, nodeExists } = entry;
  const isAgent = comment.author === 'agent';
  const authorLabel =
    comment.author === 'agent' ? 'Agent' : comment.author === 'you' ? 'You' : comment.author;
  const setResolved = (resolved: boolean) => {
    if (!editable) return;
    useEditor
      .getState()
      .dispatchEdit(resolved ? 'Resolve comment' : 'Reopen comment', (document) => {
        const current = document.comments?.[comment.id];
        if (!current) return;
        if (resolved) current.resolved = true;
        else delete current.resolved;
      });
  };

  return (
    <article className={`ptl-comments-card ${selected ? 'ptl-comments-card--selected' : ''}`}>
      <div className="ptl-comments-card-header">
        <button
          type="button"
          className="ptl-comments-card-target"
          disabled={!nodeExists}
          title={nodeExists ? `Focus ${nodeName}` : 'The commented layer no longer exists'}
          onClick={() => {
            const store = useEditor.getState();
            store.select([comment.nodeId]);
            store.requestFocusNode(comment.nodeId);
            store.setShowComments(true);
          }}
        >
          <MessageSquare size={12} />
          <span>{nodeName}</span>
        </button>
        {!readOnly && (
          <div className="ptl-comments-card-actions">
            <button
              type="button"
              aria-label={comment.resolved ? 'Reopen comment' : 'Resolve comment'}
              disabled={!editable}
              onClick={() => setResolved(!comment.resolved)}
            >
              {comment.resolved ? <RotateCcw size={12} /> : <Check size={12} />}
              {comment.resolved ? 'Reopen' : 'Resolve'}
            </button>
            <button
              type="button"
              className="ptl-comments-delete"
              aria-label="Delete comment"
              title="Delete comment"
              disabled={!editable}
              onClick={() => {
                if (!editable) return;
                useEditor.getState().dispatchEdit('Delete comment', (document) => {
                  delete document.comments?.[comment.id];
                });
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="ptl-comments-card-content">
        <span className={`ptl-comments-avatar ${isAgent ? 'ptl-comments-avatar--agent' : ''}`}>
          {isAgent ? <Sparkles size={11} /> : <User size={11} />}
        </span>
        <div className="ptl-comments-card-body">
          <div className="ptl-comments-card-meta">
            <strong>{authorLabel}</strong>
            <span>{commentTimeAgo(comment.createdAt)}</span>
          </div>
          <p>{comment.text}</p>
        </div>
      </div>
    </article>
  );
}
