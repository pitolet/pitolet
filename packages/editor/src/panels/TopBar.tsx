import { BrandMark, IconButton, Popover, Separator, Tooltip } from '@pitolet/ui';
import {
  ChevronDown,
  Code2,
  FileText,
  Frame,
  Maximize,
  MessageSquare,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Square,
  Type,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CameraController } from '../canvas/CameraController.js';
import { useEditor } from '../store/index.js';
import { connection } from '../sync/connection.js';
import { apiUrl } from '../sync/serverBase.js';
import { ActivityButton, AgentBadge } from './ActivityFeed.js';
import { ContextCoach, hasSeenCoach, markCoachSeen, type CoachVariant } from './ContextCoach.js';
import './TopBar.css';

export interface TopBarProps {
  camera: CameraController;
  activeTool: string;
  onToolChange: (tool: string) => void;
  onZoomToFit: () => void;
  docName?: string;
  connected?: boolean;
}

export function TopBar({
  camera,
  activeTool,
  onToolChange,
  onZoomToFit,
  docName,
  connected = false,
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
        {!readOnly && (
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
      </div>

      <div className="ptl-topbar-section ptl-topbar-section--center">
        <span
          className={`ptl-connection-dot ${connected ? 'ptl-connection-dot--on' : ''}`}
          title={connected ? 'Connected' : 'Reconnecting…'}
        />
        <DocSwitcher name={docName} />
        {readOnly && <span className="ptl-viewonly-pill">View only</span>}
        <AgentBadge />
        <ContextBar />
      </div>

      <div className="ptl-topbar-section ptl-topbar-section--right">
        <ZoomControl camera={camera} onZoomToFit={onZoomToFit} />
        <Separator orientation="vertical" />
        <CommentsToggle />
        <ActivityButton />
        <CodeToggle />
        <PreviewButton />
      </div>
    </header>
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
    setCtx({ ...ctx, state: ctx.state === state ? null : state });
    if (!hasSeenCoach('states')) setCoach('states');
    else if (coach === 'states') dismissCoach();
  };

  return (
    <div className="ptl-context-bar">
      <button
        type="button"
        className={`ptl-bp-chip ${ctx.breakpointId === null ? 'ptl-bp-chip--active' : ''}`}
        title="Base styles (all widths)"
        onClick={() => pickBreakpoint(null)}
      >
        Base
      </button>
      {breakpoints.map((bp) => (
        <button
          key={bp.id}
          type="button"
          className={`ptl-bp-chip ${ctx.breakpointId === bp.id ? 'ptl-bp-chip--active' : ''}`}
          title={`Overrides at ≥ ${bp.minWidth}px`}
          onClick={() => pickBreakpoint(bp.id)}
        >
          {bp.id}
        </button>
      ))}
      <span className="ptl-context-sep" />
      {(['hover', 'focus', 'active'] as const).map((state) => (
        <button
          key={state}
          type="button"
          className={`ptl-bp-chip ptl-bp-chip--state ${ctx.state === state ? 'ptl-bp-chip--active' : ''}`}
          title={`Edit :${state} styles for the selection`}
          onClick={() => pickState(state)}
        >
          :{state}
        </button>
      ))}
      {coach && <ContextCoach variant={coach} onDismiss={dismissCoach} />}
    </div>
  );
}

function PreviewButton() {
  return (
    <Tooltip content="Preview (real CSS)" shortcut="mod+enter">
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

interface DocSummary {
  id: string;
  name: string;
  frameCount: number;
}

/** Document name + a dropdown to switch between all documents on the server. */
function DocSwitcher({ name }: { name?: string }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocSummary[]>([]);

  useEffect(() => {
    if (!open) return;
    void fetch(apiUrl('/api/documents'))
      .then((r) => r.json())
      .then((body: { documents?: DocSummary[] }) => setDocs(body.documents ?? []))
      .catch(() => setDocs([]));
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="center"
      className="ptl-doc-switcher-popover"
      trigger={
        <button type="button" className="ptl-doc-name ptl-doc-name--button">
          {name ?? '…'}
          <ChevronDown size={12} />
        </button>
      }
    >
      <div className="ptl-doc-switcher">
        {docs.length === 0 && <div className="ptl-doc-switcher-empty">Loading…</div>}
        {docs.map((doc) => (
          <button
            key={doc.id}
            type="button"
            className={`ptl-doc-switcher-item ${doc.name === name ? 'ptl-doc-switcher-item--active' : ''}`}
            onClick={() => {
              connection.openDocument(doc.id);
              setOpen(false);
            }}
          >
            <FileText size={13} />
            <span className="ptl-doc-switcher-name">{doc.name}</span>
            <span className="ptl-doc-switcher-meta">
              {doc.frameCount} frame{doc.frameCount === 1 ? '' : 's'}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

function CommentsToggle() {
  const show = useEditor((s) => s.showComments);
  const setShow = useEditor((s) => s.setShowComments);
  return (
    <Tooltip content={show ? 'Hide comment pins' : 'Show comment pins'}>
      <IconButton label="Comments" active={show} onClick={() => setShow(!show)}>
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
}: {
  camera: CameraController;
  onZoomToFit: () => void;
}) {
  const zoom = useSyncExternalStore(
    (cb) => camera.subscribe(cb),
    () => Math.round(camera.zoom * 100),
  );
  return (
    <div className="ptl-zoom-control">
      <Tooltip content="Zoom out" shortcut="mod+-">
        <IconButton label="Zoom out" size="sm" onClick={() => camera.setZoomCentered(camera.zoom / 1.25)}>
          <Minus size={13} />
        </IconButton>
      </Tooltip>
      <span className="ptl-zoom-value">{zoom}%</span>
      <Tooltip content="Zoom in" shortcut="mod+=">
        <IconButton label="Zoom in" size="sm" onClick={() => camera.setZoomCentered(camera.zoom * 1.25)}>
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
