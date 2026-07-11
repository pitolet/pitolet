import { useEffect, useRef, useState, type ReactNode } from 'react';
import './NumberScrubInput.css';

export interface NumberScrubInputProps {
  value: number | null; // null = mixed
  onChange: (value: number, opts: { transient: boolean }) => void;
  /** Called when a scrub gesture or typing session ends. */
  onCommit?: () => void;
  /** Scrub label/icon — drag it horizontally to change the value. */
  label?: ReactNode;
  title?: string;
  step?: number;
  min?: number;
  max?: number;
  /** Displayed decimals. */
  precision?: number;
  disabled?: boolean;
  /** Placeholder when value is null (default "Mixed"). */
  placeholder?: string;
  className?: string;
}

/**
 * The inspector's numeric field: type a value, nudge with arrows
 * (shift = ×10), or drag the label to scrub.
 */
export function NumberScrubInput({
  value,
  onChange,
  onCommit,
  label,
  title,
  step = 1,
  min = -Infinity,
  max = Infinity,
  precision = 0,
  disabled = false,
  placeholder = 'Mixed',
  className = '',
}: NumberScrubInputProps) {
  const [text, setText] = useState<string>(format(value, precision));
  const [focused, setFocused] = useState(false);
  const scrubbing = useRef(false);

  useEffect(() => {
    if (!focused && !scrubbing.current) setText(format(value, precision));
  }, [value, precision, focused]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commitText = (raw: string) => {
    const parsed = Number.parseFloat(raw.replace(',', '.'));
    if (Number.isFinite(parsed)) {
      onChange(round(clamp(parsed), precision), { transient: false });
    } else {
      setText(format(value, precision));
    }
    onCommit?.();
  };

  const onLabelPointerDown = (e: React.PointerEvent) => {
    if (disabled || value === null) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    const startX = e.clientX;
    const startValue = value;

    const onMove = (ev: PointerEvent) => {
      const multiplier = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const next = round(clamp(startValue + (ev.clientX - startX) * step * multiplier), precision);
      setText(format(next, precision));
      onChange(next, { transient: true });
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      scrubbing.current = false;
      onCommit?.();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  return (
    <label className={`ptl-scrub ${disabled ? 'ptl-scrub--disabled' : ''} ${className}`} title={title}>
      {label != null && (
        <span className="ptl-scrub-label" onPointerDown={onLabelPointerDown}>
          {label}
        </span>
      )}
      <input
        className="ptl-scrub-input"
        value={focused ? text : value === null ? '' : format(value, precision)}
        placeholder={value === null ? placeholder : undefined}
        disabled={disabled}
        onFocus={(e) => {
          setFocused(true);
          setText(format(value, precision));
          e.target.select();
        }}
        onBlur={(e) => {
          setFocused(false);
          commitText(e.target.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(format(value, precision));
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = Number.parseFloat(text) || value || 0;
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * step;
            const next = round(clamp(base + delta), precision);
            setText(format(next, precision));
            onChange(next, { transient: false });
          }
        }}
      />
    </label>
  );
}

function format(v: number | null, precision: number): string {
  if (v === null) return '';
  return precision > 0 ? String(round(v, precision)) : String(Math.round(v));
}

function round(v: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(v * f) / f;
}
