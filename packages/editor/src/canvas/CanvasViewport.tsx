import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tool } from '../store/index.js';
import { CameraController } from './CameraController.js';
import { cancelActiveInteraction, interactionState } from './interaction/interactionState.js';
import './CanvasViewport.css';

export interface CanvasViewportProps {
  camera: CameraController;
  activeTool: Tool;
  children?: ReactNode;
  /** Screen-space overlay content (selection handles, guides…). */
  overlay?: ReactNode;
  /** Pointer-down on canvas content (fires when not panning). */
  onContentPointerDown?: (e: PointerEvent, viewport: HTMLElement) => void;
  /** Pointer-move over canvas content (hover tracking). */
  onContentPointerMove?: (e: PointerEvent) => void;
  /** Pointer left the canvas; used to clear stale hover chrome. */
  onContentPointerLeave?: () => void;
  /** Double-click on canvas content (deep select / text edit). */
  onContentDoubleClick?: (e: MouseEvent) => void;
  /** Files dropped onto the canvas. */
  onContentDrop?: (e: DragEvent, viewport: HTMLElement) => void;
  /** Right-click on the canvas. */
  onContentContextMenu?: (e: MouseEvent, viewport: HTMLElement) => void;
}

/**
 * The gesture surface + world container. Content children render inside the
 * camera-transformed world; overlay children render in screen space above it.
 *
 * Input mapping:
 *  - trackpad two-finger scroll / mouse wheel → pan
 *  - ⌘/ctrl + wheel, trackpad pinch, Safari gesture events → zoom to cursor
 *  - space + drag, middle-mouse drag → pan
 */
export function CanvasViewport({
  camera,
  activeTool,
  children,
  overlay,
  onContentPointerDown,
  onContentPointerMove,
  onContentPointerLeave,
  onContentDoubleClick,
  onContentDrop,
  onContentContextMenu,
}: CanvasViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [spacePanning, setSpacePanning] = useState(false);
  const [panDragging, setPanDragging] = useState(false);
  const panDraggingRef = useRef(false);
  const panCleanupRef = useRef<(() => void) | null>(null);
  const spaceDown = useRef(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    const world = worldRef.current;
    if (!viewport || !world) return;
    camera.attach(viewport, world);

    const localPoint = (e: { clientX: number; clientY: number }) => {
      const rect = viewport.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (interactionState.cancel) return;
      camera.cancelAnimation();
      // Normalize line-mode deltas (some mice report deltaMode=1) to pixels.
      const scale = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // Zoom. ctrl/cmd+wheel is also how browsers report trackpad pinch.
        // Clamp the delta so one mouse notch (~120px) is a gentle step while
        // fine trackpad pinch stays smooth.
        const dy = Math.max(-50, Math.min(50, e.deltaY * scale));
        camera.zoomAt(localPoint(e), Math.exp(-dy * 0.004));
      } else {
        camera.panBy(-e.deltaX * scale, -e.deltaY * scale);
      }
    };

    // Safari-only trackpad pinch.
    let gestureStartZoom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      if (interactionState.cancel) return;
      camera.cancelAnimation();
      gestureStartZoom = camera.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (interactionState.cancel) return;
      const scale = (e as unknown as { scale: number; clientX: number; clientY: number }).scale;
      const pt = localPoint(e as unknown as { clientX: number; clientY: number });
      camera.zoomAt(pt, (gestureStartZoom * scale) / camera.zoom);
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('gesturestart', onGestureStart);
    viewport.addEventListener('gesturechange', onGestureChange);
    return () => {
      panCleanupRef.current?.();
      cancelActiveInteraction();
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('gesturestart', onGestureStart);
      viewport.removeEventListener('gesturechange', onGestureChange);
      camera.detach();
    };
  }, [camera]);

  // Space key toggles pan mode without stealing native activation from
  // focused application controls.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && shouldStartSpacePan(e.target) && !e.repeat) {
        spaceDown.current = true;
        setSpacePanning(true);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        setSpacePanning(false);
      }
    };
    const resetSpace = () => {
      spaceDown.current = false;
      setSpacePanning(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', resetSpace);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', resetSpace);
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const panDrag = e.button === 1 || (e.button === 0 && spaceDown.current);
    if (!panDrag) {
      if (e.button === 0 && viewportRef.current) {
        onContentPointerDown?.(e.nativeEvent, viewportRef.current);
      }
      return;
    }
    e.preventDefault();
    const viewport = viewportRef.current!;
    panCleanupRef.current?.();
    camera.cancelAnimation();
    panDraggingRef.current = true;
    setPanDragging(true);
    viewport.setPointerCapture(e.pointerId);
    const pointerId = e.pointerId;
    let last = { x: e.clientX, y: e.clientY };
    let cleanup = () => {};
    const applyMovement = (ev: PointerEvent) => {
      camera.panBy(ev.clientX - last.x, ev.clientY - last.y);
      last = { x: ev.clientX, y: ev.clientY };
    };
    const onMove = (ev: PointerEvent) => applyMovement(ev);
    const finish = (finalEvent?: PointerEvent) => {
      if (finalEvent) applyMovement(finalEvent);
      panDraggingRef.current = false;
      setPanDragging(false);
      if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      viewport.removeEventListener('pointermove', onMove);
      viewport.removeEventListener('pointerup', onUp);
      viewport.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      if (panCleanupRef.current === cleanup) panCleanupRef.current = null;
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onCancel = () => finish();
    const onBlur = () => finish();
    cleanup = () => finish();
    panCleanupRef.current = cleanup;
    viewport.addEventListener('pointermove', onMove);
    viewport.addEventListener('pointerup', onUp);
    viewport.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
  };

  return (
    <div
      ref={viewportRef}
      className={`ptl-canvas-viewport ptl-canvas-viewport--tool-${activeTool} ${spacePanning ? 'ptl-canvas-viewport--pan-ready' : ''} ${panDragging ? 'ptl-canvas-viewport--pan-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (!panDraggingRef.current) onContentPointerMove?.(e.nativeEvent);
      }}
      onPointerLeave={() => {
        if (!panDraggingRef.current) onContentPointerLeave?.();
      }}
      onDoubleClick={(e) => onContentDoubleClick?.(e.nativeEvent)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onContextMenu={(e) => {
        if (viewportRef.current) onContentContextMenu?.(e.nativeEvent, viewportRef.current);
      }}
      onDrop={(e) => {
        if (viewportRef.current) onContentDrop?.(e.nativeEvent, viewportRef.current);
      }}
      onClickCapture={(e) => {
        // Keep canvas content inert: no link navigation, no form submits.
        const el = (e.target as Element).closest('[data-node-id]');
        if (el) e.preventDefault();
      }}
      onAuxClickCapture={(e) => {
        // Middle-click otherwise bypasses onClick and can open an imported link.
        const el = (e.target as Element).closest('[data-node-id]');
        if (el) e.preventDefault();
      }}
      onSubmitCapture={(e) => {
        // Imported forms are visual content, never live navigation surfaces.
        e.preventDefault();
      }}
      data-canvas-viewport
    >
      <div ref={worldRef} className="ptl-canvas-world">
        {children}
      </div>
      <div className="ptl-canvas-overlay">{overlay}</div>
    </div>
  );
}

export function shouldStartSpacePan(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  ) {
    return false;
  }
  // Page content on the canvas is deliberately inert, so focus left behind by
  // a pointer click there should not disable the canvas pan shortcut.
  if (target.closest('[data-node-id]')) return true;
  return !target.closest(
    'button, a[href], summary, [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="treeitem"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])',
  );
}
