import type { FrameNode } from '@pitolet/schema';
import { AUTO_HEIGHT_FALLBACK, renderedFrameHeight } from '../canvas/frameMeasurements.js';
import { useEditor } from '../store/index.js';

type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

function selectedFrames(): FrameNode[] {
  const s = useEditor.getState();
  return s.selection
    .map((id) => s.doc?.nodes[id])
    .filter((n): n is FrameNode => n?.type === 'frame' && n.parent === null);
}

function frameHeight(frame: FrameNode): number {
  if (frame.canvas.height !== 'auto') return frame.canvas.height;
  return renderedFrameHeight(frame.id) ?? AUTO_HEIGHT_FALLBACK;
}

export function alignFrames(edge: AlignEdge): void {
  const frames = selectedFrames();
  if (frames.length < 2) return;

  const lefts = frames.map((f) => f.canvas.x);
  const rights = frames.map((f) => f.canvas.x + f.canvas.width);
  const tops = frames.map((f) => f.canvas.y);
  const bottoms = frames.map((f, i) => f.canvas.y + frameHeight(frames[i]!));
  const minX = Math.min(...lefts);
  const maxX = Math.max(...rights);
  const minY = Math.min(...tops);
  const maxY = Math.max(...bottoms);

  const heights = new Map(frames.map((f) => [f.id, frameHeight(f)]));
  const ids = frames.map((f) => f.id);

  useEditor.getState().dispatchEdit(`Align ${edge}`, (draft) => {
    for (const id of ids) {
      const node = draft.nodes[id];
      if (node?.type !== 'frame') continue;
      const h = heights.get(id) ?? AUTO_HEIGHT_FALLBACK;
      switch (edge) {
        case 'left':
          node.canvas.x = minX;
          break;
        case 'right':
          node.canvas.x = maxX - node.canvas.width;
          break;
        case 'center':
          node.canvas.x = Math.round(minX + (maxX - minX) / 2 - node.canvas.width / 2);
          break;
        case 'top':
          node.canvas.y = minY;
          break;
        case 'bottom':
          node.canvas.y = maxY - h;
          break;
        case 'middle':
          node.canvas.y = Math.round(minY + (maxY - minY) / 2 - h / 2);
          break;
      }
    }
  });
}

export function distributeFrames(axis: 'horizontal' | 'vertical'): void {
  const frames = selectedFrames();
  if (frames.length < 3) return;

  const heights = new Map(frames.map((f) => [f.id, frameHeight(f)]));
  const sorted = [...frames].sort((a, b) =>
    axis === 'horizontal' ? a.canvas.x - b.canvas.x : a.canvas.y - b.canvas.y,
  );
  const sizes = sorted.map((f) => (axis === 'horizontal' ? f.canvas.width : heights.get(f.id)!));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const start = axis === 'horizontal' ? first.canvas.x : first.canvas.y;
  const end =
    axis === 'horizontal'
      ? last.canvas.x + last.canvas.width
      : last.canvas.y + heights.get(last.id)!;
  const totalSize = sizes.reduce((a, b) => a + b, 0);
  const gap = (end - start - totalSize) / (sorted.length - 1);

  const order = sorted.map((f) => f.id);
  useEditor.getState().dispatchEdit(`Distribute ${axis}`, (draft) => {
    let cursor = start;
    for (const id of order) {
      const node = draft.nodes[id];
      if (node?.type !== 'frame') continue;
      if (axis === 'horizontal') {
        node.canvas.x = Math.round(cursor);
        cursor += node.canvas.width + gap;
      } else {
        node.canvas.y = Math.round(cursor);
        cursor += heights.get(id)! + gap;
      }
    }
  });
}
