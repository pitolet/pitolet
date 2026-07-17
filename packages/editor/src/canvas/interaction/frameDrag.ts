import type { NodeId } from '@pitolet/schema';
import { useEditor } from '../../store/index.js';
import { isEffectivelyLocked } from '../../store/locks.js';
import { moveFrames, setFrameBounds } from '../../store/mutations.js';
import type { CameraController } from '../CameraController.js';
import { AUTO_HEIGHT_FALLBACK, renderedFrameHeight } from '../frameMeasurements.js';
import { overlaySync } from '../overlaySync.js';
import {
  clearInteractionCancel,
  setDragging,
  setGuides,
  setInteractionCancel,
} from './interactionState.js';
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
  camera.cancelAnimation();
  const startZoom = camera.zoom;
  const initialStore = useEditor.getState();
  const initialDoc = initialStore.doc;
  if (
    !initialDoc ||
    initialStore.readOnly ||
    !initialStore.connected ||
    initialStore.switchingDocument ||
    frameIds.some((id) => isEffectivelyLocked(initialDoc, id))
  ) {
    return;
  }
  const start = { x: e.clientX, y: e.clientY };
  const wrappers = frameIds
    .map((id) => document.querySelector<HTMLElement>(`[data-frame-wrapper="${id}"]`))
    .filter((el): el is HTMLElement => el !== null);
  let started = false;
  let dx = 0;
  let dy = 0;
  let raf = 0;
  let lastEvent = e;

  const frameHeight = (id: NodeId): number => {
    const doc = useEditor.getState().doc;
    const node = doc?.nodes[id];
    if (node?.type === 'frame' && node.canvas.height !== 'auto') return node.canvas.height;
    return renderedFrameHeight(id, startZoom) ?? AUTO_HEIGHT_FALLBACK;
  };

  const updateDelta = (ev: PointerEvent) => {
    const rawDx = (ev.clientX - start.x) / startZoom;
    const rawDy = (ev.clientY - start.y) / startZoom;
    const doc = useEditor.getState().doc;
    if (!doc) return;
    const snapped = ev.altKey
      ? { dx: rawDx, dy: rawDy, guides: [] }
      : snapFrameDelta(doc, frameIds, rawDx, rawDy, camera, frameHeight);
    dx = snapped.dx;
    dy = snapped.dy;
    setGuides(snapped.guides);
  };

  const applyTransient = () => {
    for (const el of wrappers) el.style.translate = `${dx}px ${dy}px`;
    overlaySync.notify();
  };

  const onMove = (ev: PointerEvent) => {
    lastEvent = ev;
    if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_SLOP_PX) {
      started = true;
      useEditor.getState().setHover(null);
      setDragging(true, 'move');
    }
    if (!started) return;
    updateDelta(ev);
    if (raf === 0) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyTransient();
      });
    }
  };

  const finish = (cancelled: boolean, finalEvent?: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    clearInteractionCancel(cancel);
    if (started && finalEvent) updateDelta(finalEvent);
    if (raf !== 0) cancelAnimationFrame(raf);
    setGuides([]);
    for (const el of wrappers) el.style.translate = '';
    if (started) {
      setDragging(false);
      if (cancelled || (Math.round(dx) === 0 && Math.round(dy) === 0)) return;
      useEditor
        .getState()
        .dispatchEdit(frameIds.length > 1 ? 'Move frames' : 'Move frame', (draft) =>
          moveFrames(draft, frameIds, dx, dy),
        );
    }
  };

  const onUp = (ev: PointerEvent) => finish(false, ev ?? lastEvent);
  const cancel = () => finish(true);

  setInteractionCancel(cancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface FrameWrapperInlineStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

/**
 * Resize previews temporarily replace React-owned positioning styles. Restore
 * their exact pre-gesture values before committing so unchanged properties do
 * not disappear from the DOM when React skips them during reconciliation.
 */
export function captureFrameWrapperInlineStyle(element: HTMLElement): FrameWrapperInlineStyle {
  return {
    left: element.style.left,
    top: element.style.top,
    width: element.style.width,
    height: element.style.height,
  };
}

export function restoreFrameWrapperInlineStyle(
  element: HTMLElement,
  style: FrameWrapperInlineStyle,
): void {
  element.style.left = style.left;
  element.style.top = style.top;
  element.style.width = style.width;
  element.style.height = style.height;
}

/** Resize a single top-level frame from one of eight handles. */
export function startFrameResize(
  e: PointerEvent,
  frameId: NodeId,
  handle: ResizeHandle,
  camera: CameraController,
): void {
  camera.cancelAnimation();
  const startZoom = camera.zoom;
  const store = useEditor.getState();
  const doc = store.doc;
  const node = doc?.nodes[frameId];
  if (
    !doc ||
    !node ||
    store.readOnly ||
    !store.connected ||
    store.switchingDocument ||
    node.type !== 'frame' ||
    isEffectivelyLocked(doc, frameId)
  ) {
    return;
  }

  const start = { x: e.clientX, y: e.clientY };
  const initial = { ...node.canvas };
  const initialHeight =
    initial.height === 'auto'
      ? (renderedFrameHeight(frameId, startZoom) ?? AUTO_HEIGHT_FALLBACK)
      : initial.height;
  const wrapper = document.querySelector<HTMLElement>(`[data-frame-wrapper="${frameId}"]`);
  if (!wrapper) return;
  const initialInlineStyle = captureFrameWrapperInlineStyle(wrapper);

  let bounds = { x: initial.x, y: initial.y, width: initial.width, height: initialHeight };
  let preserveAutoHeight =
    initial.height === 'auto' && !handle.includes('n') && !handle.includes('s');
  let raf = 0;
  let started = false;

  const updateBounds = (ev: PointerEvent) => {
    preserveAutoHeight =
      initial.height === 'auto' && !handle.includes('n') && !handle.includes('s') && !ev.shiftKey;
    const dx = (ev.clientX - start.x) / startZoom;
    const dy = (ev.clientY - start.y) / startZoom;
    bounds = applyResizeHandle(
      initial.x,
      initial.y,
      initial.width,
      initialHeight,
      handle,
      dx,
      dy,
      ev.shiftKey,
      ev.altKey,
    );
  };

  const applyTransient = () => {
    wrapper.style.left = `${bounds.x}px`;
    wrapper.style.top = `${bounds.y}px`;
    wrapper.style.width = `${bounds.width}px`;
    wrapper.style.height = preserveAutoHeight ? initialInlineStyle.height : `${bounds.height}px`;
    overlaySync.notify();
  };

  const onMove = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 1) {
      started = true;
      useEditor.getState().setHover(null);
      setDragging(true, 'resize');
    }
    if (!started) return;
    updateBounds(ev);
    if (raf === 0) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyTransient();
      });
    }
  };

  const finish = (cancelled: boolean, finalEvent?: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    clearInteractionCancel(cancel);
    if (started && finalEvent) updateBounds(finalEvent);
    if (raf !== 0) cancelAnimationFrame(raf);
    restoreFrameWrapperInlineStyle(wrapper, initialInlineStyle);
    if (!started) return;
    setDragging(false);
    if (cancelled) return;
    useEditor.getState().dispatchEdit('Resize frame', (draft) =>
      setFrameBounds(draft, frameId, {
        ...bounds,
        height: preserveAutoHeight ? 'auto' : bounds.height,
      }),
    );
  };

  const onUp = (ev: PointerEvent) => finish(false, ev);
  const cancel = () => finish(true);

  setInteractionCancel(cancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
}

