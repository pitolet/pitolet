import {
  resolveStyles,
  rootFrameOf,
  styleToCssProps,
  type FrameNode,
  type NodeId,
} from '@pitolet/schema';
import { memo, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../store/index.js';
import { NodeRenderer } from './NodeRenderer.js';
import { breakpointDisplayLabel, responsivePreviewWidth } from './responsivePreview.js';
import './canvas-content.css';

/** All root frames of the open document, rendered into the camera world. */
export function WorldLayer() {
  const rootOrder = useEditor((s) => s.doc?.rootOrder);
  if (!rootOrder) return null;
  return (
    <>
      {rootOrder.map((id) => (
        <FrameHost key={id} id={id} />
      ))}
    </>
  );
}

/**
 * A top-level frame (artboard): the only node kind with canvas coordinates.
 * The wrapper carries canvas position and the (unclipped) name label; the
 * inner .ptl-frame element is the real frame box that content flows in and
 * that overlays/hit-testing measure via data-node-id.
 */
const FrameHost = memo(function FrameHost({ id }: { id: NodeId }) {
  const node = useEditor((s) => s.doc?.nodes[id]) as FrameNode | undefined;
  const tokens = useEditor((s) => s.doc?.tokens);
  const breakpoints = useEditor((s) => s.doc?.breakpoints);
  const isSelected = useEditor((s) => s.selection.includes(id));
  const previewState = useEditor((s) =>
    s.editingContext.state && s.selection.includes(id) ? s.editingContext.state : null,
  );
  const preview = useEditor(
    useShallow((s) => {
      if (!s.doc) return { width: null, breakpointId: null };
      const selectedFrames = new Set(
        s.selection
          .filter((selectedId) => Boolean(s.doc?.nodes[selectedId]))
          .map((selectedId) => rootFrameOf(s.doc!.nodes, selectedId)),
      );
      const activeFrameId =
        selectedFrames.size > 0 ? (selectedFrames.has(id) ? id : null) : s.responsivePreviewFrameId;
      return {
        width: responsivePreviewWidth(
          id,
          activeFrameId,
          s.doc.breakpoints,
          s.editingContext.breakpointId,
        ),
        breakpointId: s.editingContext.breakpointId,
      };
    }),
  );

  if (!node || node.type !== 'frame' || !tokens || !breakpoints || !node.visible) return null;

  const renderWidth = preview.width ?? node.canvas.width;
  const previewBreakpoint =
    preview.width === null
      ? null
      : breakpoints.find((breakpoint) => breakpoint.id === preview.breakpointId);

  const resolved = resolveStyles(node.styles, {
    frameWidth: renderWidth,
    breakpoints,
    tokens,
    activeStates: previewState ? [previewState] : undefined,
  });
  const css = styleToCssProps(resolved) as CSSProperties;
  const autoHeight = node.canvas.height === 'auto';

  return (
    <div
      className={`ptl-frame-wrapper ${previewBreakpoint ? 'ptl-frame-wrapper--breakpoint-preview' : ''}`}
      data-frame-wrapper={id}
      data-breakpoint-preview={previewBreakpoint?.id}
      style={{
        left: node.canvas.x,
        top: node.canvas.y,
        width: renderWidth,
        height: autoHeight ? undefined : node.canvas.height,
      }}
    >
      <div
        className={[
          'ptl-frame-label',
          isSelected ? 'ptl-frame-label--selected' : '',
          node.isComponentMaster ? 'ptl-frame-label--master' : '',
        ].join(' ')}
        data-frame-label={id}
      >
        {node.isComponentMaster ? '◈ ' : ''}
        {node.name}
        {previewBreakpoint && (
          <span className="ptl-frame-label-context">
            <strong>{breakpointDisplayLabel(previewBreakpoint)}</strong>
            <span>{previewBreakpoint.minWidth}px+</span>
          </span>
        )}
      </div>
      <div
        className="ptl-frame"
        data-node-id={id}
        data-frame
        style={{
          ...css,
          height: autoHeight ? undefined : '100%',
          minHeight: autoHeight ? 40 : undefined,
        }}
      >
        {node.children.map((childId) => (
          <NodeRenderer
            key={childId}
            id={childId}
            ctx={{
              frameWidth: renderWidth,
              breakpoints,
              tokens,
              parentDisplay: resolved.display,
              parentDirection: resolved.flexDirection,
              masterComponentId: node.isComponentMaster,
            }}
          />
        ))}
      </div>
      <div className="ptl-frame-edge" />
    </div>
  );
});
