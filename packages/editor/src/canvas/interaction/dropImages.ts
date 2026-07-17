import { createImage, newId, px, type PitoletDocument, type NodeId } from '@pitolet/schema';
import { useEditor } from '../../store/index.js';
import { closestUnlockedAncestor } from '../../store/locks.js';
import { nearestChildContainer } from '../../store/nodeSafety.js';
import { apiUrl } from '../../sync/serverBase.js';
import type { CameraController } from '../CameraController.js';
import { hitNodeId } from './selectTool.js';

/**
 * Drop image files onto the canvas: upload to the asset store, then insert
 * an image node into the container under the pointer (or a fresh frame on
 * empty canvas), sized to natural dimensions (capped).
 */
export async function handleImageDrop(
  e: DragEvent,
  camera: CameraController,
  viewport: HTMLElement,
): Promise<void> {
  const initialStore = useEditor.getState();
  if (
    initialStore.readOnly ||
    !initialStore.connected ||
    initialStore.switchingDocument ||
    !initialStore.doc
  ) {
    if (!initialStore.readOnly) {
      initialStore.setSyncIssue('Editing is paused until Pitolet reconnects.');
    }
    return;
  }
  const documentId = initialStore.doc.id;
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  e.preventDefault();
  camera.cancelAnimation();
  const viewportRect = viewport.getBoundingClientRect();
  const dropWorld = camera.toWorld({
    x: e.clientX - viewportRect.left,
    y: e.clientY - viewportRect.top,
  });
  const dropHitId = hitNodeId(e);

  for (const [fileIndex, file] of files.entries()) {
    try {
      const res = await fetch(apiUrl('/api/assets'), {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      const { assetId } = (await res.json()) as { assetId: string };
      const { width, height } = await imageSize(file);

      const store = useEditor.getState();
      const doc = store.doc;
      if (
        !doc ||
        doc.id !== documentId ||
        store.readOnly ||
        !store.connected ||
        store.switchingDocument
      ) {
        return;
      }

      const maxSide = 480;
      const scale = Math.min(1, maxSide / Math.max(width, height, 1));
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);

      const node = createImage({
        name: file.name.replace(/\.[a-z0-9]+$/i, ''),
        src: { asset: assetId },
        alt: file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '),
        styles: { width: px(w), height: px(h), objectFit: 'cover' },
      });

      const hit = dropHitId && doc.nodes[dropHitId] ? dropHitId : null;
      const unlockedHit = hit ? closestUnlockedAncestor(doc, hit) : null;
      if (hit && !unlockedHit) continue;
      const containerId = unlockedHit ? nearestChildContainer(doc, unlockedHit) : null;

      store.dispatchEdit('Insert image', (draft) => {
        draft.nodes[node.id] = node;
        if (containerId) {
          node.parent = containerId;
          draft.nodes[containerId]!.children.push(node.id);
          // Register asset metadata on the document.
          draft.assets[assetId] = { fileName: file.name, width, height, mime: file.type };
        } else {
          // Wrap in an auto frame at the drop point.
          const offset = fileIndex * 24;
          const wrapper = createImageFrame(draft, dropWorld.x + offset, dropWorld.y + offset, w, h);
          node.parent = wrapper;
          draft.nodes[wrapper]!.children.push(node.id);
          draft.assets[assetId] = { fileName: file.name, width, height, mime: file.type };
        }
      });
      if (useEditor.getState().doc?.nodes[node.id]) store.select([node.id]);
    } catch (err) {
      console.error('[pitolet] image drop failed:', err);
      useEditor
        .getState()
        .setSyncIssue(`Couldn’t add ${file.name || 'that image'}. Check the file and try again.`);
    }
  }
}

function createImageFrame(
  draft: { nodes: PitoletDocument['nodes']; rootOrder: NodeId[] },
  x: number,
  y: number,
  w: number,
  h: number,
): NodeId {
  const id = newId();
  draft.nodes[id] = {
    id,
    type: 'frame',
    name: 'Image',
    parent: null,
    children: [],
    tag: 'div',
    visible: true,
    locked: false,
    canvas: { x: Math.round(x), y: Math.round(y), width: w, height: h },
    styles: { base: { display: 'flex' } },
  };
  draft.rootOrder.push(id);
  return id;
}

function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 320, height: 240 });
    };
    img.src = url;
  });
}
