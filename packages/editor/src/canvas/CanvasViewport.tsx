import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CameraController } from './CameraController.js';
import './CanvasViewport.css';

export interface CanvasViewportProps {
  camera: CameraController;
  children?: ReactNode;
  /** Screen-space overlay content (selection handles, guides…). */
  overlay?: ReactNode;
  /** Pointer-down on canvas content (fires when not panning). */
  onContentPointerDown?: (e: PointerEvent, viewport: HTMLElement) => void;
  /** Pointer-move over canvas content (hover tracking). */
  onContentPointerMove?: (e: PointerEvent) => void;
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
  children,
  overlay,
  onContentPointerDown,
  onContentPointerMove,
  onContentDoubleClick,
  onContentDrop,
  onContentContextMenu,
}: CanvasViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState(false);
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
      gestureStartZoom = camera.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as unknown as { scale: number; clientX: number; clientY: number }).scale;
      const pt = localPoint(e as unknown as { clientX: number; clientY: number });
      camera.zoomAt(pt, (gestureStartZoom * scale) / camera.zoom);
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('gesturestart', onGestureStart);
    viewport.addEventListener('gesturechange', onGestureChange);
    return () => {
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('gesturestart', onGestureStart);
      viewport.removeEventListener('gesturechange', onGestureChange);
      camera.detach();
    };
  }, [camera]);

  // Space key toggles pan mode (ignored while typing in inputs).
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping() && !e.repeat) {
        spaceDown.current = true;
        setPanning(true);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        setPanning(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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
    viewport.setPointerCapture(e.pointerId);
    let last = { x: e.clientX, y: e.clientY };
    const onMove = (ev: PointerEvent) => {
      camera.panBy(ev.clientX - last.x, ev.clientY - last.y);
      last = { x: ev.clientX, y: ev.clientY };
    };
    const onUp = (ev: PointerEvent) => {
      viewport.releasePointerCapture(ev.pointerId);
      viewport.removeEventListener('pointermove', onMove);
      viewport.removeEventListener('pointerup', onUp);
    };
    viewport.addEventListener('pointermove', onMove);
    viewport.addEventListener('pointerup', onUp);
  };

  return (
    <div
      ref={viewportRef}
      className={`ptl-canvas-viewport ${panning ? 'ptl-canvas-viewport--panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (!panning) onContentPointerMove?.(e.nativeEvent);
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
      data-canvas-viewport
    >
      <div ref={worldRef} className="ptl-canvas-world">
        {children}
      </div>
      <div className="ptl-canvas-overlay">{overlay}</div>
    </div>
  );
}
