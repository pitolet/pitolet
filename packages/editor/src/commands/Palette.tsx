import { Kbd } from '@pitolet/ui';
import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { isTyping } from '../keyboard.js';
import { COMMANDS, shortcutKeys, type CommandContext } from './registry.js';
import './Palette.css';

const GROUP_LABELS: Record<string, string> = {
  edit: 'Edit',
  create: 'Tools',
  component: 'Components',
  arrange: 'Arrange',
  view: 'View',
};

/** ⌘K command palette — every command, searchable. */
export function Palette({ ctx }: { ctx: CommandContext }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.altKey) {
        if (isTyping() && !open) return;
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const groups = [...new Set(COMMANDS.map((c) => c.group))];

  return (
    <div className="ptl-palette-overlay" onPointerDown={() => setOpen(false)}>
      <div onPointerDown={(e) => e.stopPropagation()}>
        <Command className="ptl-palette" label="Commands">
          <Command.Input autoFocus placeholder="Type a command…" className="ptl-palette-input" />
          <Command.List className="ptl-palette-list">
            <Command.Empty className="ptl-palette-empty">No matching commands.</Command.Empty>
            {groups.map((group) => (
              <Command.Group key={group} heading={GROUP_LABELS[group]} className="ptl-palette-group">
                {COMMANDS.filter((c) => c.group === group).map((command) => {
                  const enabled = !command.when || command.when();
                  return (
                    <Command.Item
                      key={command.id}
                      disabled={!enabled}
                      onSelect={() => {
                        setOpen(false);
                        command.run(ctx);
                      }}
                      className="ptl-palette-item"
                    >
                      <span>{command.title}</span>
                      {command.shortcut && <Kbd keys={shortcutKeys(command.shortcut)} />}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
