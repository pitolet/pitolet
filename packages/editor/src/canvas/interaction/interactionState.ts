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

export const interactionState = {
  /** Viewport-space marquee rect while drag-selecting. */
  marquee: null as MarqueeRect | null,
  /** True while a move/resize drag is in flight (overlay hides handles). */
  dragging: false,
  /** Active snap guides during frame drags. */
  guides: [] as SnapGuide[],
  /** Flex-insertion indicator during in-flow drags. */
  dropIndicator: null as DropIndicator | null,
  /** Cursor-following ghost chip during in-flow drags. */
  ghost: null as DragGhost | null,
};

export function setMarquee(rect: MarqueeRect | null): void {
  interactionState.marquee = rect;
  overlaySync.notify();
}

export function setDragging(dragging: boolean): void {
  interactionState.dragging = dragging;
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
