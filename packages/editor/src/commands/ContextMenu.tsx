import { Kbd } from '@pitolet/ui';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const closeOnPointer = () => onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    window.addEventListener('pointerdown', closeOnPointer);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      ref={menuRef}
      className="ptl-context-menu"
      role="menu"
      aria-label="Selection actions"
      style={{
        left: Math.min(state.x, window.innerWidth - 220),
        top: Math.min(state.y, window.innerHeight - 280),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        moveMenuFocus(event, menuRef.current);
      }}
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
            role="menuitem"
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

function moveMenuFocus(event: ReactKeyboardEvent, menu: HTMLDivElement | null): void {
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? current < 0
            ? 0
            : (current + 1) % items.length
          : current <= 0
            ? items.length - 1
            : current - 1;
  items[next]?.focus();
}
