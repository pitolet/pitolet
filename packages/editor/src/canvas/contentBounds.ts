import type { FrameNode, NodeId, PitoletDocument } from '@pitolet/schema';
import { AUTO_HEIGHT_FALLBACK } from './frameMeasurements.js';

export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_BOUNDS: CanvasBounds = { x: 0, y: 0, width: 1280, height: 800 };

/**
 * Bounds worth framing for normal editing. Component masters live on the
 * same infinite canvas, but should not make the page being edited open as a
 * thumbnail. An explicitly selected root frame always wins.
 */
export function editingContentBounds(
  doc: PitoletDocument | null,
  selection: NodeId[] = [],
  measuredHeight?: (frame: FrameNode) => number | null,
): CanvasBounds {
  if (!doc || doc.rootOrder.length === 0) return DEFAULT_BOUNDS;

  const roots = doc.rootOrder
    .map((id) => doc.nodes[id])
    .filter((node): node is FrameNode => node?.type === 'frame' && node.visible);
  if (roots.length === 0) return DEFAULT_BOUNDS;

  const selected = selection
    .map((id) => doc.nodes[id])
    .filter(
      (node): node is FrameNode => node?.type === 'frame' && node.parent === null && node.visible,
    );
  const normalFrames = roots.filter((frame) => !frame.isComponentMaster);
  const frames = selected.length > 0 ? selected : normalFrames.length > 0 ? normalFrames : roots;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of frames) {
    const height =
      frame.canvas.height === 'auto'
        ? (measuredHeight?.(frame) ?? AUTO_HEIGHT_FALLBACK)
        : frame.canvas.height;
    minX = Math.min(minX, frame.canvas.x);
    minY = Math.min(minY, frame.canvas.y);
    maxX = Math.max(maxX, frame.canvas.x + frame.canvas.width);
    maxY = Math.max(maxY, frame.canvas.y + height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
