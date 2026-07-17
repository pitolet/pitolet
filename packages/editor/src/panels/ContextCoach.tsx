import { MonitorSmartphone, Pointer } from 'lucide-react';
import { useEffect } from 'react';
import { breakpointDisplayLabel } from '../canvas/responsivePreview.js';
import { useEditor } from '../store/index.js';
import './ContextCoach.css';

export type CoachVariant = 'sizes' | 'states';

const STORAGE_KEY: Record<CoachVariant, string> = {
  sizes: 'ptl-onboard-breakpoints-v2',
  states: 'ptl-onboard-states-v2',
};

/** Has the user already seen the coach-mark for this feature? */
export function hasSeenCoach(variant: CoachVariant): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY[variant]) === '1';
  } catch {
    return false;
  }
}

export function markCoachSeen(variant: CoachVariant): void {
  try {
    localStorage.setItem(STORAGE_KEY[variant], '1');
  } catch {
    // ignore (private mode)
  }
}

const CONTENT: Record<
  CoachVariant,
  {
    icon: typeof Pointer;
    title: string;
    intro: string;
    note: string;
  }
> = {
  sizes: {
    icon: MonitorSmartphone,
    title: 'Breakpoints',
    intro: 'Choose the width where a style change starts.',
    note: 'Styles carry forward to larger widths. The frame previews the chosen width.',
  },
  states: {
    icon: Pointer,
    title: 'States',
    intro: 'Choose when the selected layer should look different.',
    note: 'These export as CSS pseudo-classes.',
  },
};

/**
 * A one-time coach-mark shown under the breakpoint/state chips the first time
 * the user tries them, explaining what the mode does. Dismissal is persisted.
 */
export function ContextCoach({
  variant,
  onDismiss,
}: {
  variant: CoachVariant;
  onDismiss: () => void;
}) {
  const breakpoints = useEditor((state) => state.doc?.breakpoints ?? []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onDismiss();
    };
    const onOutside = (e: PointerEvent) => {
      if (!(e.target as Element).closest('.ptl-coach')) onDismiss();
    };
    window.addEventListener('keydown', onKey, true);
    // Defer so the click that opened it doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('pointerdown', onOutside), 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onOutside);
      clearTimeout(t);
    };
  }, [onDismiss]);

  const { icon: Icon, title, intro, note } = CONTENT[variant];
  const items =
    variant === 'sizes'
      ? [
          { label: 'base', detail: 'all widths' },
          ...breakpoints.map((breakpoint) => ({
            label: breakpointDisplayLabel(breakpoint),
            detail: `${breakpoint.minWidth}px+`,
          })),
        ]
      : [
          { label: ':hover', detail: 'pointer over' },
          { label: ':focus', detail: 'keyboard focus' },
          { label: ':active', detail: 'pressed' },
        ];

  return (
    <div className={`ptl-coach ptl-coach--${variant}`} role="dialog" aria-label={title}>
      <div className="ptl-coach-arrow" />
      <div className="ptl-coach-head">
        <span className="ptl-coach-icon">
          <Icon size={15} />
        </span>
        <span className="ptl-coach-title">{title}</span>
      </div>
      <p className="ptl-coach-intro">{intro}</p>
      <div className={`ptl-coach-options ptl-coach-options--${variant}`} role="list">
        {items.map((item) => (
          <div key={item.label} className="ptl-coach-option" role="listitem">
            <code>{item.label}</code>
            <span>{item.detail}</span>
          </div>
        ))}
      </div>
      <p className="ptl-coach-note">{note}</p>
      <button type="button" className="ptl-coach-dismiss" onClick={onDismiss}>
        Done
      </button>
    </div>
  );
}
