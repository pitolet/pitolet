import { generateSelection, type CodegenTarget } from '@pitolet/codegen';
import { Button, IconButton, Tabs, Tooltip } from '@pitolet/ui';
import { Check, Copy, Download, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEditor } from '../store/index.js';
import { apiUrl } from '../sync/serverBase.js';
import './CodePanel.css';

/**
 * Live generated code for the current selection (or the first frame).
 * The code IS the design — same tokens, same semantics, zero translation.
 */
export function CodePanel() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const setOpen = useEditor((s) => s.setCodePanelOpen);
  const [target, setTarget] = useState<CodegenTarget>('react-tailwind');
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  const nodeId = selection[0] ?? doc?.rootOrder[0];
  const code = useMemo(() => {
    if (!doc || !nodeId || !doc.nodes[nodeId]) return '';
    try {
      return generateSelection(doc, nodeId, target);
    } catch (err) {
      return `// codegen error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, [doc, nodeId, target]);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const exportProject = () => {
    void fetch(apiUrl('/api/export'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc?.id }),
    })
      .then((r) => r.json())
      .then((res: { dir?: string; error?: string }) => {
        setExported(res.dir ?? res.error ?? 'failed');
        setTimeout(() => setExported(null), 4000);
      });
  };

  return (
    <div className="ptl-code-panel">
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
            <Button size="sm" variant="ghost" onClick={exportProject}>
              <Download size={12} /> Export
            </Button>
          </Tooltip>
          <Tooltip content="Copy code">
            <Button size="sm" variant="ghost" onClick={copy}>
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
