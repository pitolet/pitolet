import type { NodeId } from '@pitolet/schema';
import { LockKeyhole } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { glowingNodeIds } from '../agentGlow.js';
import type { CameraController } from '../CameraController.js';
import { startFrameResize, type ResizeHandle } from '../interaction/frameDrag.js';
import { interactionState } from '../interaction/interactionState.js';
import { overlaySync } from '../overlaySync.js';
import { useEditor } from '../../store/index.js';
import { isEffectivelyLocked } from '../../store/locks.js';
import './OverlayLayer.css';

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Screen-space chrome above the canvas: hover outline, selection boxes,
 * resize handles, marquee. Positions update imperatively on overlaySync
 * ticks (camera motion, patches, transient drags) — the component itself
 * re-renders only when WHICH nodes are selected/hovered changes.
 */
export function OverlayLayer({ camera }: { camera: CameraController }) {
  const selection = useEditor((s) => s.selection);
  const hoveredId = useEditor((s) => s.hoveredId);
  const hasDoc = useEditor((s) => s.doc !== null);
  const editingAvailable = useEditor((s) => !s.readOnly && s.connected && !s.switchingDocument);
  const resizeFrameId = useEditor((s) => {
    if (!s.doc || s.selection.length !== 1 || s.editingContext.breakpointId) return null;
    const id = s.selection[0]!;
    const node = s.doc.nodes[id];
    return node?.type === 'frame' && node.parent === null ? id : null;
  });
  const lockedSelection = useEditor(
    useShallow((s) =>
      s.doc ? s.selection.filter((id) => isEffectivelyLocked(s.doc!, id)).sort() : [],
    ),
  );

  if (!hasDoc) return null;
  const showHover = hoveredId !== null && !selection.includes(hoveredId);

  return (
    <>
      {showHover && <NodeBox key={`h-${hoveredId}`} id={hoveredId} kind="hover" camera={camera} />}
      {selection.map((id) => (
        <NodeBox
          key={id}
          id={id}
          kind="selected"
          camera={camera}
          withHandles={id === resizeFrameId && editingAvailable && !lockedSelection.includes(id)}
          locked={lockedSelection.includes(id)}
        />
      ))}
      <MarqueeBox />
      <TransientChrome />
      <AgentGlowBoxes camera={camera} />
      <CommentPins camera={camera} />
    </>
  );
}

/** Count badges on nodes that have unresolved comments; click selects the node. */
function CommentPins({ camera }: { camera: CameraController }) {
  const showComments = useEditor((s) => s.showComments);
  const counts = useEditor(
    useShallow((s) => {
      const byNode = new Map<NodeId, number>();
      for (const comment of Object.values(s.doc?.comments ?? {})) {
        if (comment.resolved || !s.doc?.nodes[comment.nodeId]) continue;
        byNode.set(comment.nodeId, (byNode.get(comment.nodeId) ?? 0) + 1);
      }
      return [...byNode.entries()].map(([id, n]) => `${id}:${n}`).sort();
    }),
  );
  if (!showComments || counts.length === 0) return null;
  return (
    <>
      {counts.map((entry) => {
        const [id, count] = entry.split(':') as [NodeId, string];
        return <CommentPin key={id} id={id} count={Number(count)} camera={camera} />;
      })}
    </>
  );
}

