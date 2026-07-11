import { MonitorSmartphone, Pointer } from 'lucide-react';
import { useEffect } from 'react';
import './ContextCoach.css';

export type CoachVariant = 'sizes' | 'states';

const STORAGE_KEY: Record<CoachVariant, string> = {
  sizes: 'ptl-onboard-breakpoints',
  states: 'ptl-onboard-states',
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
  { icon: typeof Pointer; title: string; body: string }
> = {
  sizes: {
    icon: MonitorSmartphone,
    title: 'Responsive breakpoints',
    body: 'Pick a size to edit styles for that width and up. Base applies everywhere; sm · md · lg · xl layer on top — just like CSS media queries. A frame’s own width shows which are live.',
  },
  states: {
    icon: Pointer,
    title: 'Interaction states',
    body: 'Style how an element looks on :hover, :focus, or :active. Your changes export as real CSS pseudo-classes.',
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    const onOutside = (e: PointerEvent) => {
      if (!(e.target as Element).closest('.ptl-coach')) onDismiss();
    };
    window.addEventListener('keydown', onKey);
    // Defer so the click that opened it doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('pointerdown', onOutside), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onOutside);
      clearTimeout(t);
    };
  }, [onDismiss]);

  const { icon: Icon, title, body } = CONTENT[variant];

  return (
    <div className={`ptl-coach ptl-coach--${variant}`} role="dialog" aria-label={title}>
      <div className="ptl-coach-arrow" />
      <div className="ptl-coach-head">
        <span className="ptl-coach-icon">
          <Icon size={15} />
        </span>
        <span className="ptl-coach-title">{title}</span>
      </div>
      <p className="ptl-coach-body">{body}</p>
      <button type="button" className="ptl-coach-dismiss" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
