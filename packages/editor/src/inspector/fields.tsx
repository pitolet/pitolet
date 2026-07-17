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
import { ChevronDown, ChevronRight, Pipette, RotateCcw } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useEditor } from '../store/index.js';
import {
  isInspectorSectionCollapsed,
  setInspectorSectionCollapsed,
} from '../workspacePreferences.js';
import { hexToHsv, hsvToHex, type HsvColor } from './colorPicker.js';
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
          <button
            type="button"
            className="ptl-token-bind-item ptl-token-bind-item--unbind"
            onClick={onUnbind}
          >
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
  { value: 'em', label: 'em' },
  { value: 'vw', label: 'vw' },
  { value: 'vh', label: 'vh' },
  { value: 'auto', label: 'Auto' },
  { value: 'fill', label: 'Fill' },
] as const;

const CONSTRAINT_UNITS = [
  { value: 'unset', label: 'None' },
  { value: 'px', label: 'px' },
  { value: '%', label: '%' },
  { value: 'rem', label: 'rem' },
  { value: 'em', label: 'em' },
  { value: 'vw', label: 'vw' },
  { value: 'vh', label: 'vh' },
] as const;

export function SizeField({
  value,
  mixed,
  label,
  title,
  mode = 'size',
  onWrite,
}: {
  value: StyleValue<Size> | undefined;
  mixed: boolean;
  label: ReactNode;
  title?: string;
  /** Constraints can be unset, but cannot meaningfully be Auto or Fill. */
  mode?: 'size' | 'constraint';
  onWrite: (size: Size | undefined, coalesceKey: string) => void;
}) {
  const { resolved } = useResolved(value);
  const keys = useCoalesceKey();
  const kind =
    resolved === undefined
      ? mode === 'constraint'
        ? 'unset'
        : 'auto'
      : resolved === 'auto'
        ? 'auto'
        : resolved === 'fill'
          ? 'fill'
          : resolved.unit;
  const numeric =
    resolved !== undefined && resolved !== 'auto' && resolved !== 'fill' ? resolved.value : null;

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
          const unit = kind === 'auto' || kind === 'fill' || kind === 'unset' ? 'px' : kind;
          onWrite({ value: v, unit }, keys.current());
        }}
        onCommit={() => keys.begin()}
        className="ptl-field-scrub"
      />
      <Select
        value={kind}
        options={
          (mode === 'constraint' ? CONSTRAINT_UNITS : SIZE_UNITS) as unknown as {
            value: string;
            label: string;
          }[]
        }
        onValueChange={(unit) => {
          keys.begin();
          if (unit === 'unset') onWrite(undefined, keys.current());
          else if (unit === 'auto') onWrite('auto', keys.current());
          else if (unit === 'fill') onWrite('fill', keys.current());
          else {
            const base =
              numeric ?? (unit === '%' ? 100 : unit === 'rem' || unit === 'em' ? 1 : 100);
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
  trigger,
}: {
  value: StyleValue<Color> | undefined;
  mixed: boolean;
  onWrite: (color: Color, coalesceKey: string) => void;
  /** When provided, the popover shows a bindable token swatch row. */
  onBind?: (path: string) => void;
  onClear?: () => void;
  /** Optional compact trigger for places such as the Tokens panel. */
  trigger?: ReactElement<Record<string, unknown>>;
}) {
  const { resolved, tokenPath } = useResolved(value);
  const tokens = useTokens();
  const keys = useCoalesceKey();
  const areaRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const cancelHexCommit = useRef(false);
  const pendingColor = useRef<Color | null>(null);
  const colorWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestOnWrite = useRef(onWrite);
  latestOnWrite.current = onWrite;
  const hex = resolved ? colorToHex(resolved) : '#ffffff';
  const baseHex = hex.slice(0, 7);
  const alpha = resolved?.alpha ?? 1;
  const currentHsv = hexToHsv(baseHex);
  const [hue, setHue] = useState(currentHsv.h);
  const hsv = { ...currentHsv, h: hue };
  const opaqueColor = parseColor(baseHex)!;
  const pickerStyle = {
    '--ptl-picker-hue': `${hue}deg`,
    '--ptl-picker-color': colorToCss(opaqueColor),
  } as CSSProperties;
  const displayHex = baseHex.replace('#', '').toUpperCase();
  const displayValue = alpha < 1 ? `${displayHex} · ${Math.round(alpha * 100)}%` : displayHex;
  const draftValue = hexDraft ?? displayHex;
  const draftValid = /^(?:[0-9A-F]{3}|[0-9A-F]{6})$/i.test(draftValue);
  const eyeDropperAvailable = typeof window !== 'undefined' && 'EyeDropper' in window;

  useEffect(() => {
    if (currentHsv.s > 0.001) setHue(currentHsv.h);
  }, [baseHex, currentHsv.h, currentHsv.s]);

  const flushColorWrite = () => {
    if (colorWriteTimer.current) {
      clearTimeout(colorWriteTimer.current);
      colorWriteTimer.current = null;
    }
    const pending = pendingColor.current;
    if (!pending) return;
    pendingColor.current = null;
    latestOnWrite.current(pending, keys.current());
  };

  const queueColorWrite = (color: Color, transient: boolean) => {
    pendingColor.current = color;
    if (!transient) {
      flushColorWrite();
      return;
    }
    // Pointer and range gestures can fire much faster than the canvas can
    // render or the sync channel can acknowledge. Keep the picker responsive
    // while bounding document patches to roughly 30 per second.
    if (!colorWriteTimer.current) {
      colorWriteTimer.current = setTimeout(flushColorWrite, 32);
    }
  };

  useEffect(
    () => () => {
      if (colorWriteTimer.current) clearTimeout(colorWriteTimer.current);
    },
    [],
  );

  const writeHsv = (next: HsvColor, transient = false) => {
    setHue(next.h);
    const parsed = parseColor(hsvToHex(next));
    if (!parsed) return;
    queueColorWrite(alpha < 1 ? ({ ...parsed, alpha } as Color) : parsed, transient);
  };

  const writeAlpha = (percent: number, transient = false) => {
    if (!Number.isFinite(percent)) return;
    const nextAlpha = Math.min(100, Math.max(0, percent)) / 100;
    queueColorWrite(
      nextAlpha < 1 ? ({ ...opaqueColor, alpha: nextAlpha } as Color) : opaqueColor,
      transient,
    );
  };

  const updateAreaFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    writeHsv(
      {
        h: hue,
        s: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
        v: 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      },
      true,
    );
  };

  const commitHex = (raw: string) => {
    const normalized = raw.replace('#', '').trim();
    const parsed = parseColor(`#${normalized}`);
    if (parsed && /^(?:[0-9A-F]{3}|[0-9A-F]{6})$/i.test(normalized)) {
      keys.begin();
      onWrite(alpha < 1 ? ({ ...parsed, alpha } as Color) : parsed, keys.current());
    }
    setHexDraft(null);
  };

  const pickFromScreen = async () => {
    type EyeDropperConstructor = new () => {
      open: () => Promise<{ sRGBHex: string }>;
    };
    const EyeDropperConstructor = (window as typeof window & { EyeDropper?: EyeDropperConstructor })
      .EyeDropper;
    if (!EyeDropperConstructor) return;
    try {
      const result = await new EyeDropperConstructor().open();
      const parsed = parseColor(result.sRGBHex);
      if (!parsed) return;
      keys.begin();
      onWrite(alpha < 1 ? ({ ...parsed, alpha } as Color) : parsed, keys.current());
    } catch {
      // The browser rejects when the picker is cancelled.
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) flushColorWrite();
        setOpen(nextOpen);
        if (!nextOpen) setHexDraft(null);
      }}
      className="ptl-color-popover"
      trigger={
        trigger ?? (
          <button type="button" className="ptl-color-trigger" title={tokenPath ?? undefined}>
            <span
              className={`ptl-color-swatch ${!resolved && !mixed ? 'ptl-color-swatch--unset' : ''}`}
            >
              {resolved && (
                <span
                  className="ptl-color-swatch-fill"
                  style={{ background: colorToCss(resolved) }}
                />
              )}
            </span>
            <span
              className={`ptl-color-value ${!resolved && !mixed ? 'ptl-color-value--muted' : ''}`}
            >
              {mixed
                ? 'Mixed'
                : tokenPath
                  ? tokenPath.replace('color.', '')
                  : resolved
                    ? displayValue
                    : 'Inherit'}
            </span>
          </button>
        )
      }
    >
      <div className="ptl-color-editor" style={pickerStyle}>
        <div
          ref={areaRef}
          className="ptl-color-area"
          role="application"
          aria-label="Saturation and brightness"
          tabIndex={0}
          onPointerDown={(event) => {
            keys.begin();
            event.currentTarget.setPointerCapture(event.pointerId);
            updateAreaFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              updateAreaFromPointer(event);
            }
          }}
          onPointerUp={(event) => {
            flushColorWrite();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={flushColorWrite}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 0.05 : 0.01;
            let next: HsvColor | null = null;
            if (event.key === 'ArrowLeft') next = { ...hsv, s: Math.max(0, hsv.s - step) };
            if (event.key === 'ArrowRight') next = { ...hsv, s: Math.min(1, hsv.s + step) };
            if (event.key === 'ArrowUp') next = { ...hsv, v: Math.min(1, hsv.v + step) };
            if (event.key === 'ArrowDown') next = { ...hsv, v: Math.max(0, hsv.v - step) };
            if (!next) return;
            event.preventDefault();
            keys.begin();
            writeHsv(next);
          }}
        >
          <span
            className="ptl-color-area-marker"
            style={{
              left: `clamp(7px, ${hsv.s * 100}%, calc(100% - 7px))`,
              top: `clamp(7px, ${(1 - hsv.v) * 100}%, calc(100% - 7px))`,
            }}
          />
        </div>

        <div className="ptl-color-slider-row">
          <span className="ptl-color-slider-label">H</span>
          <input
            type="range"
            className="ptl-color-slider ptl-color-hue"
            min={0}
            max={360}
            value={Math.round(hue)}
            aria-label="Hue"
            onPointerDown={() => keys.begin()}
            onPointerUp={flushColorWrite}
            onPointerCancel={flushColorWrite}
            onKeyDown={() => keys.begin()}
            onKeyUp={flushColorWrite}
            onChange={(event) => writeHsv({ ...hsv, h: Number(event.target.value) }, true)}
          />
          <span className="ptl-color-slider-value">{Math.round(hue)}°</span>
        </div>

        <div className="ptl-color-slider-row">
          <span className="ptl-color-slider-label">A</span>
          <input
            type="range"
            className="ptl-color-slider ptl-color-opacity-slider"
            min={0}
            max={100}
            value={Math.round(alpha * 100)}
            aria-label="Opacity"
            onPointerDown={() => keys.begin()}
            onPointerUp={flushColorWrite}
            onPointerCancel={flushColorWrite}
            onKeyDown={() => keys.begin()}
            onKeyUp={flushColorWrite}
            onChange={(event) => writeAlpha(Number(event.target.value), true)}
          />
          <span className="ptl-color-slider-value">{Math.round(alpha * 100)}%</span>
        </div>

        <div className="ptl-color-values">
          <span className="ptl-color-preview">
            <span style={{ background: colorToCss(resolved ?? opaqueColor) }} />
          </span>
          <label
            className={`ptl-color-hex-control ${hexDraft !== null && !draftValid ? 'ptl-color-hex-control--invalid' : ''}`}
          >
            <span>#</span>
            <input
              value={draftValue}
              maxLength={6}
              aria-label="Hex color"
              onFocus={() => {
                cancelHexCommit.current = false;
              }}
              onChange={(event) =>
                setHexDraft(
                  event.target.value
                    .replace(/[^0-9a-f]/gi, '')
                    .slice(0, 6)
                    .toUpperCase(),
                )
              }
              onBlur={(event) => {
                if (cancelHexCommit.current) {
                  cancelHexCommit.current = false;
                  setHexDraft(null);
                  return;
                }
                commitHex(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                if (event.key === 'Escape') {
                  cancelHexCommit.current = true;
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
          <label className="ptl-color-opacity-control">
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(alpha * 100)}
              aria-label="Opacity percentage"
              onFocus={() => keys.begin()}
              onChange={(event) => writeAlpha(Number(event.target.value))}
            />
            <span>%</span>
          </label>
          {eyeDropperAvailable && (
            <button
              type="button"
              className="ptl-color-eyedropper"
              aria-label="Pick color from screen"
              title="Pick color from screen"
              onClick={() => void pickFromScreen()}
            >
              <Pipette size={13} />
            </button>
          )}
        </div>

        {onBind && tokens && Object.keys(tokens.color).length > 0 && (
          <div className="ptl-color-token-section">
            <span className="ptl-color-token-label">Color tokens</span>
            <div className="ptl-color-token-row">
              {Object.entries(tokens.color).map(([name, token]) => (
                <button
                  key={name}
                  type="button"
                  className={`ptl-color-token-swatch ${tokenPath === `color.${name}` ? 'ptl-color-token-swatch--active' : ''}`}
                  title={name}
                  aria-label={`Use ${name} color token`}
                  onClick={() => onBind(`color.${name}`)}
                >
                  <span style={{ background: colorToCss(token.$value) }} />
                </button>
              ))}
            </div>
          </div>
        )}
        {onClear && (
          <button
            type="button"
            className="ptl-color-clear"
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            Remove color
          </button>
        )}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------

export interface RowStyleContext {
  source: string | null;
  overridden: boolean;
  partiallyOverridden?: boolean;
  onReset?: () => void;
}

export function Row({
  label,
  children,
  styleContext,
}: {
  label?: string;
  children: ReactNode;
  styleContext?: RowStyleContext;
}) {
  const contextLabel = styleContext?.partiallyOverridden
    ? 'mixed'
    : styleContext?.overridden
      ? 'set'
      : styleContext?.source;
  return (
    <div
      className={`ptl-insp-row ${styleContext?.overridden || styleContext?.partiallyOverridden ? 'ptl-insp-row--overridden' : ''}`}
    >
      {label !== undefined && (
        <span className="ptl-insp-row-label">
          <span>{label}</span>
          {styleContext && contextLabel && (
            <span
              className={`ptl-insp-row-source ${styleContext.overridden ? 'ptl-insp-row-source--local' : ''}`}
              title={
                styleContext.overridden
                  ? 'Set in this layer'
                  : `Inherited from ${styleContext.source ?? 'base'}`
              }
            >
              {contextLabel}
            </span>
          )}
          {styleContext?.onReset &&
            (styleContext.overridden || styleContext.partiallyOverridden) && (
              <button
                type="button"
                className="ptl-insp-row-reset"
                title="Remove this layer override"
                aria-label={`Reset ${label} override`}
                onClick={styleContext.onReset}
              >
                <RotateCcw size={10} />
              </button>
            )}
        </span>
      )}
      <div className="ptl-insp-row-fields">{children}</div>
    </div>
  );
}

export function Section({
  title,
  children,
  actions,
  collapseKey = title,
  forceOpen = false,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  collapseKey?: string;
  forceOpen?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => isInspectorSectionCollapsed(collapseKey));
  useEffect(() => {
    if (!forceOpen || !collapsed) return;
    setInspectorSectionCollapsed(collapseKey, false);
    setCollapsed(false);
  }, [collapseKey, collapsed, forceOpen]);

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current;
      setInspectorSectionCollapsed(collapseKey, next);
      return next;
    });
  };

  return (
    <div className={`ptl-insp-section ${collapsed ? 'ptl-insp-section--collapsed' : ''}`}>
      <div className="ptl-insp-section-header">
        <button
          type="button"
          className="ptl-insp-section-toggle"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span>{title}</span>
        </button>
        {actions && <div className="ptl-insp-section-actions">{actions}</div>}
      </div>
      {!collapsed && children}
    </div>
  );
}
