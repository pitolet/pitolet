import { tinykeys } from 'tinykeys';
import { parentOfSelection } from './canvas/interaction/selection.js';
import type { CameraController } from './canvas/CameraController.js';
import { COMMANDS, type CommandContext } from './commands/registry.js';
import { useEditor } from './store/index.js';
import { moveFrames } from './store/mutations.js';

/**
 * Keyboard layer: registry commands bind via tinykeys; positional keys
 * (arrow nudging, Escape ascent) stay hand-rolled. Everything is gated off
 * while typing in inputs or contentEditable.
 */
export function installKeyboard(camera: CameraController, zoomToFit: () => void): () => void {
  const ctx: CommandContext = {
    zoomToFit,
    zoomIn: () => camera.setZoomCentered(camera.zoom * 1.25),
    zoomOut: () => camera.setZoomCentered(camera.zoom / 1.25),
    zoomTo100: () => camera.setZoomCentered(1),
    openPreview: () => void import('./panels/TopBar.js').then((m) => m.openPreview()),
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
    if (isTyping()) return;
    const store = useEditor.getState();

    if (e.key === 'Escape') {
      if (store.editingContext.state || store.editingContext.breakpointId) {
        store.setEditingContext({ breakpointId: null, state: null });
        return;
      }
      const parent = store.doc ? parentOfSelection(store.doc, store.selection) : null;
      store.select(parent ? [parent] : []);
      return;
    }

    if (e.key.startsWith('Arrow') && store.selection.length > 0 && !e.metaKey && !e.ctrlKey) {
      const frames = store.selection.filter((id) => store.doc?.nodes[id]?.parent === null);
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
