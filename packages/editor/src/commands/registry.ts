import { useEditor } from '../store/index.js';
import { defineComponent } from '../store/componentMutations.js';
import { deleteNodes, duplicateNodes, groupNodes } from '../store/mutations.js';
import { copySelection, pasteFromClipboard } from './clipboard.js';
import { alignFrames, distributeFrames } from './align.js';

export interface CommandContext {
  zoomToFit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomTo100: () => void;
  openPreview: () => void;
}

export interface Command {
  id: string;
  title: string;
  /** tinykeys-style shortcut for display + binding, e.g. "$mod+d". */
  shortcut?: string;
  /** Section in the palette. */
  group: 'edit' | 'view' | 'arrange' | 'create' | 'component';
  when?: () => boolean;
  run: (ctx: CommandContext) => void;
}

const hasSelection = () => useEditor.getState().selection.length > 0;
const hasMultiFrames = () => {
  const s = useEditor.getState();
  return s.selection.filter((id) => s.doc?.nodes[id]?.parent === null).length >= 2;
};

/**
 * The single source of command truth: the palette, keyboard shortcuts, and
 * context menus all render from this list.
 */
export const COMMANDS: Command[] = [
  // --- edit ---
  {
    id: 'undo',
    title: 'Undo',
    shortcut: '$mod+z',
    group: 'edit',
    run: () => useEditor.getState().undo(),
  },
  {
    id: 'redo',
    title: 'Redo',
    shortcut: '$mod+Shift+z',
    group: 'edit',
    run: () => useEditor.getState().redo(),
  },
  {
    id: 'copy',
    title: 'Copy',
    shortcut: '$mod+c',
    group: 'edit',
    when: hasSelection,
    run: () => void copySelection(),
  },
  {
    id: 'paste',
    title: 'Paste',
    shortcut: '$mod+v',
    group: 'edit',
    run: () => void pasteFromClipboard(),
  },
  {
    id: 'duplicate',
    title: 'Duplicate',
    shortcut: '$mod+d',
    group: 'edit',
    when: hasSelection,
    run: () => {
      const store = useEditor.getState();
      const ids = [...store.selection];
      let newIds: string[] = [];
      store.dispatchEdit('Duplicate', (draft) => {
        newIds = duplicateNodes(draft, ids);
      });
      if (newIds.length > 0) store.select(newIds);
    },
  },
  {
    id: 'delete',
    title: 'Delete',
    shortcut: 'Backspace',
    group: 'edit',
    when: hasSelection,
    run: () => {
      const store = useEditor.getState();
      const ids = [...store.selection];
      store.dispatchEdit(ids.length > 1 ? 'Delete nodes' : 'Delete node', (draft) =>
        deleteNodes(draft, ids),
      );
    },
  },
  {
    id: 'group',
    title: 'Group selection',
    shortcut: '$mod+g',
    group: 'edit',
    when: hasSelection,
    run: () => {
      const store = useEditor.getState();
      const ids = [...store.selection];
      let groupId: string | null = null;
      store.dispatchEdit('Group', (draft) => {
        groupId = groupNodes(draft, ids);
      });
      if (groupId) store.select([groupId]);
    },
  },
  // --- component ---
  {
    id: 'create-component',
    title: 'Create component',
    shortcut: '$mod+Alt+k',
    group: 'component',
    when: () => useEditor.getState().selection.length === 1,
    run: () => {
      const store = useEditor.getState();
      const id = store.selection[0]!;
      let instanceId: string | null = null;
      store.dispatchEdit('Create component', (draft) => {
        instanceId = defineComponent(draft, id);
      });
      if (instanceId) store.select([instanceId]);
    },
  },
  // --- create ---
  {
    id: 'tool-select',
    title: 'Select tool',
    shortcut: 'v',
    group: 'create',
    run: () => useEditor.getState().setTool('select'),
  },
  {
    id: 'tool-frame',
    title: 'Frame tool',
    shortcut: 'f',
    group: 'create',
    run: () => useEditor.getState().setTool('frame'),
  },
  {
    id: 'tool-box',
    title: 'Box tool',
    shortcut: 'r',
    group: 'create',
    run: () => useEditor.getState().setTool('element'),
  },
  {
    id: 'tool-text',
    title: 'Text tool',
    shortcut: 't',
    group: 'create',
    run: () => useEditor.getState().setTool('text'),
  },
  // --- arrange ---
  ...(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map(
    (edge): Command => ({
      id: `align-${edge}`,
      title: `Align ${edge}`,
      group: 'arrange',
      when: hasMultiFrames,
      run: () => alignFrames(edge),
    }),
  ),
  {
    id: 'distribute-horizontal',
    title: 'Distribute horizontally',
    group: 'arrange',
    when: hasMultiFrames,
    run: () => distributeFrames('horizontal'),
  },
  {
    id: 'distribute-vertical',
    title: 'Distribute vertically',
    group: 'arrange',
    when: hasMultiFrames,
    run: () => distributeFrames('vertical'),
  },
  // --- view ---
  {
    id: 'toggle-code',
    title: 'Toggle code panel',
    shortcut: '$mod+j',
    group: 'view',
    run: () => {
      const store = useEditor.getState();
      store.setCodePanelOpen(!store.codePanelOpen);
    },
  },
  {
    id: 'preview',
    title: 'Preview frame (real CSS)',
    shortcut: '$mod+Enter',
    group: 'view',
    run: (ctx) => ctx.openPreview(),
  },
  {
    id: 'zoom-fit',
    title: 'Zoom to fit',
    shortcut: 'Shift+1',
    group: 'view',
    run: (ctx) => ctx.zoomToFit(),
  },
  {
    id: 'zoom-100',
    title: 'Zoom to 100%',
    shortcut: '$mod+0',
    group: 'view',
    run: (ctx) => ctx.zoomTo100(),
  },
  {
    id: 'zoom-in',
    title: 'Zoom in',
    shortcut: '$mod+Equal',
    group: 'view',
    run: (ctx) => ctx.zoomIn(),
  },
  {
    id: 'zoom-out',
    title: 'Zoom out',
    shortcut: '$mod+Minus',
    group: 'view',
    run: (ctx) => ctx.zoomOut(),
  },
];

export function runCommand(id: string, ctx: CommandContext): void {
  const command = COMMANDS.find((c) => c.id === id);
  if (command && (!command.when || command.when())) command.run(ctx);
}

/** Display string for a shortcut ("$mod+d" → "mod+d" for the Kbd component). */
export function shortcutKeys(shortcut: string): string {
  return shortcut.replace('$mod', 'mod').replace('Equal', '=').replace('Minus', '-');
}
