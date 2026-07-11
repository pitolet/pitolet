/**
 * A tiny notification bus for overlay re-measurement. Anything that can move
 * pixels on the canvas without a React render (camera motion, transient drag
 * transforms, document patches) calls notify(); overlay widgets re-measure
 * node rects on tick — all imperative, zero renders.
 */
class OverlaySync {
  private listeners = new Set<() => void>();
  private scheduled = false;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}

export const overlaySync = new OverlaySync();
