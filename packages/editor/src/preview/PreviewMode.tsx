import { buildPreviewHtml } from '@pitolet/codegen';
import { IconButton, Tooltip } from '@pitolet/ui';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '../store/index.js';
import './PreviewMode.css';

const WIDTHS = [
  { label: 'Fill', value: 0 },
  { label: '375', value: 375 },
  { label: '768', value: 768 },
  { label: '1024', value: 1024 },
  { label: '1280', value: 1280 },
];

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewFrame(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPreviewFrame]);

  const srcdoc = useMemo(() => {
    if (!doc || !frameId || !doc.nodes[frameId]) return '';
    return buildPreviewHtml(doc, frameId);
  }, [doc, frameId]);

  if (!frameId || !doc) return null;
  const frameName = doc.nodes[frameId]?.name ?? '';

  return (
    <div className="ptl-preview">
      <div className="ptl-preview-bar">
        <span className="ptl-preview-title">{frameName}</span>
        <div className="ptl-preview-widths">
          {WIDTHS.map((w) => (
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
        <span className="ptl-preview-hint">Real CSS. Try hovering.</span>
        <Tooltip content="Close preview" shortcut="esc">
          <IconButton label="Close preview" onClick={() => setPreviewFrame(null)}>
            <X size={15} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="ptl-preview-stage">
        <iframe
          title="Preview"
          className="ptl-preview-iframe"
          style={width > 0 ? { width } : { width: '100%' }}
          srcDoc={srcdoc}
          sandbox="allow-same-origin"
        />
      </div>
    </div>
  );
}
