import type { NodeId } from '@pitolet/schema';

export const AUTO_HEIGHT_FALLBACK = 600;

/** Camera zoom as exposed by the canvas viewport CSS custom property. */
export function currentCanvasZoom(): number {
  if (typeof document === 'undefined') return 1;
  const viewport = document.querySelector<HTMLElement>('[data-canvas-viewport]');
  if (!viewport) return 1;
  return Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--cam-zoom')) || 1;
}

/** Measured world-space height of a rendered frame, or null when it is not measurable. */
export function renderedFrameHeight(frameId: NodeId, zoom = currentCanvasZoom()): number | null {
  if (typeof document === 'undefined') return null;
  const element = document.querySelector<HTMLElement>(`[data-node-id="${frameId}"]`);
  if (!element) return null;
  const height = element.getBoundingClientRect().height / Math.max(zoom, 0.0001);
  return Number.isFinite(height) && height > 0 ? height : null;
}
