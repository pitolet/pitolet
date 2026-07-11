import {
  colorToCss,
  colorToHex,
  getToken,
  isTokenRef,
  parseColor,
  px,
  type Color,
  type Length,
  type Size,
  type StyleValue,
  type TokenSet,
} from '@pitolet/schema';
import { NumberScrubInput, Popover, Select } from '@pitolet/ui';
import { useState, type ReactNode } from 'react';
import { useEditor } from '../store/index.js';
import { useCoalesceKey } from './useStyle.js';
import './fields.css';

export function useTokens(): TokenSet | undefined {
  return useEditor((s) => s.doc?.tokens);
}

/** Resolve a possibly-token-bound value for display. */
export function useResolved<T>(value: StyleValue<T> | undefined): {
  resolved: T | undefined;
  tokenPath: string | null;
} {
  const tokens = useTokens();
  if (value === undefined) return { resolved: undefined, tokenPath: null };
  if (isTokenRef(value)) {
    return {
      resolved: tokens ? (getToken(tokens, value.$token) as T | undefined) : undefined,
      tokenPath: value.$token,
    };
  }
  return { resolved: value, tokenPath: null };
}

// ---------------------------------------------------------------------------

export function LengthField({
  value,
  mixed,
  label,
  title,
  min = 0,
  tokenCategory,
  onWrite,
}: {
  value: StyleValue<Length> | undefined;
  mixed: boolean;
  label?: ReactNode;
  title?: string;
  min?: number;
  /** Enables the token-bind popover listing this category's tokens. */
  tokenCategory?: 'spacing' | 'radius' | 'fontSize';
  onWrite: (length: StyleValue<Length>, coalesceKey: string) => void;
}) {
  const { resolved, tokenPath } = useResolved(value);
  const keys = useCoalesceKey();
  return (
    <div className={`ptl-field ${tokenPath ? 'ptl-field--token' : ''}`} title={tokenPath ?? title}>
      <NumberScrubInput
        value={mixed ? null : (resolved?.value ?? 0)}
        label={label}
        title={title}
        min={min}
        onChange={(v, { transient }) => {
          if (!transient) keys.begin();
          onWrite(px(v), keys.current());
        }}
        onCommit={() => keys.begin()}
        className="ptl-field-scrub"
      />
      {tokenCategory && (
        <TokenBind
          category={tokenCategory}
          activePath={tokenPath}
          onBind={(path) => {
            keys.begin();
            onWrite({ $token: path }, keys.current());
          }}
          onUnbind={() => {
            if (resolved) {
              keys.begin();
              onWrite(resolved, keys.current());
            }
          }}
        />
      )}
      {tokenPath && <span className="ptl-token-dot" title={tokenPath} />}
    </div>
  );
}

