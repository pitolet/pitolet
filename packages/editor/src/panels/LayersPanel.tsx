import { isAncestor, type PitoletDocument, type PitoletNode, type NodeId } from '@pitolet/schema';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Component,
  Diamond,
  Eye,
  EyeOff,
  Frame,
  Image,
  Lock,
  LockOpen,
  Search,
  Square,
  Type,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store/index.js';
import {
  componentMasterIdForNode,
  effectiveNodeVisibility,
  renameComponent,
  setNodeVisibility,
} from '../store/componentMutations.js';
import { isEffectivelyLocked } from '../store/locks.js';
import { canNodeContainChildren } from '../store/nodeSafety.js';
import {
  clearInteractionCancel,
  setInteractionCancel,
} from '../canvas/interaction/interactionState.js';
import './LayersPanel.css';

const LAYER_ROW_HEIGHT = 26;
const LAYER_OVERSCAN = 12;

/** Document tree: select, hover, rename (double-click), hide/lock, drag to reorder/reparent. */
export function LayersPanel({
  onContextMenu,
}: {
  onContextMenu?: (position: { x: number; y: number }) => void;
}) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const connectionError = useEditor((s) => s.connectionError);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(() => new Set());
  const [focusedId, setFocusedId] = useState<NodeId | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<NodeId | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [treeHeight, setTreeHeight] = useState(600);

  const matches = useMemo(() => layerSearchMatches(doc, query), [doc, query]);
  const visibleEntries = useMemo(
    () => visibleLayerEntries(doc, collapsed, matches),
    [doc, collapsed, matches],
  );
  const visibleOrder = useMemo(() => visibleEntries.map((entry) => entry.id), [visibleEntries]);
  const containerIds = useMemo(
    () =>
      Object.values(doc?.nodes ?? {})
        .filter((node) => node.children.length > 0)
        .map((node) => node.id),
    [doc],
  );
  const allCollapsed = containerIds.length > 0 && containerIds.every((id) => collapsed.has(id));
  const rangeStart = Math.max(0, Math.floor(scrollTop / LAYER_ROW_HEIGHT) - LAYER_OVERSCAN);
  const rangeEnd = Math.min(
    visibleEntries.length,
    Math.ceil((scrollTop + treeHeight) / LAYER_ROW_HEIGHT) + LAYER_OVERSCAN,
  );
  const renderedEntries = visibleEntries.slice(rangeStart, rangeEnd);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const measure = () => setTreeHeight(tree.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const selected = selection[0];
    if (!selected || !doc?.nodes[selected]) return;
    setFocusedId(selected);
    setCollapsed((current) => {
      const next = new Set(current);
      let parent = doc.nodes[selected]?.parent ?? null;
      while (parent) {
        next.delete(parent);
        parent = doc.nodes[parent]?.parent ?? null;
      }
      return next.size === current.size ? current : next;
    });
    requestAnimationFrame(() => {
      revealVirtualRow(treeRef.current, visibleOrder.indexOf(selected));
    });
  }, [doc?.id, doc?.nodes, selection, visibleOrder]);

  useEffect(() => {
    setSelectionAnchor(null);
  }, [doc?.id]);

  useEffect(() => {
    if (visibleOrder.length === 0) setFocusedId(null);
    else if (!focusedId || !visibleOrder.includes(focusedId)) setFocusedId(visibleOrder[0]!);
  }, [focusedId, visibleOrder]);

  const focusLayer = (id: NodeId) => {
    setFocusedId(id);
    requestAnimationFrame(() => {
      revealVirtualRow(treeRef.current, visibleOrder.indexOf(id));
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-layer-row="${id}"]`)?.focus();
      });
    });
  };

  const toggleCollapsed = (id: NodeId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="ptl-layers">
      <div className="ptl-panel-header">{doc?.name ?? 'Layers'}</div>
      {doc && doc.rootOrder.length > 0 && (
        <div className="ptl-layer-toolbar">
          <label className="ptl-layer-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search layers"
              aria-label="Search layers"
            />
          </label>
          <button
            type="button"
            className="ptl-layer-toolbar-button"
            title={allCollapsed ? 'Expand all layers' : 'Collapse all layers'}
            aria-label={allCollapsed ? 'Expand all layers' : 'Collapse all layers'}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(containerIds))}
          >
            <ChevronsUpDown size={13} />
          </button>
        </div>
      )}
      <div
        ref={treeRef}
        className="ptl-layers-tree"
        data-layers-tree
        role="tree"
        aria-label="Document layers"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {doc?.rootOrder.length ? (
          visibleOrder.length > 0 ? (
            <div
              className="ptl-layers-virtual-space"
              style={{ height: visibleEntries.length * LAYER_ROW_HEIGHT }}
            >
              <div
                className="ptl-layers-virtual-window"
                style={{ transform: `translateY(${rangeStart * LAYER_ROW_HEIGHT}px)` }}
              >
                {renderedEntries.map(({ id, depth }) => (
                  <LayerRow
                    key={id}
                    id={id}
                    depth={depth}
                    collapsed={collapsed}
                    matches={matches}
                    visibleOrder={visibleOrder}
                    focusedId={focusedId}
                    onFocusLayer={focusLayer}
                    onToggleCollapsed={toggleCollapsed}
                    selectionAnchor={selectionAnchor}
                    onSelectionAnchorChange={setSelectionAnchor}
                    onContextMenu={onContextMenu}
                    renderChildren={false}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="ptl-panel-empty">No layers match “{query}”.</div>
          )
        ) : (
          <div className="ptl-panel-empty">
            {doc ? 'Press F to draw a frame' : (connectionError ?? 'Connecting…')}
          </div>
        )}
      </div>
    </div>
  );
}

function revealVirtualRow(tree: HTMLDivElement | null, index: number): void {
  if (!tree || index < 0) return;
  const top = index * LAYER_ROW_HEIGHT;
  const bottom = top + LAYER_ROW_HEIGHT;
  if (top < tree.scrollTop) tree.scrollTop = top;
  else if (bottom > tree.scrollTop + tree.clientHeight) {
    tree.scrollTop = Math.max(0, bottom - tree.clientHeight);
  }
}

export type DropMode = 'before' | 'after' | 'inside';

interface LayerRowProps {
  id: NodeId;
  depth: number;
  collapsed: Set<NodeId>;
  matches: Set<NodeId> | null;
  visibleOrder: NodeId[];
  focusedId: NodeId | null;
  onFocusLayer: (id: NodeId) => void;
  onToggleCollapsed: (id: NodeId) => void;
  selectionAnchor: NodeId | null;
  onSelectionAnchorChange: (id: NodeId) => void;
  onContextMenu?: (position: { x: number; y: number }) => void;
  renderChildren?: boolean;
}

const LayerRow = memo(function LayerRow({
  id,
  depth,
  collapsed,
  matches,
  visibleOrder,
  focusedId,
  onFocusLayer,
  onToggleCollapsed,
  selectionAnchor,
  onSelectionAnchorChange,
  onContextMenu,
  renderChildren = true,
}: LayerRowProps) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  const isSelected = useEditor((s) => s.selection.includes(id));
  const isHovered = useEditor((s) => s.hoveredId === id);
  const locked = useEditor((s) => (s.doc ? isEffectivelyLocked(s.doc, id) : false));
  const editable = useEditor((s) => !s.readOnly && s.connected && !s.switchingDocument);
  const effectiveVisible = useEditor((s) =>
    s.doc ? effectiveNodeVisibility(s.doc, id, s.editingVariant) : false,
  );
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [dropMode, setDropMode] = useState<DropMode | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  if (!node || (matches && !matches.has(id))) return null;
  const isContainer = node.type === 'frame' || node.type === 'element';
  const isComponentMaster = node.type === 'frame' && Boolean(node.isComponentMaster);
  const hasChildren = node.children.length > 0;
  const isCollapsed = matches === null && collapsed.has(id);

  const startRenaming = () => {
    if (locked || !editable) return;
    setRenameValue(node.name);
    setRenaming(true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (renaming || e.button !== 0) return;
    const store = useEditor.getState();
    if (e.shiftKey) {
      const anchor = selectionAnchor ?? store.selection.at(-1) ?? id;
      store.select(layerRangeSelection(visibleOrder, anchor, id));
    } else if (e.metaKey || e.ctrlKey) {
      store.select(isSelected ? store.selection.filter((s) => s !== id) : [...store.selection, id]);
      onSelectionAnchorChange(id);
    } else {
      if (!isSelected) store.select([id]);
      onSelectionAnchorChange(id);
    }
    if (editable && !locked) startLayerDrag(e.nativeEvent, id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = visibleOrder.indexOf(id);
    if (e.key === 'ArrowDown' && at < visibleOrder.length - 1) {
      e.preventDefault();
      onFocusLayer(visibleOrder[at + 1]!);
    } else if (e.key === 'ArrowUp' && at > 0) {
      e.preventDefault();
      onFocusLayer(visibleOrder[at - 1]!);
    } else if (e.key === 'ArrowRight' && hasChildren) {
      e.preventDefault();
      if (isCollapsed) onToggleCollapsed(id);
      else onFocusLayer(node.children[0]!);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (hasChildren && !isCollapsed) onToggleCollapsed(id);
      else if (node.parent) onFocusLayer(node.parent);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      useEditor.getState().select([id]);
      onSelectionAnchorChange(id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startRenaming();
    } else if (e.key === 'Home' && visibleOrder.length > 0) {
      e.preventDefault();
      onFocusLayer(visibleOrder[0]!);
    } else if (e.key === 'End' && visibleOrder.length > 0) {
      e.preventDefault();
      onFocusLayer(visibleOrder.at(-1)!);
    }
  };

  return (
    <>
      <div
        ref={rowRef}
        data-layer-row={id}
        data-layer-container={isContainer || undefined}
        role="treeitem"
        aria-label={node.name}
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        tabIndex={focusedId === id ? 0 : -1}
        className={[
          'ptl-layer-row',
          isSelected ? 'ptl-layer-row--selected' : '',
          isHovered ? 'ptl-layer-row--hovered' : '',
          !effectiveVisible ? 'ptl-layer-row--hidden' : '',
          isComponentMaster ? 'ptl-layer-row--component' : '',
          node.type === 'instance' ? 'ptl-layer-row--instance' : '',
          locked ? 'ptl-layer-row--locked' : '',
          dropMode ? `ptl-layer-row--drop-${dropMode}` : '',
        ].join(' ')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onFocus={() => setFocusedIdSafely(id, focusedId, onFocusLayer)}
        onPointerEnter={() => useEditor.getState().setHover(id)}
        onPointerLeave={() => {
          useEditor.getState().setHover(null);
          setDropMode(null);
        }}
        onDoubleClick={startRenaming}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!isSelected) useEditor.getState().select([id]);
          onSelectionAnchorChange(id);
          onContextMenu?.({ x: event.clientX, y: event.clientY });
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="ptl-layer-disclosure"
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggleCollapsed(id)}
          >
            {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        ) : (
          <span className="ptl-layer-disclosure-spacer" />
        )}
        <span className="ptl-layer-icon">{iconFor(node)}</span>
        {renaming ? (
          <input
            className="ptl-layer-rename"
            value={renameValue}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setRenameValue(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== node.name) {
                useEditor.getState().dispatchEdit('Rename', (draft) => {
                  const n = draft.nodes[id];
                  if (n?.type === 'frame' && n.isComponentMaster) {
                    renameComponent(draft, n.isComponentMaster, name);
                  } else if (n) {
                    n.name = name;
                  }
                });
              }
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="ptl-layer-name">{node.name}</span>
        )}
        <span className="ptl-layer-actions">
          <button
            type="button"
            className={`ptl-layer-action ${node.locked ? 'ptl-layer-action--on' : ''}`}
            title={node.locked ? 'Unlock' : 'Lock'}
            aria-label={`${node.locked ? 'Unlock' : 'Lock'} ${node.name}`}
            aria-pressed={node.locked}
            disabled={!editable}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() =>
              useEditor.getState().dispatchEdit(node.locked ? 'Unlock' : 'Lock', (draft) => {
                const n = draft.nodes[id];
                if (n) n.locked = !n.locked;
              })
            }
          >
            {node.locked ? <Lock size={11} /> : <LockOpen size={11} />}
          </button>
          <button
            type="button"
            className={`ptl-layer-action ${!effectiveVisible ? 'ptl-layer-action--on' : ''}`}
            title={effectiveVisible ? 'Hide' : 'Show'}
            aria-label={`${effectiveVisible ? 'Hide' : 'Show'} ${node.name}`}
            aria-pressed={!effectiveVisible}
            disabled={!editable}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              const store = useEditor.getState();
              store.dispatchEdit(effectiveVisible ? 'Hide' : 'Show', (draft) => {
                setNodeVisibility(draft, id, !effectiveVisible, store.editingVariant);
              });
            }}
          >
            {effectiveVisible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
        </span>
      </div>
      {renderChildren &&
        !isCollapsed &&
        node.children.map((childId) => (
          <LayerRow
            key={childId}
            id={childId}
            depth={depth + 1}
            collapsed={collapsed}
            matches={matches}
            visibleOrder={visibleOrder}
            focusedId={focusedId}
            onFocusLayer={onFocusLayer}
            onToggleCollapsed={onToggleCollapsed}
            selectionAnchor={selectionAnchor}
            onSelectionAnchorChange={onSelectionAnchorChange}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
});

function setFocusedIdSafely(
  id: NodeId,
  focusedId: NodeId | null,
  onFocusLayer: (id: NodeId) => void,
): void {
  if (focusedId !== id) onFocusLayer(id);
}

export function layerSearchMatches(doc: PitoletDocument | null, query: string): Set<NodeId> | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!doc || !needle) return null;
  const matches = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    if (!node.name.toLocaleLowerCase().includes(needle)) continue;
    let current: NodeId | null = node.id;
    while (current) {
      matches.add(current);
      current = doc.nodes[current]?.parent ?? null;
    }
  }
  return matches;
}

export function visibleLayerOrder(
  doc: PitoletDocument | null,
  collapsed: Set<NodeId>,
  matches: Set<NodeId> | null,
): NodeId[] {
  return visibleLayerEntries(doc, collapsed, matches).map((entry) => entry.id);
}

export function visibleLayerEntries(
  doc: PitoletDocument | null,
  collapsed: Set<NodeId>,
  matches: Set<NodeId> | null,
): Array<{ id: NodeId; depth: number }> {
  if (!doc) return [];
  const visible: Array<{ id: NodeId; depth: number }> = [];
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node || (matches && !matches.has(id))) return;
    visible.push({ id, depth });
    if (!matches && collapsed.has(id)) return;
    node.children.forEach((childId) => visit(childId, depth + 1));
  };
  doc.rootOrder.forEach((id) => visit(id, 0));
  return visible;
}

export function layerRangeSelection(
  visibleOrder: NodeId[],
  anchor: NodeId,
  target: NodeId,
): NodeId[] {
  const anchorIndex = visibleOrder.indexOf(anchor);
  const targetIndex = visibleOrder.indexOf(target);
  if (anchorIndex < 0 || targetIndex < 0) return [target];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visibleOrder.slice(start, end + 1);
}

/**
 * Row drag: after 4px slop, track the row under the cursor; position within
 * it picks before/after (edges) or inside (middle, containers only).
 * Visualized via CSS classes on the hovered row; committed as one patch.
 */
function startLayerDrag(e: PointerEvent, draggedId: NodeId): void {
  const initialStore = useEditor.getState();
  const initialDoc = initialStore.doc;
  if (
    !initialDoc ||
    initialStore.readOnly ||
    !initialStore.connected ||
    initialStore.switchingDocument ||
    isEffectivelyLocked(initialDoc, draggedId)
  ) {
    return;
  }
  const start = { x: e.clientX, y: e.clientY };
  let started = false;
  let currentTarget: { id: NodeId; mode: DropMode } | null = null;
  let markedEl: Element | null = null;

  const clearMark = () => {
    markedEl?.classList.remove(
      'ptl-layer-row--drop-before',
      'ptl-layer-row--drop-after',
      'ptl-layer-row--drop-inside',
    );
    markedEl = null;
  };

  const updateTarget = (ev: PointerEvent) => {
    const doc = useEditor.getState().doc;
    if (!doc) return;

    clearMark();
    currentTarget = null;
    const rowEl = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null)?.closest(
      '[data-layer-row]',
    );
    if (!rowEl) return;
    const targetId = rowEl.getAttribute('data-layer-row')!;
    if (targetId === draggedId) return;
    if (isAncestor(doc.nodes, draggedId, targetId)) return; // no dropping into own subtree

    const rect = rowEl.getBoundingClientRect();
    const ratio = (ev.clientY - rect.top) / rect.height;
    const isContainer = rowEl.hasAttribute('data-layer-container');
    const mode: DropMode =
      isContainer && ratio > 0.3 && ratio < 0.7 ? 'inside' : ratio < 0.5 ? 'before' : 'after';

    // Top-level frames can only host reordering among themselves for non-frames.
    if (!canDropLayer(doc, draggedId, targetId, mode)) return;

    currentTarget = { id: targetId, mode };
    markedEl = rowEl;
    rowEl.classList.add(`ptl-layer-row--drop-${mode}`);
  };

  const onMove = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) started = true;
    if (!started) return;
    updateTarget(ev);
  };

  const finish = (cancelled: boolean, finalEvent?: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    clearInteractionCancel(cancel);
    if (!cancelled && started && finalEvent) updateTarget(finalEvent);
    clearMark();
    if (cancelled || !started || !currentTarget) return;
    const { id: targetId, mode } = currentTarget;

    useEditor.getState().dispatchEdit('Reorder layers', (draft) => {
      const dragged = draft.nodes[draggedId];
      const target = draft.nodes[targetId];
      if (!dragged || !target) return;
      if (!canDropLayer(draft as PitoletDocument, draggedId, targetId, mode)) return;

      // Detach from the current location.
      if (dragged.parent) {
        const oldParent = draft.nodes[dragged.parent];
        if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== draggedId);
      } else {
        draft.rootOrder = draft.rootOrder.filter((r) => r !== draggedId);
      }

      if (mode === 'inside') {
        target.children.unshift(draggedId);
        dragged.parent = targetId;
      } else if (target.parent === null) {
        const at = draft.rootOrder.indexOf(targetId) + (mode === 'after' ? 1 : 0);
        draft.rootOrder.splice(at, 0, draggedId);
        dragged.parent = null;
      } else {
        const parent = draft.nodes[target.parent]!;
        const at = parent.children.indexOf(targetId) + (mode === 'after' ? 1 : 0);
        parent.children.splice(at, 0, draggedId);
        dragged.parent = target.parent;
      }
    });
  };

  const onUp = (ev: PointerEvent) => finish(false, ev);
  const cancel = () => finish(true);

  setInteractionCancel(cancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
}

/** Shared layer-drop rules, including hard component-master boundaries. */
export function canDropLayer(
  doc: PitoletDocument,
  draggedId: NodeId,
  targetId: NodeId,
  mode: DropMode,
): boolean {
  const dragged = doc.nodes[draggedId];
  const target = doc.nodes[targetId];
  if (!dragged || !target || draggedId === targetId) return false;
  if (isAncestor(doc.nodes, draggedId, targetId)) return false;
  if (isEffectivelyLocked(doc, draggedId)) return false;
  if (mode === 'inside' && !canNodeContainChildren(target)) return false;
  const destinationId = mode === 'inside' ? targetId : target.parent;
  if (destinationId && isEffectivelyLocked(doc, destinationId)) return false;

  // Masters remain top-level roots. Reordering them among root frames is safe;
  // nesting them would invalidate the component definition.
  if (dragged.type === 'frame' && dragged.isComponentMaster) {
    return mode !== 'inside' && dragged.parent === null && target.parent === null;
  }

  const draggedMaster = componentMasterIdForNode(doc, draggedId);
  const destinationMaster =
    mode === 'inside'
      ? componentMasterIdForNode(doc, targetId)
      : target.parent
        ? componentMasterIdForNode(doc, target.parent)
        : null;
  if (draggedMaster !== destinationMaster) return false;

  if (
    mode !== 'inside' &&
    target.parent === null &&
    dragged.parent !== null &&
    dragged.type !== 'frame'
  ) {
    return false;
  }
  return true;
}

function iconFor(node: PitoletNode) {
  if (node.type === 'frame' && node.isComponentMaster) {
    return <Component size={12} aria-label="Main component" />;
  }
  switch (node.type) {
    case 'frame':
      return <Frame size={12} />;
    case 'text':
      return <Type size={12} />;
    case 'image':
      return <Image size={12} />;
    case 'instance':
      return <Diamond size={12} aria-label="Component instance" />;
    default:
      return <Square size={12} />;
  }
}
