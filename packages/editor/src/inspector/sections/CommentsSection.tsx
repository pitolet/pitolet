import { ChevronRight, MessageSquare } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { nodeCommentCounts } from '../../comments.js';
import { useEditor } from '../../store/index.js';
import './CommentsSection.css';

/** Quiet bridge from the bottom of the inspector to the dedicated Comments panel. */
export function CommentsSummary() {
  const { doc, nodeId } = useEditor(
    useShallow((state) => ({
      doc: state.doc,
      nodeId: state.selection.length === 1 ? state.selection[0]! : null,
    })),
  );
  if (!nodeId) return null;
  const counts = nodeCommentCounts(doc, nodeId);
  const count = counts.open + counts.resolved;
  const status =
    count === 0
      ? 'Add comment'
      : [
          counts.open > 0 ? `${counts.open} open` : null,
          counts.resolved > 0 ? `${counts.resolved} resolved` : null,
        ]
          .filter(Boolean)
          .join(', ');
  const openComments = () => {
    const store = useEditor.getState();
    store.setRightPanelMode('comments');
    store.setShowComments(true);
    store.setInspectorFocus('comments');
  };

  return (
    <button type="button" className="ptl-comments-footer" onClick={openComments}>
      <MessageSquare size={12} />
      <span className="ptl-comments-footer-title">Comments</span>
      <span className="ptl-comments-footer-status">{status}</span>
      <ChevronRight size={11} />
    </button>
  );
}
