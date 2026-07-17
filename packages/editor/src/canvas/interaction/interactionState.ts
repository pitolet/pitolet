import { overlaySync } from '../overlaySync.js';

export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transient interaction visuals (marquee box, later: snap guides, drop
 * indicators). Mutable module state read imperatively by the overlay on
 * each sync tick — never React state.
 */
export interface SnapGuide {
  /** Viewport-space line. */
  axis: 'x' | 'y';
  position: number;
  start: number;
  end: number;
}

export interface DropIndicator {
  /** Viewport-space line where the dragged node would insert. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Container being targeted (highlighted). */
  containerRect: { x: number; y: number; width: number; height: number } | null;
}

export interface DragGhost {
  x: number;
  y: number;
  label: string;
}

export type CanvasGesture = 'move' | 'resize' | 'reorder' | 'marquee' | 'draw';

type InteractionCancel = () => void;

export const interactionState = {
  /** Viewport-space marquee rect while drag-selecting. */
  marquee: null as MarqueeRect | null,
  /** True while a move/resize drag is in flight (overlay hides handles). */
  dragging: false,
  /** The interaction currently owning pointer movement, if any. */
  gesture: null as CanvasGesture | null,
  /** Active snap guides during frame drags. */
  guides: [] as SnapGuide[],
  /** Flex-insertion indicator during in-flow drags. */
  dropIndicator: null as DropIndicator | null,
  /** Cursor-following ghost chip during in-flow drags. */
  ghost: null as DragGhost | null,
  /** Escape/blur cancellation for the active pointer gesture. */
  cancel: null as InteractionCancel | null,
};

export function setMarquee(rect: MarqueeRect | null): void {
  interactionState.marquee = rect;
  overlaySync.notify();
}

export function setDragging(dragging: boolean, gesture: CanvasGesture | null = null): void {
  interactionState.dragging = dragging;
  interactionState.gesture = dragging ? gesture : null;
  overlaySync.notify();
}

export function setGuides(guides: SnapGuide[]): void {
  interactionState.guides = guides;
  overlaySync.notify();
}

export function setDropIndicator(indicator: DropIndicator | null, ghost: DragGhost | null): void {
  interactionState.dropIndicator = indicator;
  interactionState.ghost = ghost;
  overlaySync.notify();
}

/** Register one cancellable canvas gesture. A newer gesture replaces the old owner. */
export function setInteractionCancel(cancel: InteractionCancel): void {
  interactionState.cancel?.();
  interactionState.cancel = cancel;
}

export function clearInteractionCancel(cancel: InteractionCancel): void {
  if (interactionState.cancel === cancel) interactionState.cancel = null;
}

/** Cancel the active gesture, returning whether Escape had something to cancel. */
export function cancelActiveInteraction(): boolean {
  const cancel = interactionState.cancel;
  if (!cancel) return false;
  interactionState.cancel = null;
  cancel();
  return true;
}
