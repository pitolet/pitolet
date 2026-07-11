import type { NodeId } from '@pitolet/schema';
import { useEditor } from '../../store/index.js';
import type { CameraController } from '../CameraController.js';
import { startFrameMove } from './frameDrag.js';
import { startInFlowMove } from './inFlowMove.js';
import { setMarquee } from './interactionState.js';
import { resolveClickTarget, resolveDoubleClickTarget } from './selection.js';

/**
 * Select-tool pointer behavior:
 *  - click → deep-select resolution (top level first, descend via dbl-click)
 *  - drag on a root frame → free move (snapping); on an in-flow node → reparent drag
 *  - drag on empty canvas → marquee-select root frames
 *  - double-click text → inline edit; double-click container → descend
 */

export function hitNodeId(e: { target: EventTarget | null }): NodeId | null {
  const el = (e.target as Element | null)?.closest?.('[data-node-id]');
  return el?.getAttribute('data-node-id') ?? null;
}

export function hitFrameLabel(e: { target: EventTarget | null }): NodeId | null {
  const el = (e.target as Element | null)?.closest?.('[data-frame-label]');
  return el?.getAttribute('data-frame-label') ?? null;
}

export function onSelectPointerDown(
  e: PointerEvent,
  camera: CameraController,
  viewport: HTMLElement,
): void {
  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc) return;
  if (store.editingTextId) {
    // Clicking outside the edited text commits (handled by its blur).
    const hit = hitNodeId(e);
    if (hit === store.editingTextId) return;
    store.setEditingText(null);
  }

  const labelFrame = hitFrameLabel(e);
  const rawHit = labelFrame ?? hitNodeId(e);

  if (rawHit) {
    // Frame labels always target the frame itself.
    const targetId = labelFrame ?? resolveClickTarget(doc, rawHit, store.selection);
    let selection: NodeId[];
    if (e.shiftKey) {
      selection = store.selection.includes(targetId)
        ? store.selection.filter((id) => id !== targetId)
        : [...store.selection, targetId];
    } else {
      selection = store.selection.includes(targetId) ? store.selection : [targetId];
    }
    store.select(selection);

    if (!e.shiftKey && selection.includes(targetId)) {
      const targetNode = doc.nodes[targetId];
      if (targetNode?.parent === null) {
        const frameIds = selection.filter((id) => doc.nodes[id]?.parent === null);
        if (frameIds.length > 0) startFrameMove(e, frameIds, camera);
      } else if (targetNode) {
        startInFlowMove(e, targetId, camera, viewport);
      }
    }
    return;
  }

  if (!e.shiftKey) store.select([]);
  startMarquee(e, camera, viewport);
}

export function onSelectDoubleClick(e: MouseEvent): void {
  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc) return;
  const rawHit = hitNodeId(e);
  if (!rawHit) return;
  const target = resolveDoubleClickTarget(doc, rawHit, store.selection);
  const node = doc.nodes[target];
  if (!node) return;
  store.select([target]);
  // Entering text edit mode is a mutation affordance — gate it in read-only.
  if (node.type === 'text' && !store.readOnly) {
    store.setEditingText(target);
  }
}

function startMarquee(e: PointerEvent, camera: CameraController, viewport: HTMLElement): void {
  const viewportRect = viewport.getBoundingClientRect();
  const start = { x: e.clientX - viewportRect.left, y: e.clientY - viewportRect.top };
  const baseSelection = e.shiftKey ? useEditor.getState().selection : [];

  const onMove = (ev: PointerEvent) => {
    const current = { x: ev.clientX - viewportRect.left, y: ev.clientY - viewportRect.top };
    const rect = {
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    };
    setMarquee(rect);

    const worldTL = camera.toWorld({ x: rect.x, y: rect.y });
    const worldBR = camera.toWorld({ x: rect.x + rect.width, y: rect.y + rect.height });
    const doc = useEditor.getState().doc;
    if (!doc) return;
    const hits: NodeId[] = [];
    for (const id of doc.rootOrder) {
      const node = doc.nodes[id];
      if (node?.type !== 'frame' || !node.visible) continue;
      const height =
        node.canvas.height === 'auto'
          ? (document.querySelector(`[data-node-id="${id}"]`)?.getBoundingClientRect().height ??
              0) / camera.zoom
          : node.canvas.height;
      const intersects =
        node.canvas.x < worldBR.x &&
        node.canvas.x + node.canvas.width > worldTL.x &&
        node.canvas.y < worldBR.y &&
        node.canvas.y + height > worldTL.y;
      if (intersects) hits.push(id);
    }
    useEditor.getState().select([...new Set([...baseSelection, ...hits])]);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    setMarquee(null);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export function onSelectPointerMove(e: PointerEvent): void {
  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc) return;
  const rawHit = hitFrameLabel(e) ?? hitNodeId(e);
  store.setHover(rawHit ? resolveClickTarget(doc, rawHit, store.selection) : null);
}
