import { IconButton, Tabs, Tooltip, TooltipProvider } from '@pitolet/ui';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { CameraController } from './canvas/CameraController.js';
import { editingContentBounds } from './canvas/contentBounds.js';
import { renderedFrameHeight } from './canvas/frameMeasurements.js';
import { CanvasViewport } from './canvas/CanvasViewport.js';
import { installCulling } from './canvas/culling.js';
import { handleImageDrop } from './canvas/interaction/dropImages.js';
import { onInsertPointerDown } from './canvas/interaction/insertTools.js';
import { syncDocumentFonts } from './fonts/googleFonts.js';
import { syncImportedDocumentFonts } from './fonts/importedFonts.js';
import {
  onSelectDoubleClick,
  onSelectPointerDown,
  onSelectPointerMove,
} from './canvas/interaction/selectTool.js';
import { OverlayLayer } from './canvas/overlay/OverlayLayer.js';
import { WorldLayer } from './canvas/WorldLayer.js';
import { ContextMenu, type ContextMenuState } from './commands/ContextMenu.js';
import { Palette } from './commands/Palette.js';
import type { CommandContext } from './commands/registry.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Inspector } from './inspector/Inspector.js';
import { installKeyboard } from './keyboard.js';
import { LayersPanel } from './panels/LayersPanel.js';
import { SelectionBar } from './panels/SelectionBar.js';
import { openPreview, TopBar } from './panels/TopBar.js';
import { SyncBanner } from './panels/SyncBanner.js';
import { LoginScreen } from './panels/LoginScreen.js';
import { useEditor } from './store/index.js';
import { connection } from './sync/connection.js';
import {
  CODE_PANEL_MAX,
  CODE_PANEL_MIN,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  clampCodePanelHeight,
  clampLeftPanelWidth,
  clampRightPanelWidth,
  fitCodePanelHeight,
  fitPanelWidths,
  readWorkspacePreferences,
  updateWorkspacePreferences,
} from './workspacePreferences.js';
import './App.css';

const CodePanel = lazy(() =>
  import('./panels/CodePanel.js').then((module) => ({ default: module.CodePanel })),
);
const CommentsPanel = lazy(() =>
  import('./panels/CommentsPanel.js').then((module) => ({ default: module.CommentsPanel })),
);
const ComponentsPanel = lazy(() =>
  import('./panels/ComponentsPanel.js').then((module) => ({ default: module.ComponentsPanel })),
);
const TokensPanel = lazy(() =>
  import('./panels/TokensPanel.js').then((module) => ({ default: module.TokensPanel })),
);
const PreviewMode = lazy(() =>
  import('./preview/PreviewMode.js').then((module) => ({ default: module.PreviewMode })),
);

export function App() {
  const authRequired = useEditor((s) => s.authRequired);
  if (authRequired) {
    // Boot fetch returned 401 — show login instead of the editor. On success
    // the server has set the auth cookie; re-run the boot sequence, which
    // clears authRequired once documents load and opens the WS.
    return (
      <TooltipProvider>
        <LoginScreen
          onSuccess={() => {
            void connection.start().catch((err) => console.error('[pitolet] connect failed:', err));
          }}
        />
      </TooltipProvider>
    );
  }
  return <Editor />;
}

