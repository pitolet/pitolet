import { BrandMark, IconButton, Kbd, Popover, Separator, Tooltip } from '@pitolet/ui';
import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleCheck,
  CloudCheck,
  CloudOff,
  Code2,
  FileText,
  Frame,
  LoaderCircle,
  Maximize,
  MessageSquare,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Search,
  Square,
  Type,
  Redo2,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CameraController } from '../canvas/CameraController.js';
import { breakpointDisplayLabel } from '../canvas/responsivePreview.js';
import { useEditor } from '../store/index.js';
import { connection } from '../sync/connection.js';
import { apiUrl } from '../sync/serverBase.js';
import { filterDocuments, parseZoomPercent, type DocumentSummary } from './navigation.js';
import { ActivityButton, AgentBadge } from './ActivityFeed.js';
import { ContextCoach, hasSeenCoach, markCoachSeen, type CoachVariant } from './ContextCoach.js';
import './TopBar.css';

export interface TopBarProps {
  camera: CameraController;
  activeTool: string;
  onToolChange: (tool: string) => void;
  onZoomToFit: () => void;
  onZoomToSelection: () => void;
  docName?: string;
  connected?: boolean;
  onOpenCommandPalette: () => void;
}

export function TopBar({
  camera,
  activeTool,
  onToolChange,
  onZoomToFit,
  onZoomToSelection,
  docName,
  connected = false,
  onOpenCommandPalette,
}: TopBarProps) {
  const readOnly = useEditor((s) => s.readOnly);
  return (
    <header className="ptl-topbar">
      <div className="ptl-topbar-section">
        <div className="ptl-logo">
          <BrandMark size={17} />
          <span className="ptl-logo-name">Pitolet</span>
        </div>
        <Separator orientation="vertical" />
        <Tooltip content="Select" shortcut="v">
          <IconButton
            label="Select"
            active={activeTool === 'select'}
            onClick={() => onToolChange('select')}
          >
            <MousePointer2 size={15} />
          </IconButton>
        </Tooltip>
        {/* Insert tools are edit affordances — hidden in read-only mode. */}
        {!readOnly && connected && (
          <>
            <Tooltip content="Frame" shortcut="f">
              <IconButton
                label="Frame"
                active={activeTool === 'frame'}
                onClick={() => onToolChange('frame')}
              >
                <Frame size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Box" shortcut="r">
              <IconButton
                label="Box"
                active={activeTool === 'element'}
                onClick={() => onToolChange('element')}
              >
                <Square size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Text" shortcut="t">
              <IconButton
                label="Text"
                active={activeTool === 'text'}
                onClick={() => onToolChange('text')}
              >
                <Type size={15} />
              </IconButton>
            </Tooltip>
          </>
        )}
        {!readOnly && <EditHistoryControls />}
      </div>

      <div className="ptl-topbar-section ptl-topbar-section--center">
        <div className="ptl-document-context">
          <DocSwitcher name={docName} canCreate={!readOnly && connected} />
          {readOnly && <span className="ptl-viewonly-pill">View only</span>}
        </div>
        <AgentBadge />
        <ContextBar />
        <SaveStatus subdued />
      </div>

      <div className="ptl-topbar-section ptl-topbar-section--right">
        <ZoomControl
          camera={camera}
          onZoomToFit={onZoomToFit}
          onZoomToSelection={onZoomToSelection}
        />
        <Separator orientation="vertical" />
        <Tooltip content="Quick actions" shortcut="mod+k">
          <IconButton label="Quick actions" onClick={onOpenCommandPalette}>
            <Search size={15} />
          </IconButton>
        </Tooltip>
        <CommentsToggle />
        <ActivityButton />
        <CodeToggle />
        <PreviewButton />
      </div>
    </header>
  );
}

