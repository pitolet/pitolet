import {
  colorToCss,
  colorToHex,
  mergeParsedTokens,
  parseColor,
  parseCssTokens,
  px,
  type Color,
  type Length,
  type TokenSet,
} from '@pitolet/schema';
import { Button, IconButton, NumberScrubInput, Popover, Tooltip } from '@pitolet/ui';
import { Download, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useEditor } from '../store/index.js';
import { useCoalesceKey } from '../inspector/useStyle.js';
import './TokensPanel.css';

/**
 * Design tokens — the document's single source of styling truth. Edits
 * reflow the whole canvas live and re-emit through codegen as @theme vars.
 */
export function TokensPanel() {
  const tokens = useEditor((s) => s.doc?.tokens);
  if (!tokens) return <div className="ptl-panel-empty">Connecting…</div>;

  return (
    <div className="ptl-tokens">
      <ImportTokens />
      <ColorTokens colors={tokens.color} />
      <LengthTokens
        title="Spacing"
        category="spacing"
        entries={tokens.spacing}
        newName={(n) => String(n)}
        newValue={px(4)}
      />
      <LengthTokens
        title="Radius"
        category="radius"
        entries={tokens.radius}
        newName={(n) => `radius-${n}`}
        newValue={px(4)}
      />
      <LengthTokens
        title="Font size"
        category="typography.fontSize"
        entries={tokens.typography.fontSize}
        newName={(n) => `size-${n}`}
        newValue={px(16)}
      />
    </div>
  );
}

/**
 * Import your project's real tokens from CSS (Tailwind v4 @theme / :root
 * custom properties) — paste or pick a file. Same parser the MCP
 * import_design_system tool uses.
 */
function ImportTokens() {
  const [open, setOpen] = useState(false);
  const [css, setCss] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const runImport = (text: string) => {
    const parsed = parseCssTokens(text);
    if (parsed.count === 0) {
      setResult('No recognizable tokens found (--color-*, --spacing-*, --radius-*, --shadow-*, --font-*, --text-*).');
      return;
    }
    useEditor.getState().dispatchEdit(`Import ${parsed.count} design tokens`, (draft) => {
      mergeParsedTokens(draft.tokens, parsed.tokens);
    });
    setResult(
      `Imported ${parsed.count} token${parsed.count === 1 ? '' : 's'}${parsed.skipped.length > 0 ? ` · ${parsed.skipped.length} skipped` : ''}.`,
    );
    setCss('');
  };

  return (
    <div className="ptl-token-section">
      <div className="ptl-token-header">
        <span>Import</span>
        <Tooltip content="Import tokens from your project's CSS">
          <IconButton label="Import tokens" size="sm" active={open} onClick={() => { setOpen(!open); setResult(null); }}>
            <Download size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {open && (
        <div className="ptl-token-import">
          <textarea
            className="ptl-token-import-input"
            placeholder={'Paste CSS with design tokens, e.g.\n@theme {\n  --color-brand: #6d28d9;\n  --spacing-gutter: 1.5rem;\n}'}
            rows={5}
            value={css}
            onChange={(e) => setCss(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="ptl-token-import-actions">
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
              Choose file…
            </Button>
            <Button size="sm" variant="primary" disabled={!css.trim()} onClick={() => runImport(css)}>
              Import
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".css,text/css"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void file.text().then((text) => runImport(text));
              e.target.value = '';
            }}
          />
          {result && <div className="ptl-token-import-result">{result}</div>}
        </div>
      )}
    </div>
  );
}

