import { generateSelection, type CodegenTarget } from '@pitolet/codegen';
import { Button, IconButton, Tabs, Tooltip } from '@pitolet/ui';
import { Check, Copy, Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store/index.js';
import { apiUrl } from '../sync/serverBase.js';
import './CodePanel.css';

/**
 * Live generated code for the current selection (or the first frame).
 * The code IS the design — same tokens, same semantics, zero translation.
 */
export function CodePanel({ height }: { height: number }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const setOpen = useEditor((s) => s.setCodePanelOpen);
  const [target, setTarget] = useState<CodegenTarget>('react-tailwind');
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  const nodeId = selection[0] ?? doc?.rootOrder[0];

  useEffect(() => {
    if (!doc || !nodeId || !doc.nodes[nodeId]) {
      setCode('');
      return;
    }
    // Inspector scrubs and colour drags can update the document dozens of
    // times per second. Generate only after that burst settles so codegen
    // never blocks the pointer path or runs for every transient patch.
    const timer = setTimeout(() => {
      try {
        setCode(generateSelection(doc, nodeId, target));
      } catch (err) {
        setCode(`// codegen error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [doc, nodeId, target]);

  const showFeedback = (message: string, duration = 4000) => {
    setExported(message);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setExported(null), duration);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : 'Could not copy code');
    }
  };

  const exportProject = async () => {
    try {
      const response = await fetch(apiUrl('/api/export'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: doc?.id }),
      });
      const result = (await response.json()) as { dir?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? `Export failed (${response.status})`);
      showFeedback(result.dir ?? result.error ?? 'Export finished');
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : 'Export failed');
    }
  };

  return (
    <div className="ptl-code-panel" style={{ height }}>
      <div className="ptl-code-header">
        <Tabs
          value={target}
          onValueChange={(v) => setTarget(v as CodegenTarget)}
          tabs={[
            { value: 'react-tailwind', label: 'React + Tailwind' },
            { value: 'html', label: 'HTML + CSS' },
          ]}
          size="sm"
        />
        <span className="ptl-code-target-name">
          {nodeId && doc?.nodes[nodeId] ? doc.nodes[nodeId]!.name : ''}
        </span>
        <div className="ptl-code-actions">
          {exported && <span className="ptl-code-exported">→ {exported}</span>}
          <Tooltip content="Export full project to disk">
            <Button size="sm" variant="ghost" onClick={() => void exportProject()}>
              <Download size={12} /> Export
            </Button>
          </Tooltip>
          <Tooltip content="Copy code">
            <Button size="sm" variant="ghost" onClick={() => void copy()}>
              {copied ? <Check size={12} /> : <Copy size={12} />} Copy
            </Button>
          </Tooltip>
          <IconButton label="Close" size="sm" onClick={() => setOpen(false)}>
            <X size={13} />
          </IconButton>
        </div>
      </div>
      <pre className="ptl-code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}