function EditHistoryControls() {
  const connected = useEditor((s) => s.connected);
  const switchingDocument = useEditor((s) => s.switchingDocument);
  const status = useEditor((s) => s.historyStatus);
  const available = connected && !switchingDocument;
  const undoText = status.undoLabel ? `Undo ${status.undoLabel}` : 'Nothing to undo';
  const redoText = status.redoLabel ? `Redo ${status.redoLabel}` : 'Nothing to redo';

  return (
    <div className="ptl-history-controls" role="group" aria-label="Edit history">
      <Tooltip content={undoText} shortcut="mod+z">
        <IconButton
          label={undoText}
          size="sm"
          disabled={!available || !status.canUndo}
          onClick={() => useEditor.getState().undo()}
        >
          <Undo2 size={13} />
        </IconButton>
      </Tooltip>
      <Tooltip content={redoText} shortcut="mod+shift+z">
        <IconButton
          label={redoText}
          size="sm"
          disabled={!available || !status.canRedo}
          onClick={() => useEditor.getState().redo()}
        >
          <Redo2 size={13} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

function SaveStatus({ subdued = false }: { subdued?: boolean }) {
  const hasDocument = useEditor((s) => s.doc !== null);
  const connected = useEditor((s) => s.connected);
  const switchingDocument = useEditor((s) => s.switchingDocument);
  const readOnly = useEditor((s) => s.readOnly);
  const pending = useEditor((s) => s.pendingPatchIds.length);
  const issue = useEditor((s) => s.syncIssue);
  const lastSavedAt = useEditor((s) => s.lastSavedAt);

  if (!hasDocument || readOnly) return null;

  let label = 'Saved';
  let kind: 'saved' | 'saving' | 'offline' | 'error' = 'saved';
  let Icon = CloudCheck;
  if (switchingDocument) {
    label = 'Opening document…';
    kind = 'saving';
    Icon = LoaderCircle;
  } else if (issue) {
    label = 'Not saved';
    kind = 'error';
    Icon = AlertCircle;
  } else if (!connected) {
    label = 'Offline';
    kind = 'offline';
    Icon = CloudOff;
  } else if (pending > 0) {
    label = pending === 1 ? 'Saving…' : `Saving ${pending} changes…`;
    kind = 'saving';
    Icon = LoaderCircle;
  } else if (lastSavedAt === null) {
    return null;
  }

  return (
    <Tooltip content={label}>
      <span
        className={`ptl-save-status ptl-save-status--${kind} ${subdued ? 'ptl-save-status--subdued' : ''}`}
        role="status"
        aria-live="polite"
        aria-label={label}
        tabIndex={0}
      >
        <Icon size={15} />
      </span>
    </Tooltip>
  );
}

/**
 * Editing-context switcher: which breakpoint layer and interaction state
 * style edits write into. "Base" = mobile-first base layer. The first time
 * the user tries breakpoints or states, a one-time coach-mark explains it.
 */
function ContextBar() {
  const breakpoints = useEditor((s) => s.doc?.breakpoints);
  const ctx = useEditor((s) => s.editingContext);
  const setCtx = useEditor((s) => s.setEditingContext);
  const selectionCount = useEditor((s) => s.selection.length);
  const activeFrameName = useEditor((s) =>
    s.responsivePreviewFrameId ? s.doc?.nodes[s.responsivePreviewFrameId]?.name : undefined,
  );
  const [coach, setCoach] = useState<CoachVariant | null>(null);
  if (!breakpoints) return null;

  const dismissCoach = () => {
    if (coach) markCoachSeen(coach);
    setCoach(null);
  };

  const pickBreakpoint = (id: string | null) => {
    setCtx({ ...ctx, breakpointId: ctx.breakpointId === id ? null : id });
    if (id !== null && !hasSeenCoach('sizes')) setCoach('sizes');
    else if (coach === 'sizes') dismissCoach();
  };

  const pickState = (state: 'hover' | 'focus' | 'active') => {
    if (selectionCount === 0) return;
    setCtx({ ...ctx, state: ctx.state === state ? null : state });
    if (!hasSeenCoach('states')) setCoach('states');
    else if (coach === 'states') dismissCoach();
  };

  return (
    <div className="ptl-context-bar" role="toolbar" aria-label="Editing context">
      <div className="ptl-context-group" role="group" aria-label="Responsive breakpoint">
        <button
          type="button"
          className={`ptl-bp-chip ${ctx.breakpointId === null ? 'ptl-bp-chip--active' : ''}`}
          title={`Use ${activeFrameName ?? 'the active frame'}'s own width`}
          aria-pressed={ctx.breakpointId === null}
          onClick={() => pickBreakpoint(null)}
        >
          base
        </button>
        {breakpoints.map((bp) => (
          <button
            key={bp.id}
            type="button"
            className={`ptl-bp-chip ${ctx.breakpointId === bp.id ? 'ptl-bp-chip--active' : ''}`}
            title={`Preview ${activeFrameName ?? 'the active frame'} at ${bp.minWidth}px`}
            aria-pressed={ctx.breakpointId === bp.id}
            onClick={() => pickBreakpoint(bp.id)}
          >
            {breakpointDisplayLabel(bp)}
          </button>
        ))}
      </div>
      <span className="ptl-context-sep" />
      <div className="ptl-context-group" role="group" aria-label="Interaction state">
        {(['hover', 'focus', 'active'] as const).map((state) => (
          <button
            key={state}
            type="button"
            className={`ptl-bp-chip ptl-bp-chip--state ${ctx.state === state ? 'ptl-bp-chip--active' : ''}`}
            title={
              selectionCount === 0
                ? `Select a layer to preview :${state}`
                : `Preview and edit :${state} on the selected ${selectionCount === 1 ? 'layer' : 'layers'}`
            }
            disabled={selectionCount === 0}
            aria-pressed={ctx.state === state}
            onClick={() => pickState(state)}
          >
            :{state}
          </button>
        ))}
      </div>
      {coach && <ContextCoach variant={coach} onDismiss={dismissCoach} />}
    </div>
  );
}

function PreviewButton() {
  return (
    <Tooltip content="Preview" shortcut="mod+enter">
      <IconButton label="Preview" onClick={() => openPreview()}>
        <Play size={15} />
      </IconButton>
    </Tooltip>
  );
}

/** Preview the selected frame (walking up from any selection), else the first frame. */
export function openPreview(): void {
  const s = useEditor.getState();
  const doc = s.doc;
  if (!doc) return;
  let frameId = doc.rootOrder[0] ?? null;
  const first = s.selection[0];
  if (first && doc.nodes[first]) {
    let current: string | null = first;
    while (current) {
      const node: (typeof doc.nodes)[string] | undefined = doc.nodes[current];
      if (!node) break;
      if (node.parent === null) {
        frameId = current;
        break;
      }
      current = node.parent;
    }
  }
  if (frameId) s.setPreviewFrame(frameId);
}

/** Document name + a dropdown to switch between all documents on the server. */
function DocSwitcher({ name, canCreate }: { name?: string; canCreate: boolean }) {
  const activeId = useEditor((s) => s.doc?.id);
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [query, setQuery] = useState('');
  const [request, setRequest] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createState, setCreateState] = useState<'idle' | 'submitting'>('idle');
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadState('loading');
    void fetch(apiUrl('/api/documents'), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Document list failed with ${response.status}`);
        return response.json();
      })
      .then((body: { documents?: DocumentSummary[] }) => {
        setDocs(body.documents ?? []);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDocs([]);
        setLoadState('error');
      });
    return () => controller.abort();
  }, [open, request]);

  const filtered = filterDocuments(docs, query, activeId);

  const setSwitcherOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setCreating(false);
      setCreateName('');
      setCreateState('idle');
      setCreateError(null);
    }
  };

  const submitDocument = async () => {
    const documentName = createName.trim();
    if (!documentName) {
      setCreateError('Enter a document name.');
      return;
    }
    if (documentName.length > 120) {
      setCreateError('Use 120 characters or fewer.');
      return;
    }

    setCreateState('submitting');
    setCreateError(null);
    try {
      const response = await fetch(apiUrl('/api/documents'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: documentName }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        docId?: string;
        error?: string;
      };
      if (!response.ok || !body.docId) {
        throw new Error(body.error || `Couldn’t create document (${response.status}).`);
      }
      connection.openDocument(body.docId);
      setSwitcherOpen(false);
    } catch (error) {
      setCreateState('idle');
      setCreateError(error instanceof Error ? error.message : 'Couldn’t create document.');
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setSwitcherOpen}
      align="center"
      className="ptl-doc-switcher-popover"
      trigger={
        <button
          type="button"
          className="ptl-doc-name ptl-doc-name--button"
          aria-label={`Switch document. Current document: ${name ?? 'Loading'}`}
        >
          {name ?? '…'}
          <ChevronDown size={12} />
        </button>
      }
    >
      <div className="ptl-doc-switcher">
        <div className="ptl-doc-switcher-title">Documents</div>
        {loadState === 'ready' && docs.length > 0 && (
          <label className="ptl-doc-switcher-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a document"
              aria-label="Find a document"
              autoFocus
            />
          </label>
        )}
        {loadState === 'loading' && (
          <div className="ptl-doc-switcher-empty" role="status">
            <LoaderCircle size={13} className="ptl-doc-switcher-spinner" />
            Loading documents…
          </div>
        )}
        {loadState === 'error' && (
          <div className="ptl-doc-switcher-error" role="alert">
            <span>Couldn’t load documents.</span>
            <button type="button" onClick={() => setRequest((value) => value + 1)}>
              <RefreshCw size={12} />
              Try again
            </button>
          </div>
        )}
        {loadState === 'ready' && docs.length === 0 && (
          <div className="ptl-doc-switcher-empty">No documents found.</div>
        )}
        {loadState === 'ready' && docs.length > 0 && filtered.length === 0 && (
          <div className="ptl-doc-switcher-empty">No documents match “{query.trim()}”.</div>
        )}
        {filtered.map((doc) => (
          <button
            key={doc.id}
            type="button"
            className={`ptl-doc-switcher-item ${doc.id === activeId ? 'ptl-doc-switcher-item--active' : ''}`}
            aria-current={doc.id === activeId ? 'page' : undefined}
            onClick={() => {
              connection.openDocument(doc.id);
              setSwitcherOpen(false);
            }}
          >
            <FileText size={13} />
            <span className="ptl-doc-switcher-name">{doc.name}</span>
            <span className="ptl-doc-switcher-meta">
              {doc.frameCount} frame{doc.frameCount === 1 ? '' : 's'}
            </span>
            {doc.id === activeId && <CircleCheck size={13} className="ptl-doc-switcher-check" />}
          </button>
        ))}
        {canCreate && <div className="ptl-doc-create-divider" />}
        {canCreate && !creating && (
          <button
            type="button"
            className="ptl-doc-create-action"
            onClick={() => {
              setCreating(true);
              setCreateError(null);
            }}
          >
            <Plus size={13} />
            New document
          </button>
        )}
        {canCreate && creating && (
          <form
            className="ptl-doc-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDocument();
            }}
          >
            <div className="ptl-doc-create-row">
              <input
                value={createName}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  if (createError) setCreateError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setCreating(false);
                    setCreateName('');
                    setCreateError(null);
                  }
                }}
                placeholder="Document name"
                aria-label="Document name"
                maxLength={120}
                disabled={createState === 'submitting'}
                autoFocus
              />
              <button
                type="submit"
                className="ptl-doc-create-confirm"
                aria-label="Create document"
                disabled={createState === 'submitting'}
              >
                {createState === 'submitting' ? (
                  <LoaderCircle size={13} className="ptl-doc-switcher-spinner" />
                ) : (
                  <Check size={13} />
                )}
              </button>
              <button
                type="button"
                className="ptl-doc-create-cancel"
                aria-label="Cancel new document"
                disabled={createState === 'submitting'}
                onClick={() => {
                  setCreating(false);
                  setCreateName('');
                  setCreateError(null);
                }}
              >
                <X size={13} />
              </button>
            </div>
            {createError && (
              <div className="ptl-doc-create-error" role="alert">
                {createError}
              </div>
            )}
          </form>
        )}
      </div>
    </Popover>
  );
}

function CommentsToggle() {
  const open = useEditor((s) => s.rightPanelMode === 'comments');
  const setMode = useEditor((s) => s.setRightPanelMode);
  const setShow = useEditor((s) => s.setShowComments);
  return (
    <Tooltip content={open ? 'Back to design' : 'Open comments'}>
      <IconButton
        label="Comments"
        active={open}
        onClick={() => {
          const nextOpen = !open;
          setMode(nextOpen ? 'comments' : 'design');
          setShow(nextOpen);
        }}
      >
        <MessageSquare size={15} />
      </IconButton>
    </Tooltip>
  );
}

function CodeToggle() {
  const open = useEditor((s) => s.codePanelOpen);
  const setOpen = useEditor((s) => s.setCodePanelOpen);
  return (
    <Tooltip content="Code" shortcut="mod+j">
      <IconButton label="Code" active={open} onClick={() => setOpen(!open)}>
        <Code2 size={15} />
      </IconButton>
    </Tooltip>
  );
}

function ZoomControl({
  camera,
  onZoomToFit,
  onZoomToSelection,
}: {
  camera: CameraController;
  onZoomToFit: () => void;
  onZoomToSelection: () => void;
}) {
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const [open, setOpen] = useState(false);
  const zoom = useSyncExternalStore(
    (cb) => camera.subscribe(cb),
    () => Math.round(camera.zoom * 100),
  );
  const [draft, setDraft] = useState(() => String(zoom));

  useEffect(() => {
    if (!open) setDraft(String(zoom));
  }, [open, zoom]);

  const setZoom = (percent: number) => {
    camera.setZoomCentered(percent / 100);
    setDraft(String(percent));
    setOpen(false);
  };

  const applyDraft = () => {
    const percent = parseZoomPercent(draft);
    if (percent === null) {
      setDraft(String(zoom));
      return;
    }
    setZoom(percent);
  };

  return (
    <div className="ptl-zoom-control">
      <Tooltip content="Zoom out" shortcut="mod+-">
        <IconButton
          label="Zoom out"
          size="sm"
          onClick={() => camera.setZoomCentered(camera.zoom / 1.25)}
        >
          <Minus size={13} />
        </IconButton>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="ptl-zoom-popover"
        trigger={
          <button type="button" className="ptl-zoom-value" aria-label={`Zoom: ${zoom}%`}>
            {zoom}%
            <ChevronDown size={10} />
          </button>
        }
      >
        <div className="ptl-zoom-menu">
          <form
            className="ptl-zoom-entry"
            onSubmit={(event) => {
              event.preventDefault();
              applyDraft();
            }}
          >
            <label htmlFor="ptl-zoom-input">Zoom</label>
            <span className="ptl-zoom-input-wrap">
              <input
                id="ptl-zoom-input"
                value={draft}
                inputMode="decimal"
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.target.select()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyDraft();
                  }
                }}
                aria-label="Zoom percentage"
                autoFocus
              />
              <span>%</span>
            </span>
          </form>
          <div className="ptl-zoom-presets" aria-label="Zoom presets">
            {[25, 50, 100, 200].map((percent) => (
              <button key={percent} type="button" onClick={() => setZoom(percent)}>
                {percent}%
              </button>
            ))}
          </div>
          <div className="ptl-zoom-menu-separator" />
          <button
            type="button"
            className="ptl-zoom-menu-item"
            onClick={() => {
              onZoomToFit();
              setOpen(false);
            }}
          >
            <span>Fit canvas</span>
            <Kbd keys="shift+1" />
          </button>
          <button
            type="button"
            className="ptl-zoom-menu-item"
            disabled={!hasSelection}
            onClick={() => {
              onZoomToSelection();
              setOpen(false);
            }}
          >
            <span>Focus selection</span>
            <Kbd keys="shift+2" />
          </button>
          <button type="button" className="ptl-zoom-menu-item" onClick={() => setZoom(100)}>
            <span>Actual size</span>
            <Kbd keys="mod+0" />
          </button>
        </div>
      </Popover>
      <Tooltip content="Zoom in" shortcut="mod+=">
        <IconButton
          label="Zoom in"
          size="sm"
          onClick={() => camera.setZoomCentered(camera.zoom * 1.25)}
        >
          <Plus size={13} />
        </IconButton>
      </Tooltip>
      <Tooltip content="Zoom to fit" shortcut="shift+1">
        <IconButton label="Zoom to fit" size="sm" onClick={onZoomToFit}>
          <Maximize size={13} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
