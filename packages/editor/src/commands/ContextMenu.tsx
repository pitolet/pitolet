import { Kbd } from '@pitolet/ui';
import { useEffect } from 'react';
import { COMMANDS, shortcutKeys, type CommandContext } from './registry.js';
import './ContextMenu.css';

const MENU_COMMANDS = [
  'copy',
  'paste',
  'duplicate',
  'delete',
  '—',
  'group',
  'create-component',
  '—',
  'preview',
] as const;

export interface ContextMenuState {
  x: number;
  y: number;
}

export function ContextMenu({
  state,
  ctx,
  onClose,
}: {
  state: ContextMenuState | null;
  ctx: CommandContext;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      className="ptl-context-menu"
      style={{
        left: Math.min(state.x, window.innerWidth - 220),
        top: Math.min(state.y, window.innerHeight - 280),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {MENU_COMMANDS.map((id, i) => {
        if (id === '—') return <div key={`sep${i}`} className="ptl-context-sep-line" />;
        const command = COMMANDS.find((c) => c.id === id);
        if (!command) return null;
        const enabled = !command.when || command.when();
        return (
          <button
            key={id}
            type="button"
            className="ptl-context-item"
            disabled={!enabled}
            onClick={() => {
              onClose();
              command.run(ctx);
            }}
          >
            <span>{command.title}</span>
            {command.shortcut && <Kbd keys={shortcutKeys(command.shortcut)} />}
          </button>
        );
      })}
    </div>
  );
}
