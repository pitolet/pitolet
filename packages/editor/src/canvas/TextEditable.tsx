import type { NodeId, TextNode } from '@pitolet/schema';
import { createElement, useEffect, useRef, type CSSProperties } from 'react';
import { useEditor } from '../store/index.js';
import { renderSpans } from './NodeRenderer.js';
import { domToSpans } from './textSpans.js';

/**
 * Inline text editing: the SAME element the renderer produces, made
 * contentEditable. Commit on blur/Enter (parsed through domToSpans);
 * Escape cancels.
 */
export function TextEditable({
  node,
  css,
}: {
  node: TextNode;
  css: CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  const cancelled = useRef(false);
  const nodeId: NodeId = node.id;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    cancelled.current = false;
    el.focus();
    // Select all content for immediate overtype.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [nodeId]);

  const commit = () => {
    const el = ref.current;
    const store = useEditor.getState();
    if (el && !cancelled.current) {
      const spans = domToSpans(el);
      store.dispatchEdit('Edit text', (draft) => {
        const target = draft.nodes[nodeId];
        if (target?.type === 'text') target.content = spans;
      });
    }
    if (store.editingTextId === nodeId) store.setEditingText(null);
  };

  return createElement(
    node.tag,
    {
      ref,
      'data-node-id': nodeId,
      style: css,
      contentEditable: true,
      suppressContentEditableWarning: true,
      onBlur: commit,
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onKeyDown: (e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          ref.current?.blur();
        }
        if (e.key === 'Escape') {
          cancelled.current = true;
          ref.current?.blur();
        }
      },
    },
    renderSpans(node.content),
  );
}