function CommentPin({
  id,
  count,
  camera,
}: {
  id: NodeId;
  count: number;
  camera: CameraController;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = el.closest('[data-canvas-viewport]');
    const update = () => {
      const target = document.querySelector(`[data-node-id="${id}"]`);
      if (!target || !viewport) {
        el.style.display = 'none';
        return;
      }
      const rect = target.getBoundingClientRect();
      const vp = viewport.getBoundingClientRect();
      el.style.display = 'flex';
      el.style.transform = `translate(${rect.right - vp.left - 9}px, ${rect.top - vp.top - 9}px)`;
    };
    update();
    const unsubOverlay = overlaySync.subscribe(update);
    const unsubCamera = camera.subscribe(update);
    return () => {
      unsubOverlay();
      unsubCamera();
    };
  }, [id, camera]);

  return (
    <button
      ref={ref}
      type="button"
      className="ptl-comment-pin"
      title={`Open ${count} comment${count === 1 ? '' : 's'}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        const store = useEditor.getState();
        store.select([id]);
        store.setRightPanelMode('comments');
        store.setShowComments(true);
        store.setInspectorFocus('comments');
      }}
    >
      {count}
    </button>
  );
}

/** Short-lived glow on nodes the agent just changed (MCP-origin patches). */
function AgentGlowBoxes({ camera }: { camera: CameraController }) {
  const ids = useSyncExternalStore(subscribeOverlay, () => glowingNodeIds().join(','));
  if (!ids) return null;
  return (
    <>
      {ids.split(',').map((id) => (
        <GlowBox key={id} id={id} camera={camera} />
      ))}
    </>
  );
}

function GlowBox({ id, camera }: { id: NodeId; camera: CameraController }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = el.closest('[data-canvas-viewport]');
    const update = () => {
      const target = document.querySelector(`[data-node-id="${id}"]`);
      if (!target || !viewport) {
        el.style.display = 'none';
        return;
      }
      const rect = target.getBoundingClientRect();
      const vp = viewport.getBoundingClientRect();
      el.style.display = 'block';
      el.style.transform = `translate(${rect.left - vp.left}px, ${rect.top - vp.top}px)`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
    };
    update();
    const unsubOverlay = overlaySync.subscribe(update);
    const unsubCamera = camera.subscribe(update);
    return () => {
      unsubOverlay();
      unsubCamera();
    };
  }, [id, camera]);

  return <div ref={ref} className="ptl-agent-glow" />;
}

/** Snap guides, drop indicators, drag ghost — driven purely by overlaySync ticks. */
function TransientChrome() {
  const version = useSyncExternalStore(subscribeOverlay, () => {
    const s = interactionState;
    return `${s.guides.length}|${s.dropIndicator ? `${s.dropIndicator.x},${s.dropIndicator.y},${s.dropIndicator.width},${s.dropIndicator.height}` : ''}|${s.ghost ? `${s.ghost.x},${s.ghost.y}` : ''}`;
  });
  void version;
  const { guides, dropIndicator, ghost } = interactionState;
  return (
    <>
      {guides.map((g, i) =>
        g.axis === 'x' ? (
          <div
            key={`gx${i}`}
            className="ptl-snap-guide"
            style={{
              left: g.position,
              top: Math.min(g.start, g.end),
              width: 1,
              height: Math.abs(g.end - g.start),
            }}
          />
        ) : (
          <div
            key={`gy${i}`}
            className="ptl-snap-guide"
            style={{
              top: g.position,
              left: Math.min(g.start, g.end),
              height: 1,
              width: Math.abs(g.end - g.start),
            }}
          />
        ),
      )}
      {dropIndicator?.containerRect && (
        <div
          className="ptl-drop-container"
          style={{
            transform: `translate(${dropIndicator.containerRect.x}px, ${dropIndicator.containerRect.y}px)`,
            width: dropIndicator.containerRect.width,
            height: dropIndicator.containerRect.height,
          }}
        />
      )}
      {dropIndicator && (
        <div
          className="ptl-drop-line"
          style={{
            transform: `translate(${dropIndicator.x}px, ${dropIndicator.y}px)`,
            width: dropIndicator.width,
            height: dropIndicator.height,
          }}
        />
      )}
      {ghost && (
        <div
          className="ptl-drag-ghost"
          style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)` }}
        >
          {ghost.label}
        </div>
      )}
    </>
  );
}

function NodeBox({
  id,
  kind,
  camera,
  withHandles = false,
  locked = false,
}: {
  id: NodeId;
  kind: 'hover' | 'selected';
  camera: CameraController;
  withHandles?: boolean;
  locked?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = el.closest('[data-canvas-viewport]');

    const update = () => {
      const target = document.querySelector(`[data-node-id="${id}"]`);
      if (!target || !viewport) {
        el.style.display = 'none';
        return;
      }
      const nodeRect = target.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      el.style.display = 'block';
      el.style.transform = `translate(${nodeRect.left - vpRect.left}px, ${nodeRect.top - vpRect.top}px)`;
      el.style.width = `${nodeRect.width}px`;
      el.style.height = `${nodeRect.height}px`;
      el.classList.toggle('ptl-nodebox--dragging', interactionState.dragging);
      el.classList.toggle('ptl-nodebox--resizing', interactionState.gesture === 'resize');
      if (sizeRef.current) {
        const w = Math.round(nodeRect.width / camera.zoom);
        const h = Math.round(nodeRect.height / camera.zoom);
        sizeRef.current.textContent = `${w} × ${h}`;
      }
    };

    update();
    const unsubscribeOverlay = overlaySync.subscribe(update);
    const unsubscribeCamera = camera.subscribe(update);
    return () => {
      unsubscribeOverlay();
      unsubscribeCamera();
    };
  }, [id, camera]);

  return (
    <div ref={ref} className={`ptl-nodebox ptl-nodebox--${kind}`}>
      {withHandles && (
        <>
          {HANDLES.map((handle) => (
            <div
              key={handle}
              className={`ptl-handle ptl-handle--${handle}`}
              data-resize-handle={handle}
              title="Drag to resize. Shift keeps proportions. Alt resizes from the center."
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                startFrameResize(e.nativeEvent, id, handle, camera);
              }}
            />
          ))}
          <div ref={sizeRef} className="ptl-size-badge" />
        </>
      )}
      {locked && kind === 'selected' && (
        <div className="ptl-lock-badge" title="Locked layer">
          <LockKeyhole size={10} />
        </div>
      )}
    </div>
  );
}

function MarqueeBox() {
  const version = useSyncExternalStore(subscribeOverlay, () =>
    interactionState.marquee
      ? `${interactionState.marquee.x},${interactionState.marquee.y},${interactionState.marquee.width},${interactionState.marquee.height}`
      : '',
  );
  if (!version) return null;
  const m = interactionState.marquee!;
  return (
    <div
      className="ptl-marquee"
      style={{ transform: `translate(${m.x}px, ${m.y}px)`, width: m.width, height: m.height }}
    />
  );
}

function subscribeOverlay(cb: () => void): () => void {
  return overlaySync.subscribe(cb);
}
