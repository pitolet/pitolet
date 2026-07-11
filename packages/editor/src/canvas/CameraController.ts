export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/**
 * Owns the canvas camera. Deliberately NOT React state: pan/zoom writes go
 * straight to the world element's transform inside rAF, so camera motion
 * never causes React renders. Interested React code (zoom readout, culling)
 * subscribes and throttles itself.
 */
export class CameraController {
  x = 0;
  y = 0;
  zoom = 1;

  private worldEl: HTMLElement | null = null;
  private viewportEl: HTMLElement | null = null;
  private rafId = 0;
  private listeners = new Set<() => void>();
  private animation: number | null = null;
  private pendingFit: (() => { x: number; y: number; width: number; height: number }) | null =
    null;

  attach(viewport: HTMLElement, world: HTMLElement): void {
    this.viewportEl = viewport;
    this.worldEl = world;
    this.applyNow();
    // A fit requested before the viewport was attached runs now that it is.
    if (this.pendingFit) this.runPendingFit();
  }

  /**
   * Fit to a rect computed lazily (deferred to when the viewport is attached
   * and sized). Robust against the doc arriving before/after the canvas mounts.
   */
  requestInitialFit(getRect: () => { x: number; y: number; width: number; height: number }): void {
    this.pendingFit = getRect;
    if (this.viewportEl) this.runPendingFit();
  }

  private runPendingFit(): void {
    const getRect = this.pendingFit;
    const vp = this.viewportEl;
    if (!getRect || !vp) return;
    this.pendingFit = null;
    // Poll on rAF until the viewport has a size that's stable for two frames
    // (panels finish laying out), then fit. rAF works everywhere; a fixed
    // frame cap guarantees it always resolves.
    let lastW = -1;
    let stable = 0;
    let tries = 0;
    const attempt = () => {
      const w = vp.clientWidth;
      if (w > 0 && w === lastW) stable++;
      else stable = 0;
      lastW = w;
      tries++;
      if (w > 0 && (stable >= 2 || tries >= 60)) {
        this.fitRect(getRect(), { animate: false });
      } else {
        requestAnimationFrame(attempt);
      }
    };
    requestAnimationFrame(attempt);
  }

  detach(): void {
    this.viewportEl = null;
    this.worldEl = null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(x: number, y: number, zoom: number): void {
    this.x = x;
    this.y = y;
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.scheduleApply();
  }

  panBy(dx: number, dy: number): void {
    this.set(this.x + dx, this.y + dy, this.zoom);
  }

  /** Zoom by a factor, keeping the given viewport-local point fixed. */
  zoomAt(point: { x: number; y: number }, factor: number): void {
    const next = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const applied = next / this.zoom;
    this.set(
      point.x - (point.x - this.x) * applied,
      point.y - (point.y - this.y) * applied,
      next,
    );
  }

  /** Convert a viewport-local point to world coordinates. */
  toWorld(point: { x: number; y: number }): { x: number; y: number } {
    return { x: (point.x - this.x) / this.zoom, y: (point.y - this.y) / this.zoom };
  }

  /** Convert a world point to viewport-local coordinates. */
  toScreen(point: { x: number; y: number }): { x: number; y: number } {
    return { x: point.x * this.zoom + this.x, y: point.y * this.zoom + this.y };
  }

  /** World-space rect currently visible in the viewport. */
  visibleWorldRect(): { x: number; y: number; width: number; height: number } {
    const vp = this.viewportEl;
    const w = vp?.clientWidth ?? window.innerWidth;
    const h = vp?.clientHeight ?? window.innerHeight;
    return {
      x: -this.x / this.zoom,
      y: -this.y / this.zoom,
      width: w / this.zoom,
      height: h / this.zoom,
    };
  }

  /** Animate to fit a world-space rect with padding. */
  fitRect(
    rect: { x: number; y: number; width: number; height: number },
    opts: { padding?: number; maxZoom?: number; animate?: boolean } = {},
  ): void {
    const vp = this.viewportEl;
    if (!vp) return;
    const padding = opts.padding ?? 64;
    const vw = vp.clientWidth - padding * 2;
    const vh = vp.clientHeight - padding * 2;
    if (vw <= 0 || vh <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const zoom = clamp(
      Math.min(vw / rect.width, vh / rect.height, opts.maxZoom ?? 1),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const x = (vp.clientWidth - rect.width * zoom) / 2 - rect.x * zoom;
    const y = (vp.clientHeight - rect.height * zoom) / 2 - rect.y * zoom;
    if (opts.animate === false) this.set(x, y, zoom);
    else this.animateTo(x, y, zoom);
  }

  setZoomCentered(zoom: number): void {
    const vp = this.viewportEl;
    const center = vp
      ? { x: vp.clientWidth / 2, y: vp.clientHeight / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.zoomAt(center, zoom / this.zoom);
  }

  private animateTo(tx: number, ty: number, tzoom: number): void {
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    const start = performance.now();
    const duration = 220;
    const { x: sx, y: sy, zoom: sz } = this;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = easeOut(t);
      this.set(sx + (tx - sx) * e, sy + (ty - sy) * e, sz + (tzoom - sz) * e);
      if (t < 1) this.animation = requestAnimationFrame(step);
      else this.animation = null;
    };
    this.animation = requestAnimationFrame(step);
  }

  private scheduleApply(): void {
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.applyNow();
    });
  }

  private applyNow(): void {
    if (this.worldEl) {
      this.worldEl.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
    }
    if (this.viewportEl) {
      // Dot-grid background follows the camera via CSS vars.
      this.viewportEl.style.setProperty('--cam-x', `${this.x}px`);
      this.viewportEl.style.setProperty('--cam-y', `${this.y}px`);
      this.viewportEl.style.setProperty('--cam-zoom', String(this.zoom));
    }
    for (const listener of this.listeners) listener();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}
