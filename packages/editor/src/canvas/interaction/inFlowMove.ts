import { isAncestor, type PitoletDocument, type NodeId } from '@pitolet/schema';
import { componentMasterIdForNode } from '../../store/componentMutations.js';
import { useEditor } from '../../store/index.js';
import { isEffectivelyLocked } from '../../store/locks.js';
import { canNodeContainChildren } from '../../store/nodeSafety.js';
import type { CameraController } from '../CameraController.js';
import {
  clearInteractionCancel,
  setDragging,
  setDropIndicator,
  setInteractionCancel,
  type DropIndicator,
} from './interactionState.js';

const DRAG_SLOP_PX = 4;
interface DropTarget {
  containerId: NodeId;
  index: number;
  indicator: DropIndicator;
}

export function captureElementInlineOpacity(element: HTMLElement): string {
  return element.style.opacity;
}

export function restoreElementInlineOpacity(element: HTMLElement, opacity: string): void {
  element.style.opacity = opacity;
}

/**
 * Drag an in-flow node (a child inside a frame) to reorder within its
 * container or reparent into another. The original dims to 40% opacity, a
 * name chip follows the cursor, and a drop line marks the insertion point
 * along the target container's flex axis. Commit = one patch on release.
 */
export function startInFlowMove(
  e: PointerEvent,
  nodeId: NodeId,
  camera: CameraController,
  viewport: HTMLElement,
): void {
  camera.cancelAnimation();
  const store = useEditor.getState();
  const doc = store.doc;
  const node = doc?.nodes[nodeId];
  if (
    !doc ||
    !node ||
    store.readOnly ||
    !store.connected ||
    store.switchingDocument ||
    node.parent === null ||
    isEffectivelyLocked(doc, nodeId)
  ) {
    return;
  }

  const start = { x: e.clientX, y: e.clientY };
  const sourceEl = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
  const initialInlineOpacity = sourceEl ? captureElementInlineOpacity(sourceEl) : '';
  let started = false;
  let target: DropTarget | null = null;
  let raf = 0;
  let lastEvent = e;

  const onMove = (ev: PointerEvent) => {
    lastEvent = ev;
    if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_SLOP_PX) {
      started = true;
      store.setHover(null);
      setDragging(true, 'reorder');
      if (sourceEl) sourceEl.style.opacity = '0.35';
    }
    if (!started || raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const currentDoc = useEditor.getState().doc;
      if (!currentDoc) return;
      const viewportRect = viewport.getBoundingClientRect();
      target = findDropTarget(currentDoc, nodeId, lastEvent, viewportRect);
      setDropIndicator(target?.indicator ?? null, {
        x: lastEvent.clientX - viewportRect.left + 12,
        y: lastEvent.clientY - viewportRect.top + 12,
        label: node.name,
      });
    });
  };

  const finish = (cancelled: boolean, finalEvent?: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    clearInteractionCancel(cancel);
    if (raf !== 0) cancelAnimationFrame(raf);
    if (started && !cancelled && finalEvent) {
      const currentDoc = useEditor.getState().doc;
      target = currentDoc
        ? findDropTarget(currentDoc, nodeId, finalEvent, viewport.getBoundingClientRect())
        : null;
    }
    if (sourceEl) restoreElementInlineOpacity(sourceEl, initialInlineOpacity);
    setDropIndicator(null, null);
    if (started) {
      setDragging(false);
      if (!cancelled && target) {
        const { containerId, index } = target;
        useEditor.getState().dispatchEdit('Move layer', (draft) => {
          const dragged = draft.nodes[nodeId];
          const oldParent = dragged?.parent ? draft.nodes[dragged.parent] : null;
          const newParent = draft.nodes[containerId];
          if (!dragged || !oldParent || !newParent) return;
          const oldIndex = oldParent.children.indexOf(nodeId);
          if (oldIndex < 0) return;
          oldParent.children.splice(oldIndex, 1);
          let insertAt = index;
          if (oldParent.id === newParent.id && oldIndex < index) insertAt -= 1;
          newParent.children.splice(insertAt, 0, nodeId);
          dragged.parent = containerId;
        });
      }
    }
  };

  const onUp = (ev: PointerEvent) => finish(false, ev);
  const cancel = () => finish(true);

  setInteractionCancel(cancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
}

/**
 * Find the container under the pointer (deepest element/frame that can hold
 * children, excluding the dragged node's subtree) and the insertion index
 * along its layout axis.
 */