function Editor() {
  const camera = useMemo(() => new CameraController(), []);
  const initialPreferences = useMemo(() => readWorkspacePreferences(), []);
  const activeTool = useEditor((s) => s.activeTool);
  const setTool = useEditor((s) => s.setTool);
  const connected = useEditor((s) => s.connected);
  const switchingDocument = useEditor((s) => s.switchingDocument);
  const hasDocument = useEditor((s) => s.doc !== null);
  const documentId = useEditor((s) => s.doc?.id);
  const docName = useEditor((s) => s.doc?.name);
  const codePanelOpen = useEditor((s) => s.codePanelOpen);
  const leftPanelTab = useEditor((s) => s.leftPanelTab);
  const setLeftPanelTab = useEditor((s) => s.setLeftPanelTab);
  const rightPanelMode = useEditor((s) => s.rightPanelMode);
  const focusNodeRequest = useEditor((s) => s.focusNodeRequest);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(() =>
    defaultPanelOpen(initialPreferences.leftPanelOpen),
  );
  const [rightPanelOpen, setRightPanelOpen] = useState(() =>
    defaultPanelOpen(initialPreferences.rightPanelOpen),
  );
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    Math.min(
      initialPreferences.leftPanelWidth,
      availablePanelWidth(LEFT_PANEL_MIN, LEFT_PANEL_MAX, initialPreferences.rightPanelWidth),
    ),
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    Math.min(
      initialPreferences.rightPanelWidth,
      availablePanelWidth(RIGHT_PANEL_MIN, RIGHT_PANEL_MAX, initialPreferences.leftPanelWidth),
    ),
  );
  const [codePanelHeight, setCodePanelHeight] = useState(() =>
    Math.min(initialPreferences.codePanelHeight, availableCodePanelHeight()),
  );

  const commandCtx: CommandContext = {
    zoomToFit: () => zoomToFit(),
    zoomToSelection: () => zoomToSelection(),
    zoomIn: () => camera.setZoomCentered(camera.zoom * 1.25),
    zoomOut: () => camera.setZoomCentered(camera.zoom / 1.25),
    zoomTo100: () => camera.setZoomCentered(1),
    openPreview,
  };

  const contentBounds = () => {
    const state = useEditor.getState();
    return editingContentBounds(state.doc, state.selection, (frame) =>
      renderedFrameHeight(frame.id),
    );
  };

  const zoomToFit = () => camera.fitRect(contentBounds());

  const zoomToSelection = () => {
    const state = useEditor.getState();
    if (!state.doc || state.selection.length === 0) {
      zoomToFit();
      return;
    }

    if (fitMeasuredSelection(camera, state.selection)) return;

    // A selected node can live inside a culled off-screen frame. Bring its
    // root frame into view first, then measure the real rendered node once
    // culling has caught up and focus it precisely.
    const roots = selectedRootIds(state.doc, state.selection);
    camera.fitRect(
      editingContentBounds(state.doc, roots, (frame) => renderedFrameHeight(frame.id)),
      {
        padding: 80,
        maxZoom: 1,
        animate: false,
      },
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitMeasuredSelection(camera, state.selection));
    });
  };

  useEffect(() => {
    if (!focusNodeRequest) return;
    requestAnimationFrame(() => zoomToSelection());
    // The nonce deliberately retriggers focus for the same node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeRequest?.nonce]);

  useEffect(() => {
    void connection.start().catch((err) => console.error('[pitolet] connect failed:', err));
    return () => connection.stop();
  }, []);

  useEffect(() => {
    const reconcile = () => {
      const widths = fitPanelWidths(
        window.innerWidth,
        leftPanelWidth,
        rightPanelWidth,
        leftPanelOpen,
        rightPanelOpen,
      );
      setLeftPanelWidth(widths.left);
      setRightPanelWidth(widths.right);
      setCodePanelHeight((height) => fitCodePanelHeight(window.innerHeight, height));
    };
    window.addEventListener('resize', reconcile);
    reconcile();
    return () => window.removeEventListener('resize', reconcile);
  }, [leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth]);

  // Zoom to fit once the document first arrives. The camera runs the fit when
  // its viewport is attached and sized, so this is robust to load ordering.
  useEffect(() => {
    let done = false;
    const fitOnce = () => {
      if (done) return;
      done = true;
      camera.requestInitialFit(() => contentBounds());
    };
    if (useEditor.getState().doc) fitOnce();
    const unsubscribe = useEditor.subscribe((state) => {
      if (state.doc) {
        fitOnce();
        unsubscribe();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => installKeyboard(camera, zoomToFit, zoomToSelection), [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => installCulling(camera), [camera]);

  // Restore store-owned workspace preferences once, then keep changes made
  // through the toolbar, keyboard shortcuts, and panel tabs persistent.
  useEffect(() => {
    const store = useEditor.getState();
    store.setCodePanelOpen(initialPreferences.codePanelOpen);
    store.setLeftPanelTab(initialPreferences.leftPanelTab);
    return useEditor.subscribe((state, previous) => {
      const patch: Parameters<typeof updateWorkspacePreferences>[0] = {};
      if (state.codePanelOpen !== previous.codePanelOpen) {
        patch.codePanelOpen = state.codePanelOpen;
      }
      if (state.leftPanelTab !== previous.leftPanelTab) {
        patch.leftPanelTab = state.leftPanelTab;
      }
      if (Object.keys(patch).length > 0) updateWorkspacePreferences(patch);
    });
  }, [initialPreferences]);

  // Compact windows need canvas room more than they need two permanent
  // sidebars. Collapse once when crossing into the compact layout; reopening
  // either rail remains the user's choice.
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 980px)');
    const onChange = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) {
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
        const store = useEditor.getState();
        store.setRightPanelMode('design');
        store.setShowComments(false);
      }
    };
    onChange(compact);
    compact.addEventListener('change', onChange);
    return () => compact.removeEventListener('change', onChange);
  }, []);

  const setPanelVisibility = (side: 'left' | 'right', open: boolean) => {
    if (side === 'left') setLeftPanelOpen(open);
    else {
      setRightPanelOpen(open);
      if (!open) {
        const store = useEditor.getState();
        store.setRightPanelMode('design');
        store.setShowComments(false);
      }
    }
    updateWorkspacePreferences(
      side === 'left' ? { leftPanelOpen: open } : { rightPanelOpen: open },
    );
  };

  useEffect(() => {
    if (rightPanelMode !== 'comments') return;
    setRightPanelOpen(true);
    updateWorkspacePreferences({ rightPanelOpen: true });
  }, [rightPanelMode]);

  const leftPanelResizeMax = availablePanelWidth(
    LEFT_PANEL_MIN,
    LEFT_PANEL_MAX,
    rightPanelOpen ? rightPanelWidth : 36,
  );
  const rightPanelResizeMax = availablePanelWidth(
    RIGHT_PANEL_MIN,
    RIGHT_PANEL_MAX,
    leftPanelOpen ? leftPanelWidth : 36,
  );
  const codePanelResizeMax = availableCodePanelHeight();

  // Keep every document-referenced Google Font loaded.
  useEffect(() => {
    const syncFonts = (doc: ReturnType<typeof useEditor.getState>['doc']) => {
      syncDocumentFonts(doc);
      syncImportedDocumentFonts(doc);
    };
    syncFonts(useEditor.getState().doc);
    const unsubscribe = useEditor.subscribe((state, prev) => {
      if (state.doc !== prev.doc) syncFonts(state.doc);
    });
    return () => {
      unsubscribe();
      syncImportedDocumentFonts(null);
    };
  }, []);

  return (
    <TooltipProvider>
      <div className={`ptl-app ${hasDocument && !connected ? 'ptl-app--editing-paused' : ''}`}>
        <TopBar
          camera={camera}
          activeTool={activeTool}
          onToolChange={(tool) => setTool(tool as never)}
          onZoomToFit={zoomToFit}
          onZoomToSelection={zoomToSelection}
          onOpenCommandPalette={() => window.dispatchEvent(new Event('pitolet:command-palette'))}
          docName={docName}
          connected={connected && !switchingDocument}
        />
        <SyncBanner />
        <div className="ptl-app-body">
          {leftPanelOpen ? (
            <aside className="ptl-panel ptl-panel--left" style={{ width: leftPanelWidth }}>
              <div className="ptl-left-tabs">
                <Tabs
                  value={leftPanelTab}
                  onValueChange={(v) => setLeftPanelTab(v as 'layers' | 'tokens' | 'components')}
                  tabs={[
                    { value: 'layers', label: 'Layers' },
                    { value: 'tokens', label: 'Tokens' },
                    { value: 'components', label: 'Components' },
                  ]}
                  size="sm"
                />
                <PanelButton side="left" open onClick={() => setPanelVisibility('left', false)} />
              </div>
              <ErrorBoundary name="Left panel">
                <Suspense fallback={null}>
                  {leftPanelTab === 'layers' ? (
                    <LayersPanel onContextMenu={(position) => setContextMenu(position)} />
                  ) : leftPanelTab === 'tokens' ? (
                    <TokensPanel />
                  ) : (
                    <ComponentsPanel />
                  )}
                </Suspense>
              </ErrorBoundary>
              <ResizeHandle
                side="left"
                value={leftPanelWidth}
                min={LEFT_PANEL_MIN}
                max={leftPanelResizeMax}
                onChange={(value) => setLeftPanelWidth(clampLeftPanelWidth(value))}
                onCommit={(value) =>
                  updateWorkspacePreferences({ leftPanelWidth: clampLeftPanelWidth(value) })
                }
              />
            </aside>
          ) : (
            <PanelRail side="left" onOpen={() => setPanelVisibility('left', true)} />
          )}
          <div className="ptl-center-column">
            <ErrorBoundary key={documentId ?? 'no-document'} name="Canvas">
              <CanvasViewport
                camera={camera}
                activeTool={activeTool}
                overlay={<OverlayLayer camera={camera} />}
                onContentPointerDown={(e, viewport) => {
                  const tool = useEditor.getState().activeTool;
                  if (tool === 'select') onSelectPointerDown(e, camera, viewport);
                  else onInsertPointerDown(e, tool, camera, viewport);
                }}
                onContentPointerMove={(e) => {
                  if (useEditor.getState().activeTool === 'select') {
                    onSelectPointerMove(e);
                  }
                }}
                onContentPointerLeave={() => useEditor.getState().setHover(null)}
                onContentDoubleClick={(e) => {
                  if (useEditor.getState().activeTool === 'select') {
                    onSelectDoubleClick(e);
                  }
                }}
                onContentDrop={(e, viewport) => void handleImageDrop(e, camera, viewport)}
                onContentContextMenu={(e, viewport) => {
                  e.preventDefault();
                  // Right-click selects what's under the cursor first.
                  if (useEditor.getState().activeTool === 'select') {
                    onSelectPointerMove(e as unknown as PointerEvent);
                    const hovered = useEditor.getState().hoveredId;
                    if (hovered && !useEditor.getState().selection.includes(hovered)) {
                      useEditor.getState().select([hovered]);
                    }
                  }
                  void viewport;
                  setContextMenu({ x: e.clientX, y: e.clientY });
                }}
              >
                <WorldLayer />
              </CanvasViewport>
            </ErrorBoundary>
            <SelectionBar onFocusSelection={zoomToSelection} />
            {codePanelOpen && (
              <ErrorBoundary name="Code panel">
                <ResizeHandle
                  side="code"
                  value={codePanelHeight}
                  min={CODE_PANEL_MIN}
                  max={codePanelResizeMax}
                  onChange={(value) => setCodePanelHeight(clampCodePanelHeight(value))}
                  onCommit={(value) =>
                    updateWorkspacePreferences({ codePanelHeight: clampCodePanelHeight(value) })
                  }
                />
                <Suspense fallback={null}>
                  <CodePanel height={codePanelHeight} />
                </Suspense>
              </ErrorBoundary>
            )}
          </div>
          {rightPanelOpen ? (
            <aside className="ptl-panel ptl-panel--right" style={{ width: rightPanelWidth }}>
              <div className="ptl-panel-collapse ptl-panel-collapse--right">
                <PanelButton side="right" open onClick={() => setPanelVisibility('right', false)} />
              </div>
              <ErrorBoundary name="Inspector">
                <Suspense fallback={null}>
                  {rightPanelMode === 'comments' ? <CommentsPanel /> : <Inspector />}
                </Suspense>
              </ErrorBoundary>
              <ResizeHandle
                side="right"
                value={rightPanelWidth}
                min={RIGHT_PANEL_MIN}
                max={rightPanelResizeMax}
                onChange={(value) => setRightPanelWidth(clampRightPanelWidth(value))}
                onCommit={(value) =>
                  updateWorkspacePreferences({ rightPanelWidth: clampRightPanelWidth(value) })
                }
              />
            </aside>
          ) : (
            <PanelRail
              side="right"
              onOpen={() => {
                useEditor.getState().setRightPanelMode('design');
                setPanelVisibility('right', true);
              }}
            />
          )}
        </div>
        <ErrorBoundary name="Preview">
          <Suspense fallback={null}>
            <PreviewMode />
          </Suspense>
        </ErrorBoundary>
        <Palette ctx={commandCtx} />
        <ContextMenu state={contextMenu} ctx={commandCtx} onClose={() => setContextMenu(null)} />
      </div>
    </TooltipProvider>
  );
}

function selectedRootIds(
  doc: NonNullable<ReturnType<typeof useEditor.getState>['doc']>,
  selection: string[],
): string[] {
  const roots = new Set<string>();
  for (const selectedId of selection) {
    let current = doc.nodes[selectedId];
    while (current?.parent) current = doc.nodes[current.parent];
    if (current?.parent === null) roots.add(current.id);
  }
  return [...roots];
}

function fitMeasuredSelection(camera: CameraController, selection: string[]): boolean {
  const viewport = document.querySelector<HTMLElement>('[data-canvas-viewport]');
  if (!viewport) return false;
  const viewportRect = viewport.getBoundingClientRect();
  const rects = selection
    .map((id) =>
      document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.getBoundingClientRect(),
    )
    .filter((rect): rect is DOMRect => Boolean(rect && rect.width > 0 && rect.height > 0));
  if (rects.length === 0) return false;

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const worldStart = camera.toWorld({ x: left - viewportRect.left, y: top - viewportRect.top });
  const worldEnd = camera.toWorld({ x: right - viewportRect.left, y: bottom - viewportRect.top });
  camera.fitRect(
    {
      x: worldStart.x,
      y: worldStart.y,
      width: worldEnd.x - worldStart.x,
      height: worldEnd.y - worldStart.y,
    },
    { padding: 96, maxZoom: 2 },
  );
  return true;
}

function defaultPanelOpen(preferred: boolean): boolean {
  return preferred && (typeof window === 'undefined' || window.innerWidth > 980);
}

function availablePanelWidth(min: number, max: number, oppositeWidth: number): number {
  if (typeof window === 'undefined') return max;
  return Math.max(min, Math.min(max, window.innerWidth - oppositeWidth - 320));
}

function availableCodePanelHeight(): number {
  if (typeof window === 'undefined') return CODE_PANEL_MAX;
  return Math.max(CODE_PANEL_MIN, Math.min(CODE_PANEL_MAX, window.innerHeight - 260));
}

type ResizeSide = 'left' | 'right' | 'code';

function ResizeHandle({
  side,
  value,
  min,
  max,
  onChange,
  onCommit,
}: {
  side: ResizeSide;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const label = side === 'code' ? 'Resize code panel' : `Resize ${side} panel`;
  const vertical = side !== 'code';
  const direction = side === 'left' ? 1 : -1;
  const resizeCleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => resizeCleanup.current?.(), []);

  const keyboardResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (side === 'left') {
      if (event.key === 'ArrowLeft') delta = -10;
      if (event.key === 'ArrowRight') delta = 10;
    } else if (side === 'right') {
      if (event.key === 'ArrowLeft') delta = 10;
      if (event.key === 'ArrowRight') delta = -10;
    } else {
      if (event.key === 'ArrowUp') delta = 10;
      if (event.key === 'ArrowDown') delta = -10;
    }
    if (delta === 0) return;
    event.preventDefault();
    const next = clampResize(value + delta, min, max);
    onChange(next);
    onCommit(next);
  };

  const pointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanup.current?.();
    const start = side === 'code' ? event.clientY : event.clientX;
    let next = value;
    const root = document.documentElement;
    const previousCursor = root.style.cursor;
    const previousSelect = root.style.userSelect;
    root.style.cursor = vertical ? 'col-resize' : 'row-resize';
    root.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent) => {
      const current = side === 'code' ? moveEvent.clientY : moveEvent.clientX;
      next = clampResize(value + (current - start) * direction, min, max);
      onChange(next);
    };
    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      root.style.cursor = previousCursor;
      root.style.userSelect = previousSelect;
      if (resizeCleanup.current === cleanup) resizeCleanup.current = null;
      if (commit) onCommit(next);
    };
    const onEnd = () => finish(true);
    const cleanup = () => finish(false);
    resizeCleanup.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd, { once: true });
    window.addEventListener('pointercancel', onEnd, { once: true });
    window.addEventListener('blur', onEnd, { once: true });
  };

  return (
    <div
      className={`ptl-panel-resizer ptl-panel-resizer--${side}`}
      role="separator"
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      data-panel-resizer={side}
      onKeyDown={keyboardResize}
      onPointerDown={pointerResize}
    />
  );
}

function clampResize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function PanelButton({
  side,
  open,
  onClick,
}: {
  side: 'left' | 'right';
  open: boolean;
  onClick: () => void;
}) {
  const label = `${open ? 'Hide' : 'Show'} ${side} panel`;
  const Icon =
    side === 'left'
      ? open
        ? PanelLeftClose
        : PanelLeftOpen
      : open
        ? PanelRightClose
        : PanelRightOpen;
  return (
    <Tooltip content={label}>
      <IconButton label={label} size="sm" onClick={onClick}>
        <Icon size={13} />
      </IconButton>
    </Tooltip>
  );
}

function PanelRail({ side, onOpen }: { side: 'left' | 'right'; onOpen: () => void }) {
  return (
    <aside className={`ptl-panel ptl-panel--rail ptl-panel--rail-${side}`}>
      <PanelButton side={side} open={false} onClick={onOpen} />
    </aside>
  );
}
