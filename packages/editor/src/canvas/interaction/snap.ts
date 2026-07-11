import type { PitoletDocument, NodeId } from '@pitolet/schema';
import type { CameraController } from '../CameraController.js';
import type { SnapGuide } from './interactionState.js';

const SNAP_THRESHOLD_SCREEN_PX = 8;

interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Edge/center snapping for frame drags. Candidate lines come from the other
 * root frames' bounds (schema-known — no DOM measurement). Returns a
 * corrected delta plus viewport-space guide lines to draw.
 */
export function snapFrameDelta(
  doc: PitoletDocument,
  draggedIds: NodeId[],
  rawDx: number,
  rawDy: number,
  camera: CameraController,
  frameHeights: (id: NodeId) => number,
): SnapResult {
  const threshold = SNAP_THRESHOLD_SCREEN_PX / camera.zoom;

  const moving = boundsOf(doc, draggedIds, frameHeights);
  if (!moving) return { dx: rawDx, dy: rawDy, guides: [] };
  const movingNow: WorldRect = { ...moving, x: moving.x + rawDx, y: moving.y + rawDy };

  const targets: WorldRect[] = [];
  for (const id of doc.rootOrder) {
    if (draggedIds.includes(id)) continue;
    const node = doc.nodes[id];
    if (node?.type !== 'frame' || !node.visible) continue;
    targets.push({
      x: node.canvas.x,
      y: node.canvas.y,
      width: node.canvas.width,
      height: frameHeights(id),
    });
  }
  if (targets.length === 0) return { dx: rawDx, dy: rawDy, guides: [] };

  let bestX: { snap: number; delta: number; target: WorldRect } | null = null;
  let bestY: { snap: number; delta: number; target: WorldRect } | null = null;

  const movingXs = [movingNow.x, movingNow.x + movingNow.width / 2, movingNow.x + movingNow.width];
  const movingYs = [movingNow.y, movingNow.y + movingNow.height / 2, movingNow.y + movingNow.height];

  for (const target of targets) {
    const targetXs = [target.x, target.x + target.width / 2, target.x + target.width];
    const targetYs = [target.y, target.y + target.height / 2, target.y + target.height];
    for (const mx of movingXs) {
      for (const tx of targetXs) {
        const delta = tx - mx;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
          bestX = { snap: tx, delta, target };
        }
      }
    }
    for (const my of movingYs) {
      for (const ty of targetYs) {
        const delta = ty - my;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
          bestY = { snap: ty, delta, target };
        }
      }
    }
  }

  const dx = rawDx + (bestX?.delta ?? 0);
  const dy = rawDy + (bestY?.delta ?? 0);

  const guides: SnapGuide[] = [];
  if (bestX) {
    const top = Math.min(movingNow.y, bestX.target.y);
    const bottom = Math.max(movingNow.y + movingNow.height, bestX.target.y + bestX.target.height);
    const p1 = camera.toScreen({ x: bestX.snap, y: top });
    const p2 = camera.toScreen({ x: bestX.snap, y: bottom });
    guides.push({ axis: 'x', position: p1.x, start: p1.y, end: p2.y });
  }
  if (bestY) {
    const left = Math.min(movingNow.x, bestY.target.x);
    const right = Math.max(movingNow.x + movingNow.width, bestY.target.x + bestY.target.width);
    const p1 = camera.toScreen({ x: left, y: bestY.snap });
    const p2 = camera.toScreen({ x: right, y: bestY.snap });
    guides.push({ axis: 'y', position: p1.y, start: p1.x, end: p2.x });
  }

  return { dx, dy, guides };
}

function boundsOf(
  doc: PitoletDocument,
  ids: NodeId[],
  frameHeights: (id: NodeId) => number,
): WorldRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const node = doc.nodes[id];
    if (node?.type !== 'frame') continue;
    minX = Math.min(minX, node.canvas.x);
    minY = Math.min(minY, node.canvas.y);
    maxX = Math.max(maxX, node.canvas.x + node.canvas.width);
    maxY = Math.max(maxY, node.canvas.y + frameHeights(id));
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
