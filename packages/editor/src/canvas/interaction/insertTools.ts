import {
  createElement as createElementNode,
  createFrame,
  createText,
  px,
  type PitoletDocument,
} from '@pitolet/schema';
import { useEditor, type Tool } from '../../store/index.js';
import { closestUnlockedAncestor } from '../../store/locks.js';
import { nearestChildContainer } from '../../store/nodeSafety.js';
import type { CameraController } from '../CameraController.js';
import {
  clearInteractionCancel,
  setDragging,
  setInteractionCancel,
  setMarquee,
} from './interactionState.js';
import { hitNodeId } from './selectTool.js';

const DRAW_SLOP_PX = 4;

/**
 * Insert tools:
 *  - frame: drag a rect on empty canvas (click = default size)
 *  - text / element: click inside a container to append there; click on
 *    empty canvas to create an auto-height frame holding the new node
 * After inserting, the tool returns to select and the new node is selected.
 */
export function onInsertPointerDown(
  e: PointerEvent,
  tool: Tool,
  camera: CameraController,
  viewport: HTMLElement,
): void {
  camera.cancelAnimation();
  // Read-only: insertion is fully inert (dispatchEdit no-ops anyway, and the
  // insert tools are hidden in the TopBar — this guards any stray entry).
  const session = useEditor.getState();
  if (session.readOnly || !session.connected || session.switchingDocument) {
    if (!session.readOnly) session.setSyncIssue('Editing is paused until Pitolet reconnects.');
    return;
  }
  if (tool === 'frame') {
    drawFrame(e, camera, viewport);
    return;
  }
  insertLeaf(e, tool, camera);
}

function drawFrame(e: PointerEvent, camera: CameraController, viewport: HTMLElement): void {
  const viewportRect = viewport.getBoundingClientRect();
  const startScreen = { x: e.clientX - viewportRect.left, y: e.clientY - viewportRect.top };
  const startWorld = camera.toWorld(startScreen);
  let moved = false;
  let endWorld = startWorld;

  const onMove = (ev: PointerEvent) => {
    const screen = { x: ev.clientX - viewportRect.left, y: ev.clientY - viewportRect.top };
    if (!moved && Math.hypot(screen.x - startScreen.x, screen.y - startScreen.y) <= DRAW_SLOP_PX) {
      return;
    }
    if (!moved) setDragging(true, 'draw');
    endWorld = camera.toWorld(screen);
    moved = true;
    setMarquee({
      x: Math.min(startScreen.x, screen.x),
      y: Math.min(startScreen.y, screen.y),
      width: Math.abs(screen.x - startScreen.x),
      height: Math.abs(screen.y - startScreen.y),
    });
  };

  const finish = (cancelled: boolean, ev?: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    clearInteractionCancel(cancel);
    if (moved && ev) {
      const screen = { x: ev.clientX - viewportRect.left, y: ev.clientY - viewportRect.top };
      endWorld = camera.toWorld(screen);
    }
    setMarquee(null);
    if (moved) setDragging(false);
    if (cancelled) return;
    const store = useEditor.getState();
    if (store.readOnly || !store.connected || store.switchingDocument) return;

    const width = moved ? Math.max(16, Math.abs(endWorld.x - startWorld.x)) : 1280;
    const height = moved ? Math.max(16, Math.abs(endWorld.y - startWorld.y)) : 800;
    const x = moved ? Math.min(startWorld.x, endWorld.x) : startWorld.x;
    const y = moved ? Math.min(startWorld.y, endWorld.y) : startWorld.y;

    const frame = createFrame({
      name: nextFrameName(store.doc),
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    store.dispatchEdit('Draw frame', (draft) => {
      draft.nodes[frame.id] = frame;
      draft.rootOrder.push(frame.id);
    });
    store.select([frame.id]);
    store.setTool('select');
  };

  const onUp = (ev: PointerEvent) => finish(false, ev);
  const cancel = () => finish(true);

  setInteractionCancel(cancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
}

function insertLeaf(e: PointerEvent, tool: Tool, camera: CameraController): void {
  const store = useEditor.getState();
  const doc = store.doc;
  if (!doc || store.readOnly || !store.connected || store.switchingDocument) return;

  const newNode =
    tool === 'text'
      ? createText({ text: 'Text', styles: { fontSize: { $token: 'typography.fontSize.base' } } })
      : createElementNode({
          name: 'Box',
          styles: {
            width: px(160),
            height: px(100),
            fills: [{ type: 'solid', color: { $token: 'color.muted' } }],
            radius: {
              tl: { $token: 'radius.md' },
              tr: { $token: 'radius.md' },
              br: { $token: 'radius.md' },
              bl: { $token: 'radius.md' },
            },
          },
        });

  const hit = hitNodeId(e);
  const unlockedHit = hit ? closestUnlockedAncestor(doc, hit) : null;
  if (hit && !unlockedHit) return;
  const containerId = unlockedHit ? nearestChildContainer(doc, unlockedHit) : null;

  if (containerId) {
    store.dispatchEdit(tool === 'text' ? 'Insert text' : 'Insert box', (draft) => {
      newNode.parent = containerId;
      draft.nodes[newNode.id] = newNode;
      draft.nodes[containerId]!.children.push(newNode.id);
    });
  } else {
    // Empty canvas: wrap in a fresh auto-height frame at the click point.
    const world = camera.toWorld({
      x:
        e.clientX -
        (e.target as Element).closest('[data-canvas-viewport]')!.getBoundingClientRect().left,
      y:
        e.clientY -
        (e.target as Element).closest('[data-canvas-viewport]')!.getBoundingClientRect().top,
    });
    const frame = createFrame({
      name: nextFrameName(doc),
      x: Math.round(world.x),
      y: Math.round(world.y),
      width: 400,
      height: 'auto',
      styles: { padding: sidesToken('4') },
    });
    store.dispatchEdit(tool === 'text' ? 'Insert text' : 'Insert box', (draft) => {
      draft.nodes[frame.id] = frame;
      draft.rootOrder.push(frame.id);
      newNode.parent = frame.id;
      draft.nodes[newNode.id] = newNode;
      draft.nodes[frame.id]!.children.push(newNode.id);
    });
  }

  if (!useEditor.getState().doc?.nodes[newNode.id]) return;
  store.select([newNode.id]);
  store.setTool('select');
  if (tool === 'text') store.setEditingText(newNode.id);
}

function nextFrameName(doc: PitoletDocument | null): string {
  const count = doc ? doc.rootOrder.length + 1 : 1;
  return `Frame ${count}`;
}

function sidesToken(name: string) {
  const t = { $token: `spacing.${name}` };
  return { top: t, right: t, bottom: t, left: t };
}
