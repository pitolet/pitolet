import type { NodeId } from '@pitolet/schema';
import { useEditor } from '../../store/index.js';
import { moveFrames, setFrameBounds } from '../../store/mutations.js';
import type { CameraController } from '../CameraController.js';
import { overlaySync } from '../overlaySync.js';
import { setDragging, setGuides } from './interactionState.js';
import { snapFrameDelta } from './snap.js';

const DRAG_SLOP_PX = 4;

/**
 * Move top-level frames. Transient during the gesture (translate transforms
 * written straight to the DOM, zero React renders), one patch on release.
 */
export function startFrameMove(
  e: PointerEvent,
  frameIds: NodeId[],
  camera: CameraController,
): void {
  const start = { x: e.clientX, y: e.clientY };
  const wrappers = frameIds
    .map((id) => document.querySelector<HTMLElement>(`[data-frame-wrapper="${id}"]`))
    .filter((el): el is HTMLElement => el !== null);
  let started = false;
  let dx = 0;
  let dy = 0;
  let raf = 0;

  const frameHeight = (id: NodeId): number => {
    const doc = useEditor.getState().doc;
    const node = doc?.nodes[id];
    if (node?.type === 'frame' && node.canvas.height !== 'auto') return node.canvas.height;
    const el = document.querySelector(`[data-node-id="${id}"]`);
    return el ? el.getBoundingClientRect().height / camera.zoom : 400;
  };

  const onMove = (ev: PointerEvent) => {
    const rawDx = (ev.clientX - start.x) / camera.zoom;
    const rawDy = (ev.clientY - start.y) / camera.zoom;
    if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_SLOP_PX) {
      started = true;
      setDragging(true);
    }
    if (started && raf === 0) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        const doc = useEditor.getState().doc;
        if (!doc) return;
        const snapped = ev.altKey
          ? { dx: rawDx, dy: rawDy, guides: [] }
          : snapFrameDelta(doc, frameIds, rawDx, rawDy, camera, frameHeight);
        dx = snapped.dx;
        dy = snapped.dy;
        setGuides(snapped.guides);
        for (const el of wrappers) el.style.translate = `${dx}px ${dy}px`;
        overlaySync.notify();
      });
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (raf !== 0) cancelAnimationFrame(raf);
    setGuides([]);
    if (started) {
      for (const el of wrappers) el.style.translate = '';
      useEditor
        .getState()
        .dispatchEdit(frameIds.length > 1 ? 'Move frames' : 'Move frame', (draft) =>
          moveFrames(draft, frameIds, dx, dy),
        );
      setDragging(false);
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Resize a single top-level frame from one of eight handles. */
export function startFrameResize(
  e: PointerEvent,
  frameId: NodeId,
  handle: ResizeHandle,
  camera: CameraController,
): void {
  const doc = useEditor.getState().doc;
  const node = doc?.nodes[frameId];
  if (!node || node.type !== 'frame') return;

  const start = { x: e.clientX, y: e.clientY };
  const initial = { ...node.canvas };
  const initialHeight =
    initial.height === 'auto' ? measureAutoHeight(frameId) / camera.zoom : initial.height;
  const wrapper = document.querySelector<HTMLElement>(`[data-frame-wrapper="${frameId}"]`);
  if (!wrapper) return;

  let bounds = { x: initial.x, y: initial.y, width: initial.width, height: initialHeight };
  let raf = 0;
  setDragging(true);

  const onMove = (ev: PointerEvent) => {
    const dx = (ev.clientX - start.x) / camera.zoom;
    const dy = (ev.clientY - start.y) / camera.zoom;
    bounds = applyHandle(initial.x, initial.y, initial.width, initialHeight, handle, dx, dy, ev.shiftKey);
    if (raf === 0) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        wrapper.style.left = `${bounds.x}px`;
        wrapper.style.top = `${bounds.y}px`;
        wrapper.style.width = `${bounds.width}px`;
        wrapper.style.height = `${bounds.height}px`;
        overlaySync.notify();
      });
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (raf !== 0) cancelAnimationFrame(raf);
    wrapper.style.left = '';
    wrapper.style.top = '';
    wrapper.style.width = '';
    wrapper.style.height = '';
    useEditor.getState().dispatchEdit('Resize frame', (draft) =>
      setFrameBounds(draft, frameId, bounds),
    );
    setDragging(false);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function applyHandle(
  x: number,
  y: number,
  w: number,
  h: number,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockAspect: boolean,
): { x: number; y: number; width: number; height: number } {
  let nx = x;
  let ny = y;
  let nw = w;
  let nh = h;
  if (handle.includes('e')) nw = w + dx;
  if (handle.includes('w')) {
    nw = w - dx;
    nx = x + dx;
  }
  if (handle.includes('s')) nh = h + dy;
  if (handle.includes('n')) {
    nh = h - dy;
    ny = y + dy;
  }
  if (lockAspect && w > 0 && h > 0) {
    const ratio = w / h;
    if (handle === 'e' || handle === 'w') nh = nw / ratio;
    else if (handle === 'n' || handle === 's') nw = nh * ratio;
    else {
      nh = nw / ratio;
      if (handle.includes('n')) ny = y + (h - nh);
    }
  }
  if (nw < 16) {
    if (handle.includes('w')) nx -= 16 - nw;
    nw = 16;
  }
  if (nh < 16) {
    if (handle.includes('n')) ny -= 16 - nh;
    nh = 16;
  }
  return { x: nx, y: ny, width: nw, height: nh };
}

function measureAutoHeight(frameId: NodeId): number {
  const el = document.querySelector(`[data-node-id="${frameId}"]`);
  return el ? el.getBoundingClientRect().height : 400;
}
