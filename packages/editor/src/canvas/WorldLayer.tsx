import {
  resolveStyles,
  styleToCssProps,
  type FrameNode,
  type NodeId,
} from '@pitolet/schema';
import { memo, type CSSProperties } from 'react';
import { useEditor } from '../store/index.js';
import { NodeRenderer } from './NodeRenderer.js';
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

  if (!node || node.type !== 'frame' || !tokens || !breakpoints || !node.visible) return null;

  const resolved = resolveStyles(node.styles, {
    frameWidth: node.canvas.width,
    breakpoints,
    tokens,
  });
  const css = styleToCssProps(resolved) as CSSProperties;
  const autoHeight = node.canvas.height === 'auto';

  return (
    <div
      className="ptl-frame-wrapper"
      data-frame-wrapper={id}
      style={{
        left: node.canvas.x,
        top: node.canvas.y,
        width: node.canvas.width,
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
      </div>
      <div
        className="ptl-frame"
        data-node-id={id}
        data-frame
        style={{ ...css, height: autoHeight ? undefined : '100%', minHeight: autoHeight ? 40 : undefined }}
      >
        {node.children.map((childId) => (
          <NodeRenderer
            key={childId}
            id={childId}
            ctx={{
              frameWidth: node.canvas.width,
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
