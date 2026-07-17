import type { NodeId } from '@pitolet/schema';
import { useEditor } from '../../store/index.js';
import { closestUnlockedAncestor, isEffectivelyLocked } from '../../store/locks.js';
import type { CameraController } from '../CameraController.js';
import { startFrameMove } from './frameDrag.js';
import { startInFlowMove } from './inFlowMove.js';
import {
  clearInteractionCancel,
  interactionState,
  setDragging,
  setInteractionCancel,
  setMarquee,
} from './interactionState.js';
import { marqueeContains } from './marquee.js';
import {
  resolveClickTarget,
  resolveDirectClickTarget,
  resolveDoubleClickTarget,
} from './selection.js';

const MARQUEE_SLOP_PX = 4;

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
  camera.cancelAnimation();
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
    const directSelect = e.metaKey || e.ctrlKey;
    const resolvedTarget =
      labelFrame ??
      (directSelect
        ? resolveDirectClickTarget(doc, rawHit)
        : resolveClickTarget(doc, rawHit, store.selection));
    const targetId = closestUnlockedAncestor(doc, resolvedTarget);
    if (!targetId) return;
    let selection: NodeId[];
    if (e.shiftKey) {
      selection = store.selection.includes(targetId)
        ? store.selection.filter((id) => id !== targetId)
        : [...store.selection, targetId];
    } else {
      selection = store.selection.includes(targetId) ? store.selection : [targetId];
    }
    store.select(selection);

    if (!store.readOnly && !e.shiftKey && selection.includes(targetId)) {
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

  const previousSelection = store.selection;
  if (!e.shiftKey) store.select([]);
  startMarquee(e, viewport, previousSelection);
}

export function onSelectDoubleClick(e: MouseEvent): void {
  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc) return;
  const rawHit = hitNodeId(e);
  if (!rawHit) return;
  const target = resolveDoubleClickTarget(doc, rawHit, store.selection);
  if (isEffectivelyLocked(doc, target)) return;
  const node = doc.nodes[target];
  if (!node) return;
  store.select([target]);
  // Entering text edit mode is a mutation affordance — gate it in read-only.
  if (node.type === 'text' && !store.readOnly && store.connected && !store.switchingDocument) {
    store.setEditingText(target);
  }
}

function startMarquee(e: PointerEvent, viewport: HTMLElement, previousSelection: NodeId[]): void {
  const viewportRect = viewport.getBoundingClientRect();
  const start = { x: e.clientX - viewportRect.left, y: e.clientY - viewportRect.top };
  const baseSelection = e.shiftKey ? previousSelection : [];
  let started = false;

  const onMove = (ev: PointerEvent) => {
    const current = { x: ev.clientX - viewportRect.left, y: ev.clientY - viewportRect.top };
    if (!started && Math.hypot(current.x - start.x, current.y - start.y) <= MARQUEE_SLOP_PX) {
      return;
    }
    if (!started) {
      started = true;
      setDragging(true, 'marquee');
    }
    const rect = {
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    };
    setMarquee(rect);

    const doc = useEditor.getState().doc;
    if (!doc) return;
    const selectionRect = {
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    };
    const crossing = current.x < start.x;
    const hits: NodeId[] = [];
    for (const id of doc.rootOrder) {
      const node = doc.nodes[id];
      if (node?.type !== 'frame' || !node.visible || isEffectivelyLocked(doc, id)) continue;
      const element = document.querySelector(`[data-node-id="${id}"]`);
      if (!element) continue;
      const bounds = element.getBoundingClientRect();
      const candidate = {
        left: bounds.left - viewportRect.left,
        top: bounds.top - viewportRect.top,
        right: bounds.right - viewportRect.left,
        bottom: bounds.bottom - viewportRect.top,
      };
      if (marqueeContains(selectionRect, candidate, crossing)) hits.push(id);
    }
    useEditor.getState().select([...new Set([...baseSelection, ...hits])]);
  };

  const finish = (cancelled: boolean) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    clearInteractionCancel(cancel);
    setMarquee(null);
    if (started) setDragging(false);
    if (cancelled) useEditor.getState().select(previousSelection);
  };

  const onUp = () => finish(false);
  const cancel = () => finish(true);

  setInteractionCancel(cancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
}

export function onSelectPointerMove(e: PointerEvent): void {
  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc) return;
  if (interactionState.dragging) return;
  const rawHit = hitFrameLabel(e) ?? hitNodeId(e);
  const resolved = rawHit ? resolveClickTarget(doc, rawHit, store.selection) : null;
  store.setHover(resolved ? closestUnlockedAncestor(doc, resolved) : null);
}