function findDropTarget(
  doc: PitoletDocument,
  draggedId: NodeId,
  ev: PointerEvent,
  viewportRect: DOMRect,
): DropTarget | null {
  const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
  const draggedMaster = componentMasterIdForNode(doc, draggedId);
  let containerId: NodeId | null = null;
  let containerEl: Element | null = null;

  for (const el of stack) {
    const id = el.getAttribute('data-node-id');
    if (!id) continue;
    const node = doc.nodes[id];
    if (!node) continue;
    if (id === draggedId || isAncestor(doc.nodes, draggedId, id)) continue;
    if (isEffectivelyLocked(doc, id)) continue;
    const isContainer = canNodeContainChildren(node);
    if (isContainer && componentMasterIdForNode(doc, id) === draggedMaster) {
      containerId = id;
      containerEl = el;
      break;
    }
    // A leaf (text/image): target its parent container instead.
    if (
      node.parent &&
      node.parent !== draggedId &&
      !isEffectivelyLocked(doc, node.parent) &&
      componentMasterIdForNode(doc, node.parent) === draggedMaster &&
      canContainChildren(doc, node.parent)
    ) {
      const parentEl = document.querySelector(`[data-node-id="${node.parent}"]`);
      if (parentEl) {
        containerId = node.parent;
        containerEl = parentEl;
        break;
      }
    }
  }

  if (!containerId || !containerEl) return null;
  const container = doc.nodes[containerId]!;

  const computed = getComputedStyle(containerEl);
  const horizontal = computed.display === 'flex' && computed.flexDirection.startsWith('row');
  const grid = computed.display === 'grid';

  // Insertion index from child midpoints along the flex axis.
  const childRects = container.children
    .filter((id) => id !== draggedId)
    .map((id) => ({
      id,
      rect: document.querySelector(`[data-node-id="${id}"]`)?.getBoundingClientRect() ?? null,
    }))
    .filter((c): c is { id: NodeId; rect: DOMRect } => c.rect !== null);

  let index = childRects.length;
  if (grid) {
    // DOM order for a normal grid is row-major. Compare rows first and then
    // columns so dropping beside a card no longer behaves like one tall list.
    for (let i = 0; i < childRects.length; i++) {
      const rect = childRects[i]!.rect;
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const inSameRow = ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (ev.clientY < midY || (inSameRow && ev.clientX < midX)) {
        index = i;
        break;
      }
    }
  } else {
    for (let i = 0; i < childRects.length; i++) {
      const mid = horizontal
        ? childRects[i]!.rect.left + childRects[i]!.rect.width / 2
        : childRects[i]!.rect.top + childRects[i]!.rect.height / 2;
      const pointer = horizontal ? ev.clientX : ev.clientY;
      if (pointer < mid) {
        index = i;
        break;
      }
    }
  }
  // Map filtered index back to the real children array.
  const realIndex =
    index < childRects.length
      ? container.children.indexOf(childRects[index]!.id)
      : container.children.length;

  const containerRect = containerEl.getBoundingClientRect();
  const indicator = buildIndicator(childRects, index, horizontal, containerRect, viewportRect);
  return { containerId, index: realIndex, indicator };
}

function canContainChildren(doc: PitoletDocument, id: NodeId): boolean {
  return canNodeContainChildren(doc.nodes[id]);
}

function buildIndicator(
  childRects: Array<{ id: NodeId; rect: DOMRect }>,
  index: number,
  horizontal: boolean,
  containerRect: DOMRect,
  viewportRect: DOMRect,
): DropIndicator {
  const toLocal = (r: { x: number; y: number; width: number; height: number }) => ({
    x: r.x - viewportRect.left,
    y: r.y - viewportRect.top,
    width: r.width,
    height: r.height,
  });

  const LINE = 2;
  let line: { x: number; y: number; width: number; height: number };

  if (childRects.length === 0) {
    // Empty container: hint an inset line at the content start.
    line = horizontal
      ? {
          x: containerRect.left + 4,
          y: containerRect.top + 4,
          width: LINE,
          height: containerRect.height - 8,
        }
      : {
          x: containerRect.left + 4,
          y: containerRect.top + 4,
          width: containerRect.width - 8,
          height: LINE,
        };
  } else if (index < childRects.length) {
    const r = childRects[index]!.rect;
    line = horizontal
      ? { x: r.left - 3, y: r.top, width: LINE, height: r.height }
      : { x: r.left, y: r.top - 3, width: r.width, height: LINE };
  } else {
    const r = childRects[childRects.length - 1]!.rect;
    line = horizontal
      ? { x: r.right + 1, y: r.top, width: LINE, height: r.height }
      : { x: r.left, y: r.bottom + 1, width: r.width, height: LINE };
  }

  return {
    ...toLocal(line),
    containerRect: toLocal({
      x: containerRect.left,
      y: containerRect.top,
      width: containerRect.width,
      height: containerRect.height,
    }),
  };
}
