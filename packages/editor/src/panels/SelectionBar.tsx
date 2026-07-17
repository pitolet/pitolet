import type { NodeId, PitoletDocument, PitoletNode } from '@pitolet/schema';
import { Tooltip } from '@pitolet/ui';
import {
  ChevronRight,
  CopyPlus,
  Eye,
  EyeOff,
  Group,
  LocateFixed,
  Lock,
  LockOpen,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { getSelectionActionState } from '../commands/selectionActions.js';
import { setNodeVisibility } from '../store/componentMutations.js';
import { useEditor, type EditingVariant } from '../store/index.js';
import { deleteNodes, duplicateNodes, groupNodes } from '../store/mutations.js';
import './SelectionBar.css';

export function SelectionBar({ onFocusSelection }: { onFocusSelection: () => void }) {
  const doc = useEditor((state) => state.doc);
  const selection = useEditor((state) => state.selection);
  const readOnly = useEditor((state) => state.readOnly);
  const connected = useEditor((state) => state.connected && !state.switchingDocument);
  const editingVariant = useEditor((state) => state.editingVariant);

  if (!doc) return null;

  if (selection.length === 0) {
    return (
      <div className="ptl-selection-bar">
        <span className="ptl-selection-empty">Nothing selected</span>
        <span className="ptl-selection-hint">
          Press {commandPaletteShortcut()} for quick actions
        </span>
      </div>
    );
  }

  if (selection.length > 1) {
    return (
      <div className="ptl-selection-bar">
        <span className="ptl-selection-count">{selection.length} layers selected</span>
        {!readOnly && (
          <SelectionActions
            doc={doc}
            selection={selection}
            connected={connected}
            editingVariant={editingVariant}
            compact
          />
        )}
        <FocusButton onClick={onFocusSelection} />
      </div>
    );
  }

  const path = selectionPath(doc, selection[0]!);
  return (
    <div className="ptl-selection-bar">
      <nav className="ptl-selection-path" aria-label="Selected layer path">
        {path.map((node, index) => (
          <span key={node.id} className="ptl-selection-path-part">
            {index > 0 && <ChevronRight size={11} aria-hidden />}
            <button
              type="button"
              className={`ptl-selection-crumb ${index === path.length - 1 ? 'ptl-selection-crumb--current' : ''}`}
              title={node.name}
              aria-current={index === path.length - 1 ? 'page' : undefined}
              onClick={() => useEditor.getState().select([node.id])}
              onPointerEnter={() => useEditor.getState().setHover(node.id)}
              onPointerLeave={() => useEditor.getState().setHover(null)}
            >
              {node.name}
            </button>
          </span>
        ))}
      </nav>
      {!readOnly && (
        <SelectionActions
          doc={doc}
          selection={selection}
          connected={connected}
          editingVariant={editingVariant}
        />
      )}
      <FocusButton onClick={onFocusSelection} />
    </div>
  );
}

function SelectionActions({
  doc,
  selection,
  connected,
  editingVariant,
  compact = false,
}: {
  doc: PitoletDocument;
  selection: NodeId[];
  connected: boolean;
  editingVariant: EditingVariant | null;
  compact?: boolean;
}) {
  const state = getSelectionActionState(doc, selection, editingVariant);
  const canChangeState = connected && state.hasSelection;

  const duplicate = () => {
    const store = useEditor.getState();
    const ids = [...store.selection];
    let newIds: NodeId[] = [];
    store.dispatchEdit(ids.length > 1 ? 'Duplicate layers' : 'Duplicate', (draft) => {
      newIds = duplicateNodes(draft, ids);
    });
    if (newIds.length > 0) store.select(newIds);
  };

  const group = () => {
    const store = useEditor.getState();
    const ids = [...store.selection];
    let groupId: NodeId | null = null;
    store.dispatchEdit('Group', (draft) => {
      groupId = groupNodes(draft, ids);
    });
    if (groupId) store.select([groupId]);
  };

  const toggleLock = () => {
    const nextLocked = !state.allLocked;
    useEditor
      .getState()
      .dispatchEdit(nextLocked ? 'Lock selection' : 'Unlock selection', (draft) => {
        selection.forEach((id) => {
          const node = draft.nodes[id];
          if (node) node.locked = nextLocked;
        });
      });
  };

  const toggleVisibility = () => {
    const nextVisible = state.allHidden;
    useEditor
      .getState()
      .dispatchEdit(nextVisible ? 'Show selection' : 'Hide selection', (draft) => {
        selection.forEach((id) => {
          setNodeVisibility(draft, id, nextVisible, editingVariant);
        });
      });
  };

  const remove = () => {
    const store = useEditor.getState();
    const ids = [...store.selection];
    store.dispatchEdit(ids.length > 1 ? 'Delete layers' : 'Delete', (draft) => {
      deleteNodes(draft, ids);
    });
  };

  return (
    <div className="ptl-selection-actions" aria-label="Selection actions">
      <SelectionActionButton
        label={
          state.containsComponentMaster
            ? 'Component masters cannot be duplicated here'
            : selection.length > 1
              ? 'Duplicate layers'
              : 'Duplicate layer'
        }
        shortcut="mod+d"
        disabled={!connected || !state.canDuplicate}
        onClick={duplicate}
      >
        <CopyPlus size={13} />
      </SelectionActionButton>
      {compact && (
        <SelectionActionButton
          label={state.canGroup ? 'Group layers' : 'Group requires unlocked sibling layers'}
          shortcut="mod+g"
          disabled={!connected || !state.canGroup}
          onClick={group}
        >
          <Group size={13} />
        </SelectionActionButton>
      )}
      <span className="ptl-selection-action-separator" aria-hidden />
      <SelectionActionButton
        label={state.allLocked ? 'Unlock selection' : 'Lock selection'}
        disabled={!canChangeState}
        pressed={state.allLocked}
        onClick={toggleLock}
      >
        {state.allLocked ? <LockOpen size={13} /> : <Lock size={13} />}
      </SelectionActionButton>
      <SelectionActionButton
        label={state.allHidden ? 'Show selection' : 'Hide selection'}
        disabled={!canChangeState}
        pressed={state.allHidden}
        onClick={toggleVisibility}
      >
        {state.allHidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </SelectionActionButton>
      <SelectionActionButton
        label={
          state.containsComponentMaster
            ? 'Component masters cannot be deleted here'
            : state.containsComponentContentRoot
              ? 'The component root cannot be deleted'
              : selection.length > 1
                ? 'Delete layers'
                : 'Delete layer'
        }
        shortcut="backspace"
        disabled={!connected || !state.canDelete}
        danger
        onClick={remove}
      >
        <Trash2 size={13} />
      </SelectionActionButton>
    </div>
  );
}

function SelectionActionButton({
  label,
  shortcut,
  disabled = false,
  pressed,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        className={[
          'ptl-selection-action',
          pressed ? 'ptl-selection-action--active' : '',
          danger ? 'ptl-selection-action--danger' : '',
        ].join(' ')}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function FocusButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Focus selection" shortcut="shift+2">
      <button
        type="button"
        className="ptl-selection-focus"
        aria-label="Focus selection"
        onClick={onClick}
      >
        <LocateFixed size={13} />
      </button>
    </Tooltip>
  );
}

export function selectionPath(doc: PitoletDocument, id: NodeId): PitoletNode[] {
  const path: PitoletNode[] = [];
  let current: NodeId | null = id;
  while (current) {
    const node: PitoletNode | undefined = doc.nodes[current];
    if (!node) break;
    path.unshift(node);
    current = node.parent;
  }
  return path;
}

function commandPaletteShortcut(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
}
