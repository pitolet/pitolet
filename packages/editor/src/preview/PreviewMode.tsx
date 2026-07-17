import { buildPreviewHtml } from '@pitolet/codegen';
import { IconButton, Tooltip } from '@pitolet/ui';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '../store/index.js';
import './PreviewMode.css';
import { previewWidthOptions, resolvePreviewAssetUrls } from './previewUtils.js';

/**
 * Interactive preview: the frame rendered from GENERATED code in an iframe —
 * hover states are real :hover rules, breakpoints are real media queries
 * responding to the iframe's width. The preview literally runs the export.
 */
export function PreviewMode() {
  const frameId = useEditor((s) => s.previewFrameId);
  const doc = useEditor((s) => s.doc);
  const setPreviewFrame = useEditor((s) => s.setPreviewFrame);
  const [width, setWidth] = useState(0);
  const widths = useMemo(() => previewWidthOptions(doc?.breakpoints ?? []), [doc?.breakpoints]);

  useEffect(() => {
    if (!frameId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setPreviewFrame(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [frameId, setPreviewFrame]);

  const srcdoc = useMemo(() => {
    if (!doc || !frameId || !doc.nodes[frameId]) return '';
    return resolvePreviewAssetUrls(buildPreviewHtml(doc, frameId), Object.keys(doc.assets));
  }, [doc, frameId]);

  if (!frameId || !doc) return null;
  const frameName = doc.nodes[frameId]?.name ?? '';

  return (
    <div className="ptl-preview">
      <div className="ptl-preview-bar">
        <span className="ptl-preview-title">{frameName}</span>
        <div className="ptl-preview-widths">
          {widths.map((w) => (
            <button
              key={w.label}
              type="button"
              className={`ptl-bp-chip ${width === w.value ? 'ptl-bp-chip--active' : ''}`}
              onClick={() => setWidth(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span className="ptl-preview-hint">Hover to test states</span>
        <Tooltip content="Close preview" shortcut="esc">
          <IconButton label="Close preview" onClick={() => setPreviewFrame(null)}>
            <X size={15} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="ptl-preview-stage">
        <div className="ptl-preview-frame-shell" style={width > 0 ? { width } : { width: '100%' }}>
          <iframe
            title="Preview"
            className="ptl-preview-iframe"
            srcDoc={srcdoc}
            sandbox="allow-same-origin"
          />
        </div>
      </div>
    </div>
  );
}
