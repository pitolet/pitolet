import { isAncestor, type PitoletNode, type NodeId } from '@pitolet/schema';
import { Eye, EyeOff, Frame, Image, Lock, LockOpen, MousePointerClick, Square, Type } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import { useEditor } from '../store/index.js';
import './LayersPanel.css';

/** Document tree: select, hover, rename (double-click), hide/lock, drag to reorder/reparent. */
export function LayersPanel() {
  const rootOrder = useEditor((s) => s.doc?.rootOrder);
  const docName = useEditor((s) => s.doc?.name);

  return (
    <div className="ptl-layers">
      <div className="ptl-panel-header">{docName ?? 'Layers'}</div>
      <div className="ptl-layers-tree" data-layers-tree>
        {rootOrder?.length ? (
          rootOrder.map((id) => <LayerRow key={id} id={id} depth={0} />)
        ) : (
          <div className="ptl-panel-empty">
            {rootOrder ? 'Press F to draw a frame' : 'Connecting…'}
          </div>
        )}
      </div>
    </div>
  );
}

type DropMode = 'before' | 'after' | 'inside';

const LayerRow = memo(function LayerRow({ id, depth }: { id: NodeId; depth: number }) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  const isSelected = useEditor((s) => s.selection.includes(id));
  const isHovered = useEditor((s) => s.hoveredId === id);
  const [renaming, setRenaming] = useState(false);
  const [dropMode, setDropMode] = useState<DropMode | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  if (!node) return null;
  const isContainer = node.type === 'frame' || node.type === 'element';

  const onPointerDown = (e: React.PointerEvent) => {
    if (renaming || e.button !== 0) return;
    const store = useEditor.getState();
    if (e.shiftKey) {
      store.select(
        isSelected ? store.selection.filter((s) => s !== id) : [...store.selection, id],
      );
      return;
    }
    if (!isSelected) store.select([id]);
    startLayerDrag(e.nativeEvent, id);
  };

  return (
    <>
      <div
        ref={rowRef}
        data-layer-row={id}
        data-layer-container={isContainer || undefined}
        className={[
          'ptl-layer-row',
          isSelected ? 'ptl-layer-row--selected' : '',
          isHovered ? 'ptl-layer-row--hovered' : '',
          !node.visible ? 'ptl-layer-row--hidden' : '',
          dropMode ? `ptl-layer-row--drop-${dropMode}` : '',
        ].join(' ')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onPointerDown={onPointerDown}
        onPointerEnter={() => useEditor.getState().setHover(id)}
        onPointerLeave={() => {
          useEditor.getState().setHover(null);
          setDropMode(null);
        }}
        onDoubleClick={() => setRenaming(true)}
      >
        <span className="ptl-layer-icon">{iconFor(node)}</span>
        {renaming ? (
          <input
            className="ptl-layer-rename"
            defaultValue={node.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== node.name) {
                useEditor.getState().dispatchEdit('Rename', (draft) => {
                  const n = draft.nodes[id];
                  if (n) n.name = name;
                });
              }
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <span className="ptl-layer-name">{node.name}</span>
        )}
        <span className="ptl-layer-actions">
          <button
            type="button"
            className={`ptl-layer-action ${node.locked ? 'ptl-layer-action--on' : ''}`}
            title={node.locked ? 'Unlock' : 'Lock'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() =>
              useEditor.getState().dispatchEdit(node.locked ? 'Unlock' : 'Lock', (draft) => {
                const n = draft.nodes[id];
                if (n) n.locked = !n.locked;
              })
            }
          >
            {node.locked ? <Lock size={11} /> : <LockOpen size={11} />}
          </button>
          <button
            type="button"
            className={`ptl-layer-action ${!node.visible ? 'ptl-layer-action--on' : ''}`}
            title={node.visible ? 'Hide' : 'Show'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() =>
              useEditor.getState().dispatchEdit(node.visible ? 'Hide' : 'Show', (draft) => {
                const n = draft.nodes[id];
                if (n) n.visible = !n.visible;
              })
            }
          >
            {node.visible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
        </span>
      </div>
      {node.children.map((childId) => (
        <LayerRow key={childId} id={childId} depth={depth + 1} />
      ))}
    </>
  );
});

/**
 * Row drag: after 4px slop, track the row under the cursor; position within
 * it picks before/after (edges) or inside (middle, containers only).
 * Visualized via CSS classes on the hovered row; committed as one patch.
 */
function startLayerDrag(e: PointerEvent, draggedId: NodeId): void {
  const start = { x: e.clientX, y: e.clientY };
  let started = false;
  let currentTarget: { id: NodeId; mode: DropMode } | null = null;
  let markedEl: Element | null = null;

  const clearMark = () => {
    markedEl?.classList.remove(
      'ptl-layer-row--drop-before',
      'ptl-layer-row--drop-after',
      'ptl-layer-row--drop-inside',
    );
    markedEl = null;
  };

  const onMove = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) started = true;
    if (!started) return;
    const doc = useEditor.getState().doc;
    if (!doc) return;

    clearMark();
    currentTarget = null;
    const rowEl = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null)?.closest(
      '[data-layer-row]',
    );
    if (!rowEl) return;
    const targetId = rowEl.getAttribute('data-layer-row')!;
    if (targetId === draggedId) return;
    if (isAncestor(doc.nodes, draggedId, targetId)) return; // no dropping into own subtree

    const rect = rowEl.getBoundingClientRect();
    const ratio = (ev.clientY - rect.top) / rect.height;
    const isContainer = rowEl.hasAttribute('data-layer-container');
    const mode: DropMode =
      isContainer && ratio > 0.3 && ratio < 0.7 ? 'inside' : ratio < 0.5 ? 'before' : 'after';

    // Top-level frames can only host reordering among themselves for non-frames.
    const targetNode = doc.nodes[targetId];
    const draggedNode = doc.nodes[draggedId];
    if (!targetNode || !draggedNode) return;
    if (
      (mode === 'before' || mode === 'after') &&
      targetNode.parent === null &&
      draggedNode.parent !== null &&
      draggedNode.type !== 'frame'
    ) {
      return; // a leaf can't become a sibling of root frames
    }

    currentTarget = { id: targetId, mode };
    markedEl = rowEl;
    rowEl.classList.add(`ptl-layer-row--drop-${mode}`);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    clearMark();
    if (!started || !currentTarget) return;
    const { id: targetId, mode } = currentTarget;

    useEditor.getState().dispatchEdit('Reorder layers', (draft) => {
      const dragged = draft.nodes[draggedId];
      const target = draft.nodes[targetId];
      if (!dragged || !target) return;

      // Detach from the current location.
      if (dragged.parent) {
        const oldParent = draft.nodes[dragged.parent];
        if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== draggedId);
      } else {
        draft.rootOrder = draft.rootOrder.filter((r) => r !== draggedId);
      }

      if (mode === 'inside') {
        target.children.unshift(draggedId);
        dragged.parent = targetId;
      } else if (target.parent === null) {
        const at = draft.rootOrder.indexOf(targetId) + (mode === 'after' ? 1 : 0);
        draft.rootOrder.splice(at, 0, draggedId);
        dragged.parent = null;
      } else {
        const parent = draft.nodes[target.parent]!;
        const at = parent.children.indexOf(targetId) + (mode === 'after' ? 1 : 0);
        parent.children.splice(at, 0, draggedId);
        dragged.parent = target.parent;
      }
    });
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function iconFor(node: PitoletNode) {
  switch (node.type) {
    case 'frame':
      return <Frame size={12} />;
    case 'text':
      return <Type size={12} />;
    case 'image':
      return <Image size={12} />;
    case 'instance':
      return <MousePointerClick size={12} />;
    default:
      return <Square size={12} />;
  }
}
