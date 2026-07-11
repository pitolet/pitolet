import { useEditor } from '../store/index.js';
import type { CameraController } from './CameraController.js';

const MARGIN_PX = 400;

/**
 * Frame-level viewport culling: root frames fully outside the (expanded)
 * viewport get display:none. Bounds come from the schema — no measurement.
 * Runs imperatively on camera commits and document changes; content inside
 * on-screen frames is cheap thanks to `contain` on .ptl-frame.
 */
export function installCulling(camera: CameraController): () => void {
  let scheduled = false;

  const cull = () => {
    scheduled = false;
    const doc = useEditor.getState().doc;
    if (!doc) return;
    const view = camera.visibleWorldRect();
    const margin = MARGIN_PX / camera.zoom;
    for (const id of doc.rootOrder) {
      const node = doc.nodes[id];
      if (node?.type !== 'frame') continue;
      const el = document.querySelector<HTMLElement>(`[data-frame-wrapper="${id}"]`);
      if (!el) continue;
      const height = node.canvas.height === 'auto' ? 2000 : node.canvas.height;
      const visible =
        node.canvas.x < view.x + view.width + margin &&
        node.canvas.x + node.canvas.width > view.x - margin &&
        node.canvas.y < view.y + view.height + margin &&
        node.canvas.y + height > view.y - margin;
      el.style.display = visible ? '' : 'none';
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(cull);
  };

  const unsubscribeCamera = camera.subscribe(schedule);
  const unsubscribeStore = useEditor.subscribe((state, prev) => {
    if (state.doc !== prev.doc) schedule();
  });
  schedule();
  return () => {
    unsubscribeCamera();
    unsubscribeStore();
  };
}
