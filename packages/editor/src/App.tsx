import { TooltipProvider } from '@pitolet/ui';
import { useEffect, useMemo } from 'react';
import { CameraController } from './canvas/CameraController.js';
import { CanvasViewport } from './canvas/CanvasViewport.js';
import { installCulling } from './canvas/culling.js';
import { handleImageDrop } from './canvas/interaction/dropImages.js';
import { onInsertPointerDown } from './canvas/interaction/insertTools.js';
import { syncDocumentFonts } from './fonts/googleFonts.js';
import {
  onSelectDoubleClick,
  onSelectPointerDown,
  onSelectPointerMove,
} from './canvas/interaction/selectTool.js';
import { OverlayLayer } from './canvas/overlay/OverlayLayer.js';
import { WorldLayer } from './canvas/WorldLayer.js';
import { Tabs } from '@pitolet/ui';
import { useState } from 'react';
import { ContextMenu, type ContextMenuState } from './commands/ContextMenu.js';
import { Palette } from './commands/Palette.js';
import type { CommandContext } from './commands/registry.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Inspector } from './inspector/Inspector.js';
import { installKeyboard } from './keyboard.js';
import { CodePanel } from './panels/CodePanel.js';
import { ComponentsPanel } from './panels/ComponentsPanel.js';
import { LayersPanel } from './panels/LayersPanel.js';
import { TokensPanel } from './panels/TokensPanel.js';
import { PreviewMode } from './preview/PreviewMode.js';
import { TopBar } from './panels/TopBar.js';
import { LoginScreen } from './panels/LoginScreen.js';
import { useEditor } from './store/index.js';
import { connection } from './sync/connection.js';
import './App.css';

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
  const activeTool = useEditor((s) => s.activeTool);
  const setTool = useEditor((s) => s.setTool);
  const connected = useEditor((s) => s.connected);
  const docName = useEditor((s) => s.doc?.name);
  const codePanelOpen = useEditor((s) => s.codePanelOpen);
  const leftPanelTab = useEditor((s) => s.leftPanelTab);
  const setLeftPanelTab = useEditor((s) => s.setLeftPanelTab);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const commandCtx: CommandContext = {
    zoomToFit: () => zoomToFit(),
    zoomIn: () => camera.setZoomCentered(camera.zoom * 1.25),
    zoomOut: () => camera.setZoomCentered(camera.zoom / 1.25),
    zoomTo100: () => camera.setZoomCentered(1),
    openPreview: () => void import('./panels/TopBar.js').then((m) => m.openPreview()),
  };

  const contentBounds = () => {
    const doc = useEditor.getState().doc;
    if (!doc || doc.rootOrder.length === 0) return { x: 0, y: 0, width: 1280, height: 800 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of doc.rootOrder) {
      const node = doc.nodes[id];
      if (node?.type !== 'frame') continue;
      const height = node.canvas.height === 'auto' ? 600 : node.canvas.height;
      minX = Math.min(minX, node.canvas.x);
      minY = Math.min(minY, node.canvas.y);
      maxX = Math.max(maxX, node.canvas.x + node.canvas.width);
      maxY = Math.max(maxY, node.canvas.y + height);
    }
    if (minX === Infinity) return { x: 0, y: 0, width: 1280, height: 800 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };

  const zoomToFit = () => camera.fitRect(contentBounds());

  useEffect(() => {
    void connection.start().catch((err) => console.error('[pitolet] connect failed:', err));
    return () => connection.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => installKeyboard(camera, zoomToFit), [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => installCulling(camera), [camera]);

  // Keep every document-referenced Google Font loaded.
  useEffect(() => {
    syncDocumentFonts(useEditor.getState().doc);
    return useEditor.subscribe((state, prev) => {
      if (state.doc !== prev.doc) syncDocumentFonts(state.doc);
    });
  }, []);

  return (
    <TooltipProvider>
      <div className="ptl-app">
        <TopBar
          camera={camera}
          activeTool={activeTool}
          onToolChange={(tool) => setTool(tool as never)}
          onZoomToFit={zoomToFit}
          docName={docName}
          connected={connected}
        />
        <div className="ptl-app-body">
          <aside className="ptl-panel ptl-panel--left">
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
            </div>
            <ErrorBoundary name="Left panel">
              {leftPanelTab === 'layers' ? (
                <LayersPanel />
              ) : leftPanelTab === 'tokens' ? (
                <TokensPanel />
              ) : (
                <ComponentsPanel />
              )}
            </ErrorBoundary>
          </aside>
          <div className="ptl-center-column">
            <CanvasViewport
              camera={camera}
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
            {codePanelOpen && (
              <ErrorBoundary name="Code panel">
                <CodePanel />
              </ErrorBoundary>
            )}
          </div>
          <aside className="ptl-panel ptl-panel--right">
            <ErrorBoundary name="Inspector">
              <Inspector />
            </ErrorBoundary>
          </aside>
        </div>
        <ErrorBoundary name="Preview">
          <PreviewMode />
        </ErrorBoundary>
        <Palette ctx={commandCtx} />
        <ContextMenu state={contextMenu} ctx={commandCtx} onClose={() => setContextMenu(null)} />
      </div>
    </TooltipProvider>
  );
}