/** Popover listing bindable tokens for a length category. */
function TokenBind({
  category,
  activePath,
  onBind,
  onUnbind,
}: {
  category: 'spacing' | 'radius' | 'fontSize';
  activePath: string | null;
  onBind: (path: string) => void;
  onUnbind: () => void;
}) {
  const tokens = useTokens();
  if (!tokens) return null;
  const entries: Array<[string, { $value: Length }]> =
    category === 'spacing'
      ? Object.entries(tokens.spacing)
      : category === 'radius'
        ? Object.entries(tokens.radius)
        : Object.entries(tokens.typography.fontSize);
  const prefix =
    category === 'spacing' ? 'spacing' : category === 'radius' ? 'radius' : 'typography.fontSize';

  return (
    <Popover
      className="ptl-token-bind-popover"
      trigger={
        <button
          type="button"
          className={`ptl-token-bind ${activePath ? 'ptl-token-bind--active' : ''}`}
          title="Bind to token"
        >
          ◈
        </button>
      }
    >
      <div className="ptl-token-bind-list">
        {activePath && (
          <button type="button" className="ptl-token-bind-item ptl-token-bind-item--unbind" onClick={onUnbind}>
            Detach token
          </button>
        )}
        {entries.map(([name, token]) => {
          const path = `${prefix}.${name}`;
          return (
            <button
              key={name}
              type="button"
              className={`ptl-token-bind-item ${path === activePath ? 'ptl-token-bind-item--active' : ''}`}
              onClick={() => onBind(path)}
            >
              <span>{name}</span>
              <span className="ptl-token-bind-value">{token.$value.value}px</span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------

const SIZE_UNITS = [
  { value: 'px', label: 'px' },
  { value: '%', label: '%' },
  { value: 'rem', label: 'rem' },
  { value: 'auto', label: 'Auto' },
  { value: 'fill', label: 'Fill' },
] as const;

export function SizeField({
  value,
  mixed,
  label,
  title,
  onWrite,
}: {
  value: StyleValue<Size> | undefined;
  mixed: boolean;
  label: ReactNode;
  title?: string;
  onWrite: (size: Size | undefined, coalesceKey: string) => void;
}) {
  const { resolved } = useResolved(value);
  const keys = useCoalesceKey();
  const kind = resolved === undefined ? 'auto' : resolved === 'auto' ? 'auto' : resolved === 'fill' ? 'fill' : resolved.unit;
  const numeric = resolved !== undefined && resolved !== 'auto' && resolved !== 'fill' ? resolved.value : null;

  return (
    <div className="ptl-field ptl-field--size" title={title}>
      <NumberScrubInput
        value={mixed ? null : numeric}
        label={label}
        disabled={numeric === null && !mixed}
        placeholder={mixed ? 'Mixed' : '–'}
        min={0}
        precision={1}
        onChange={(v, { transient }) => {
          if (!transient) keys.begin();
          const unit = kind === 'auto' || kind === 'fill' ? 'px' : kind;
          onWrite({ value: v, unit }, keys.current());
        }}
        onCommit={() => keys.begin()}
        className="ptl-field-scrub"
      />
      <Select
        value={kind}
        options={SIZE_UNITS as unknown as { value: string; label: string }[]}
        onValueChange={(unit) => {
          keys.begin();
          if (unit === 'auto') onWrite('auto', keys.current());
          else if (unit === 'fill') onWrite('fill', keys.current());
          else {
            const base = numeric ?? (unit === '%' ? 100 : unit === 'rem' ? 1 : 100);
            onWrite({ value: base, unit: unit as Length['unit'] }, keys.current());
          }
        }}
        className="ptl-size-unit"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ColorField({
  value,
  mixed,
  onWrite,
  onBind,
  onClear,
}: {
  value: StyleValue<Color> | undefined;
  mixed: boolean;
  onWrite: (color: Color, coalesceKey: string) => void;
  /** When provided, the popover shows a bindable token swatch row. */
  onBind?: (path: string) => void;
  onClear?: () => void;
}) {
  const { resolved, tokenPath } = useResolved(value);
  const tokens = useTokens();
  const keys = useCoalesceKey();
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const hex = resolved ? colorToHex(resolved) : '#ffffff';
  const alpha = resolved?.alpha ?? 1;

  return (
    <Popover
      className="ptl-color-popover"
      trigger={
        <button type="button" className="ptl-color-trigger" title={tokenPath ?? undefined}>
          <span
            className={`ptl-color-swatch ${!resolved && !mixed ? 'ptl-color-swatch--unset' : ''}`}
            style={resolved ? { background: colorToCss(resolved) } : undefined}
          />
          <span className={`ptl-color-value ${!resolved && !mixed ? 'ptl-color-value--muted' : ''}`}>
            {mixed
              ? 'Mixed'
              : tokenPath
                ? tokenPath.replace('color.', '')
                : resolved
                  ? hex.replace('#', '').toUpperCase()
                  : 'Inherit'}
          </span>
        </button>
      }
    >
      <div className="ptl-color-editor">
        {onBind && tokens && (
          <div className="ptl-color-token-row">
            {Object.entries(tokens.color).map(([name, token]) => (
              <button
                key={name}
                type="button"
                className={`ptl-color-token-swatch ${tokenPath === `color.${name}` ? 'ptl-color-token-swatch--active' : ''}`}
                title={`color.${name}`}
                style={{ background: colorToCss(token.$value) }}
                onClick={() => onBind(`color.${name}`)}
              />
            ))}
          </div>
        )}
        <input
          type="color"
          className="ptl-color-native"
          value={hex.slice(0, 7)}
          onChange={(e) => {
            const parsed = parseColor(e.target.value);
            if (parsed) {
              onWrite({ ...parsed, alpha: alpha < 1 ? alpha : undefined } as Color, keys.current());
            }
          }}
        />
        <div className="ptl-color-row">
          <span className="ptl-color-label">Hex</span>
          <input
            className="ptl-color-hex"
            value={hexDraft ?? hex.replace('#', '').toUpperCase()}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={(e) => {
              const parsed = parseColor(`#${e.target.value.replace('#', '')}`);
              if (parsed) {
                keys.begin();
                onWrite(parsed, keys.current());
              }
              setHexDraft(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>
        <div className="ptl-color-row">
          <span className="ptl-color-label">Alpha</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(alpha * 100)}
            onChange={(e) => {
              if (!resolved) return;
              const a = Number(e.target.value) / 100;
              onWrite({ ...resolved, alpha: a >= 1 ? undefined : a } as Color, keys.current());
            }}
            onPointerDown={() => keys.begin()}
          />
          <span className="ptl-color-alpha">{Math.round(alpha * 100)}%</span>
        </div>
        {onClear && (
          <button type="button" className="ptl-color-clear" onClick={onClear}>
            Remove
          </button>
        )}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------

export function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="ptl-insp-row">
      {label !== undefined && <span className="ptl-insp-row-label">{label}</span>}
      <div className="ptl-insp-row-fields">{children}</div>
    </div>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="ptl-insp-section">
      <div className="ptl-insp-section-header">
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </div>
  );
}
