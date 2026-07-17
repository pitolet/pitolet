import { tinykeys } from 'tinykeys';
import { parentOfSelection } from './canvas/interaction/selection.js';
import { cancelActiveInteraction } from './canvas/interaction/interactionState.js';
import type { CameraController } from './canvas/CameraController.js';
import { COMMANDS, type CommandContext } from './commands/registry.js';
import { useEditor } from './store/index.js';
import { isEffectivelyLocked } from './store/locks.js';
import { moveFrames } from './store/mutations.js';
import { openPreview } from './panels/TopBar.js';

/**
 * Keyboard layer: registry commands bind via tinykeys; positional keys
 * (arrow nudging and Escape's cancel/tool/ascent sequence) stay hand-rolled. Everything is gated off
 * while typing in inputs or contentEditable.
 */
export function installKeyboard(
  camera: CameraController,
  zoomToFit: () => void,
  zoomToSelection: () => void,
): () => void {
  const ctx: CommandContext = {
    zoomToFit,
    zoomToSelection,
    zoomIn: () => camera.setZoomCentered(camera.zoom * 1.25),
    zoomOut: () => camera.setZoomCentered(camera.zoom / 1.25),
    zoomTo100: () => camera.setZoomCentered(1),
    openPreview,
  };

  const bindings: Record<string, (e: KeyboardEvent) => void> = {};
  for (const command of COMMANDS) {
    if (!command.shortcut) continue;
    bindings[command.shortcut] = (e) => {
      if (isTyping()) return;
      e.preventDefault();
      if (!command.when || command.when()) command.run(ctx);
    };
  }
  // Delete key aliases the Backspace command.
  bindings['Delete'] = bindings['Backspace']!;

  const unsubscribeTinykeys = tinykeys(window, bindings);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isTyping()) return;
    const store = useEditor.getState();

    if (e.key === 'Escape') {
      if (cancelActiveInteraction()) {
        e.preventDefault();
        if (store.activeTool !== 'select') store.setTool('select');
        return;
      }
      if (store.activeTool !== 'select') {
        e.preventDefault();
        store.setTool('select');
        return;
      }
      if (store.editingContext.state || store.editingContext.breakpointId) {
        e.preventDefault();
        store.setEditingContext({ breakpointId: null, state: null });
        return;
      }
      const parent = store.doc ? parentOfSelection(store.doc, store.selection) : null;
      e.preventDefault();
      store.select(parent ? [parent] : []);
      return;
    }

    if (
      e.key.startsWith('Arrow') &&
      store.selection.length > 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      store.connected &&
      !store.readOnly &&
      !store.switchingDocument
    ) {
      const frames = store.selection.filter(
        (id) =>
          store.doc?.nodes[id]?.parent === null &&
          store.doc !== null &&
          !isEffectivelyLocked(store.doc, id),
      );
      if (frames.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        store.dispatchEdit('Nudge', (draft) => moveFrames(draft, frames, dx, dy), {
          coalesceKey: 'nudge',
        });
      }
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => {
    unsubscribeTinykeys();
    window.removeEventListener('keydown', onKeyDown);
  };
}

export function isTyping(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}