export function applyResizeHandle(
  x: number,
  y: number,
  w: number,
  h: number,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockAspect: boolean,
  fromCenter = false,
): { x: number; y: number; width: number; height: number } {
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const multiplier = fromCenter ? 2 : 1;
  let nw = handle.includes('e')
    ? w + dx * multiplier
    : handle.includes('w')
      ? w - dx * multiplier
      : w;
  let nh = handle.includes('s')
    ? h + dy * multiplier
    : handle.includes('n')
      ? h - dy * multiplier
      : h;

  if (lockAspect && w > 0 && h > 0) {
    const ratio = w / h;
    if (handle === 'e' || handle === 'w') {
      nh = nw / ratio;
    } else if (handle === 'n' || handle === 's') {
      nw = nh * ratio;
    } else if (Math.abs(nw / w - 1) >= Math.abs(nh / h - 1)) {
      nh = nw / ratio;
    } else {
      nw = nh * ratio;
    }
  }

  nw = Math.max(16, nw);
  nh = Math.max(16, nh);

  let nx: number;
  let ny: number;
  if (fromCenter) {
    nx = centerX - nw / 2;
    ny = centerY - nh / 2;
  } else {
    nx = handle.includes('w') ? x + w - nw : handle.includes('e') ? x : centerX - nw / 2;
    ny = handle.includes('n') ? y + h - nh : handle.includes('s') ? y : centerY - nh / 2;
  }

  if (!lockAspect) {
    if (!handle.includes('e') && !handle.includes('w')) nx = x;
    if (!handle.includes('n') && !handle.includes('s')) ny = y;
    if (fromCenter) {
      if (!handle.includes('e') && !handle.includes('w')) nx = x;
      if (!handle.includes('n') && !handle.includes('s')) ny = y;
    }
  }

  return { x: nx, y: ny, width: nw, height: nh };
}
