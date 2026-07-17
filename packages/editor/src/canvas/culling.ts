import { useEditor } from '../store/index.js';
import type { FrameNode } from '@pitolet/schema';
import type { CameraController } from './CameraController.js';

const MARGIN_PX = 400;

interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Auto-height frames have no reliable schema bottom, so only cull them horizontally. */
export function frameIntersectsView(frame: FrameNode, view: WorldRect, margin: number): boolean {
  const horizontal =
    frame.canvas.x < view.x + view.width + margin &&
    frame.canvas.x + frame.canvas.width > view.x - margin;
  if (!horizontal) return false;
  if (frame.canvas.height === 'auto') return true;
  return (
    frame.canvas.y < view.y + view.height + margin &&
    frame.canvas.y + frame.canvas.height > view.y - margin
  );
}

/**
 * Frame-level viewport culling: root frames fully outside the (expanded)
 * viewport get display:none. Bounds come from the schema — no measurement.
 * Runs imperatively on camera commits and document changes; content inside
 * on-screen frames is cheap thanks to `contain` on .ptl-frame.
 */
export function installCulling(camera: CameraController): () => void {
  let scheduled = 0;
  let disposed = false;

  const cull = () => {
    scheduled = 0;
    if (disposed) return;
    const doc = useEditor.getState().doc;
    if (!doc) return;
    const view = camera.visibleWorldRect();
    const margin = MARGIN_PX / camera.zoom;
    for (const id of doc.rootOrder) {
      const node = doc.nodes[id];
      if (node?.type !== 'frame') continue;
      const el = document.querySelector<HTMLElement>(`[data-frame-wrapper="${id}"]`);
      if (!el) continue;
      if (el.dataset.forceRender === 'true') continue;
      const visible = frameIntersectsView(node, view, margin);
      el.style.display = visible ? '' : 'none';
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = requestAnimationFrame(cull);
  };

  const unsubscribeCamera = camera.subscribe(schedule);
  const unsubscribeStore = useEditor.subscribe((state, prev) => {
    if (state.doc !== prev.doc) schedule();
  });
  schedule();
  return () => {
    disposed = true;
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    unsubscribeCamera();
    unsubscribeStore();
  };
}