function ColorTokens({ colors }: { colors: TokenSet['color'] }) {
  const keys = useCoalesceKey();
  const [adding, setAdding] = useState(false);

  const write = (name: string, value: Color, coalesce: boolean) => {
    useEditor.getState().dispatchEdit(
      'Edit color token',
      (draft) => {
        draft.tokens.color[name] = { ...draft.tokens.color[name], $value: value };
      },
      coalesce ? { coalesceKey: keys.current() } : undefined,
    );
  };

  return (
    <div className="ptl-token-section">
      <div className="ptl-token-header">
        <span>Colors</span>
        <Tooltip content="Add color token">
          <IconButton label="Add color" size="sm" onClick={() => setAdding(true)}>
            <Plus size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {Object.entries(colors).map(([name, token]) => (
        <div key={name} className="ptl-token-row">
          <Popover
            trigger={
              <button type="button" className="ptl-token-swatch-btn">
                <span className="ptl-token-swatch" style={{ background: colorToCss(token.$value) }} />
              </button>
            }
          >
            <input
              type="color"
              className="ptl-token-color-input"
              value={colorToHex(token.$value).slice(0, 7)}
              onPointerDown={() => keys.begin()}
              onChange={(e) => {
                const parsed = parseColor(e.target.value);
                if (parsed) write(name, parsed, true);
              }}
            />
          </Popover>
          <span className="ptl-token-name" title={`color.${name}`}>
            {name}
          </span>
          <span className="ptl-token-value">{colorToHex(token.$value).toUpperCase()}</span>
          <DeleteToken onDelete={() => deleteToken('color', name)} />
        </div>
      ))}
      {adding && (
        <NewTokenRow
          placeholder="token-name"
          onSubmit={(name) => {
            setAdding(false);
            if (!name) return;
            useEditor.getState().dispatchEdit('Add color token', (draft) => {
              draft.tokens.color[name] = { $value: { space: 'oklch', l: 0.6, c: 0.1, h: 250 } };
            });
          }}
        />
      )}
    </div>
  );
}

function LengthTokens({
  title,
  category,
  entries,
  newName,
  newValue,
}: {
  title: string;
  category: 'spacing' | 'radius' | 'typography.fontSize';
  entries: Record<string, { $value: Length }>;
  newName: (count: number) => string;
  newValue: Length;
}) {
  const keys = useCoalesceKey();
  const [adding, setAdding] = useState(false);

  const bucket = (draft: { tokens: TokenSet }) =>
    category === 'spacing'
      ? draft.tokens.spacing
      : category === 'radius'
        ? draft.tokens.radius
        : draft.tokens.typography.fontSize;

  return (
    <div className="ptl-token-section">
      <div className="ptl-token-header">
        <span>{title}</span>
        <Tooltip content={`Add ${title.toLowerCase()} token`}>
          <IconButton label={`Add ${title}`} size="sm" onClick={() => setAdding(true)}>
            <Plus size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {Object.entries(entries).map(([name, token]) => (
        <div key={name} className="ptl-token-row">
          <span className="ptl-token-name" title={`${category}.${name}`}>
            {name}
          </span>
          <NumberScrubInput
            value={token.$value.value}
            min={0}
            onChange={(v, o) => {
              if (!o.transient) keys.begin();
              useEditor.getState().dispatchEdit(
                `Edit ${title.toLowerCase()} token`,
                (draft) => {
                  bucket(draft)[name] = { ...bucket(draft)[name], $value: px(v) };
                },
                { coalesceKey: keys.current() },
              );
            }}
            onCommit={() => keys.begin()}
            className="ptl-token-scrub"
          />
          <DeleteToken onDelete={() => deleteToken(category, name)} />
        </div>
      ))}
      {adding && (
        <NewTokenRow
          placeholder={newName(Object.keys(entries).length + 1)}
          onSubmit={(name) => {
            setAdding(false);
            if (!name) return;
            useEditor.getState().dispatchEdit(`Add ${title.toLowerCase()} token`, (draft) => {
              bucket(draft)[name] = { $value: newValue };
            });
          }}
        />
      )}
    </div>
  );
}

function NewTokenRow({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
}) {
  return (
    <div className="ptl-token-row">
      <input
        className="ptl-token-new"
        placeholder={placeholder}
        autoFocus
        onBlur={(e) => onSubmit(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') onSubmit('');
        }}
      />
    </div>
  );
}

function DeleteToken({ onDelete }: { onDelete: () => void }) {
  return (
    <button type="button" className="ptl-token-delete" title="Delete token" onClick={onDelete}>
      <Trash2 size={11} />
    </button>
  );
}

function deleteToken(category: string, name: string): void {
  useEditor.getState().dispatchEdit('Delete token', (draft) => {
    if (category === 'color') delete draft.tokens.color[name];
    else if (category === 'spacing') delete draft.tokens.spacing[name];
    else if (category === 'radius') delete draft.tokens.radius[name];
    else if (category === 'typography.fontSize') delete draft.tokens.typography.fontSize[name];
  });
}
