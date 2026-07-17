import { Button, Input, Popover } from '@pitolet/ui';
import type { PitoletDocument } from '@pitolet/schema';
import { Component, Copy, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  canDefineComponent,
  componentInsertionTarget,
  componentMasterIdForNode,
  defineComponent,
  deleteComponent,
  duplicateComponent,
  insertInstance,
  renameComponent,
} from '../store/componentMutations.js';
import { useEditor } from '../store/index.js';
import { isEffectivelyLocked } from '../store/locks.js';
import './ComponentsPanel.css';

/** Component library with creation, management, insertion, and master navigation. */
export function ComponentsPanel() {
  const { doc, selection, connected, readOnly, componentRegistry, structureVersion } = useEditor(
    useShallow((s) => ({
      doc: s.doc,
      selection: s.selection,
      connected: s.connected && !s.switchingDocument,
      readOnly: s.readOnly,
      componentRegistry: s.doc?.components,
      structureVersion: s.structureVersion,
    })),
  );
  const [query, setQuery] = useState('');

  const components = useMemo(
    () =>
      Object.values(componentRegistry ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [componentRegistry],
  );
  const visibleComponents = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return components.filter((component) =>
      needle ? component.name.toLocaleLowerCase().includes(needle) : true,
    );
  }, [components, query]);
  // structureVersion deliberately excludes style/content edits, so a 10k-node
  // document is not rescanned while a user scrubs a visual property.
  const { instanceCounts, lockedInstanceCounts } = useMemo(
    () => componentInstanceStats(doc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc?.id, structureVersion],
  );

  const targetId = doc ? componentInsertionTarget(doc, selection) : null;
  const target = targetId && doc ? doc.nodes[targetId] : undefined;
  const targetLocked = Boolean(doc && targetId && isEffectivelyLocked(doc, targetId));
  const canInsert = Boolean(doc && targetId && connected && !readOnly && !targetLocked);
  const selectedId = selection.length === 1 ? selection[0] : undefined;
  const canCreate = Boolean(
    doc &&
    selectedId &&
    connected &&
    !readOnly &&
    !isEffectivelyLocked(doc, selectedId) &&
    canDefineComponent(doc, selectedId),
  );

  const create = () => {
    const store = useEditor.getState();
    const currentDoc = store.doc;
    const currentId = store.selection.length === 1 ? store.selection[0] : undefined;
    if (
      !currentDoc ||
      !currentId ||
      store.readOnly ||
      !store.connected ||
      isEffectivelyLocked(currentDoc, currentId) ||
      !canDefineComponent(currentDoc, currentId)
    ) {
      return;
    }

    const previousIds = new Set(Object.keys(currentDoc.components));
    let instanceId: string | null = null;
    let componentId: string | null = null;
    store.dispatchEdit('Create component', (draft) => {
      instanceId = defineComponent(draft, currentId);
      componentId = Object.keys(draft.components).find((id) => !previousIds.has(id)) ?? null;
    });
    if (instanceId) store.select([instanceId]);
    if (componentId) store.setEditingVariant(componentId, null);
  };

  const insert = (componentId: string) => {
    const store = useEditor.getState();
    const currentDoc = store.doc;
    if (!currentDoc) return;
    const currentTarget = componentInsertionTarget(currentDoc, store.selection);
    if (
      !currentTarget ||
      store.readOnly ||
      !store.connected ||
      isEffectivelyLocked(currentDoc, currentTarget)
    ) {
      return;
    }

    let newId: string | null = null;
    store.dispatchEdit('Insert instance', (draft) => {
      newId = insertInstance(draft, componentId, currentTarget);
    });
    if (newId) store.select([newId]);
  };

  const goToMain = (componentId: string, rootId: string) => {
    const store = useEditor.getState();
    store.setEditingInstanceOverride(rootId, null);
    store.setEditingVariant(componentId, null);
    store.setLeftPanelTab('layers');
    store.select([rootId]);
    store.requestFocusNode(rootId);
  };

  const targetMessage = insertionTargetMessage({
    doc,
    selection,
    targetName: target?.name,
    connected,
    readOnly,
    targetLocked,
  });
  const createMessage = createComponentMessage({ doc, selection, connected, readOnly });

  if (components.length === 0) {
    return (
      <div className="ptl-panel-empty ptl-components-empty">
        <Component size={18} />
        <strong>No components</strong>
        <span>Select a layer, then create a component from it.</span>
        <Button size="sm" disabled={!canCreate} title={createMessage} onClick={create}>
          <Plus size={12} />
          Create component
        </Button>
      </div>
    );
  }

  return (
    <div className="ptl-components">
      <div className="ptl-components-toolbar">
        <span>
          {components.length} {components.length === 1 ? 'component' : 'components'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canCreate}
          title={createMessage}
          onClick={create}
        >
          <Plus size={12} />
          Create
        </Button>
      </div>

      <div className={`ptl-component-target ${canInsert ? 'ptl-component-target--ready' : ''}`}>
        <span className="ptl-component-target-label">Insert into</span>
        <span className="ptl-component-target-name" title={targetMessage}>
          {targetMessage}
        </span>
      </div>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search components"
        aria-label="Search components"
        prefix={<Search size={12} />}
        className="ptl-component-search"
      />

      <div className="ptl-component-list">
        {visibleComponents.length > 0 ? (
          visibleComponents.map((component) => {
            const count = instanceCounts.get(component.id) ?? 0;
            return (
              <div key={component.id} className="ptl-component-card">
                <button
                  type="button"
                  className="ptl-component-locate"
                  aria-label={`Go to ${component.name} main component`}
                  title="Go to main component"
                  onClick={() => goToMain(component.id, component.rootId)}
                >
                  <Component size={14} />
                </button>
                <span className="ptl-component-copy">
                  <strong className="ptl-component-name" title={component.name}>
                    {component.name}
                  </strong>
                  <span className="ptl-component-meta">
                    <span>
                      {count} {count === 1 ? 'instance' : 'instances'}
                    </span>
                    {component.variantProps.length > 0 && (
                      <span>
                        {component.variantProps.length}{' '}
                        {component.variantProps.length === 1 ? 'variant' : 'variants'}
                      </span>
                    )}
                  </span>
                </span>
                <div className="ptl-component-card-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ptl-component-insert"
                    disabled={!canInsert}
                    title={canInsert ? `Insert into ${target?.name}` : targetMessage}
                    onClick={() => insert(component.id)}
                  >
                    <Plus size={12} />
                    Insert
                  </Button>
                  <ComponentActions
                    componentId={component.id}
                    name={component.name}
                    instanceCount={count}
                    lockedInstanceCount={lockedInstanceCounts.get(component.id) ?? 0}
                    masterLocked={Boolean(doc && isEffectivelyLocked(doc, component.rootId))}
                    disabled={!connected || readOnly}
                    onGoToMain={goToMain}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <div className="ptl-panel-empty">No components match “{query}”.</div>
        )}
      </div>
    </div>
  );
}

/** Count instances and inherited locks in one tree walk rather than walking
 * every instance's ancestor chain separately. */
export function componentInstanceStats(doc: PitoletDocument | null): {
  instanceCounts: Map<string, number>;
  lockedInstanceCounts: Map<string, number>;
} {
  const instanceCounts = new Map<string, number>();
  const lockedInstanceCounts = new Map<string, number>();
  if (!doc) return { instanceCounts, lockedInstanceCounts };

  const visited = new Set<string>();
  const visit = (id: string, ancestorLocked: boolean) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = doc.nodes[id];
    if (!node) return;
    const locked = ancestorLocked || Boolean(node.locked);
    if (node.type === 'instance') {
      instanceCounts.set(node.componentId, (instanceCounts.get(node.componentId) ?? 0) + 1);
      if (locked) {
        lockedInstanceCounts.set(
          node.componentId,
          (lockedInstanceCounts.get(node.componentId) ?? 0) + 1,
        );
      }
    }
    node.children.forEach((childId) => visit(childId, locked));
  };
  doc.rootOrder.forEach((rootId) => visit(rootId, false));
  // Remain defensive around a partially repaired document: orphaned instances
  // should still be represented in management counts.
  Object.keys(doc.nodes).forEach((id) => visit(id, false));
  return { instanceCounts, lockedInstanceCounts };
}

function ComponentActions({
  componentId,
  name,
  instanceCount,
  lockedInstanceCount,
  masterLocked,
  disabled,
  onGoToMain,
}: {
  componentId: string;
  name: string;
  instanceCount: number;
  lockedInstanceCount: number;
  masterLocked: boolean;
  disabled: boolean;
  onGoToMain: (componentId: string, rootId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [nextName, setNextName] = useState(name);

  const close = () => {
    setOpen(false);
    setMode('menu');
    setNextName(name);
  };

  const rename = () => {
    const cleanName = nextName.trim();
    if (!cleanName || cleanName === name) return close();
    useEditor.getState().dispatchEdit('Rename component', (draft) => {
      renameComponent(draft, componentId, cleanName);
    });
    close();
  };

  const duplicate = () => {
    const created = { componentId: '', rootId: '' };
    useEditor.getState().dispatchEdit('Duplicate component', (draft) => {
      const result = duplicateComponent(draft, componentId);
      if (result) Object.assign(created, result);
    });
    close();
    if (created.componentId) onGoToMain(created.componentId, created.rootId);
  };

  const remove = () => {
    useEditor.getState().dispatchEdit('Delete component', (draft) => {
      deleteComponent(draft, componentId);
    });
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setMode('menu');
          setNextName(name);
        }
      }}
      side="bottom"
      align="end"
      className="ptl-component-menu-popover"
      trigger={
        <button
          type="button"
          className="ptl-component-more"
          aria-label={`Manage ${name}`}
          title={
            disabled
              ? 'Reconnect or leave view-only mode to manage components'
              : masterLocked
                ? 'Unlock the main component to manage it'
                : 'Component actions'
          }
          disabled={disabled || masterLocked}
        >
          <MoreHorizontal size={14} />
        </button>
      }
    >
      {mode === 'menu' && (
        <div className="ptl-component-menu" aria-label={`${name} actions`}>
          <button type="button" onClick={() => setMode('rename')}>
            <Pencil size={13} />
            Rename
          </button>
          <button type="button" onClick={duplicate}>
            <Copy size={13} />
            Duplicate
          </button>
          <button
            type="button"
            className="ptl-component-menu-danger"
            disabled={lockedInstanceCount > 0}
            title={
              lockedInstanceCount > 0
                ? `Unlock ${lockedInstanceCount} ${lockedInstanceCount === 1 ? 'instance' : 'instances'} before deleting this component`
                : undefined
            }
            onClick={() => setMode('delete')}
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      )}
      {mode === 'rename' && (
        <form
          className="ptl-component-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            rename();
          }}
        >
          <strong>Rename component</strong>
          <Input
            value={nextName}
            onChange={(event) => setNextName(event.target.value)}
            aria-label="Component name"
            autoFocus
          />
          <div className="ptl-component-dialog-actions">
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode('menu')}>
              Back
            </Button>
            <Button size="sm" type="submit" disabled={!nextName.trim()}>
              Rename
            </Button>
          </div>
        </form>
      )}
      {mode === 'delete' && (
        <div className="ptl-component-dialog">
          <strong>Delete {name}?</strong>
          <p>
            {instanceCount === 0
              ? 'The main component will be removed.'
              : `${instanceCount} ${instanceCount === 1 ? 'instance' : 'instances'} will become ordinary, editable layers. Their content stays on the page.`}
          </p>
          <div className="ptl-component-dialog-actions">
            <Button size="sm" variant="ghost" onClick={() => setMode('menu')}>
              Back
            </Button>
            <Button size="sm" variant="danger" onClick={remove}>
              Delete component
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function insertionTargetMessage({
  doc,
  selection,
  targetName,
  connected,
  readOnly,
  targetLocked,
}: {
  doc: ReturnType<typeof useEditor.getState>['doc'];
  selection: string[];
  targetName?: string;
  connected: boolean;
  readOnly: boolean;
  targetLocked: boolean;
}): string {
  if (readOnly) return 'View only';
  if (!connected) return 'Reconnect to insert';
  if (targetLocked) return 'Unlock the target layer';
  if (targetName) return targetName;
  if (!doc) return 'No document';
  if (selection.length > 1) return 'Select one container';
  const selectedId = selection[0];
  if (selectedId && componentMasterIdForNode(doc, selectedId)) return 'Select a page layer';
  return 'Select a frame or box';
}

function createComponentMessage({
  doc,
  selection,
  connected,
  readOnly,
}: {
  doc: ReturnType<typeof useEditor.getState>['doc'];
  selection: string[];
  connected: boolean;
  readOnly: boolean;
}): string {
  if (readOnly) return 'View only';
  if (!connected) return 'Reconnect to create a component';
  if (!doc) return 'No document';
  if (selection.length !== 1) return 'Select one layer';
  if (isEffectivelyLocked(doc, selection[0]!)) return 'Unlock the selected layer';
  if (componentMasterIdForNode(doc, selection[0]!)) return 'Select a page layer';
  if (doc.nodes[selection[0]!]?.type === 'instance') return 'Select an ordinary layer';
  return 'Create a reusable component from the selected layer';
}
