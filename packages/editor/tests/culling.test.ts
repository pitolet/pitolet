import { createFrame, createSampleDocument } from '@pitolet/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraController } from '../src/canvas/CameraController.js';
import { frameIntersectsView, installCulling } from '../src/canvas/culling.js';
import { useEditor } from '../src/store/index.js';

const view = { x: 0, y: 2800, width: 1000, height: 800 };

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('frameIntersectsView', () => {
  it('keeps vertically intersecting auto-height frames rendered without guessing a bottom', () => {
    const frame = createFrame({ x: 100, y: 100, width: 800, height: 'auto' });
    expect(frameIntersectsView(frame, view, 0)).toBe(true);
  });

  it('still culls auto-height frames that are horizontally outside the viewport', () => {
    const frame = createFrame({ x: 2200, y: 100, width: 800, height: 'auto' });
    expect(frameIntersectsView(frame, view, 0)).toBe(false);
  });

  it('culls fixed-height frames using their known vertical bounds', () => {
    const frame = createFrame({ x: 100, y: 100, width: 800, height: 900 });
    expect(frameIntersectsView(frame, view, 0)).toBe(false);
  });

  it('cancels a queued cull when the canvas owner is removed', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      callbacks.delete(id);
    });
    const doc = createSampleDocument();
    useEditor.getState().setDocument(doc, 0);
    const frameId = doc.rootOrder[0]!;
    const wrapper = document.createElement('div');
    wrapper.dataset.frameWrapper = frameId;
    wrapper.style.display = 'grid';
    document.body.append(wrapper);
    const camera = {
      zoom: 1,
      visibleWorldRect: () => ({ x: 5000, y: 5000, width: 100, height: 100 }),
      subscribe: () => () => {},
    } as unknown as CameraController;

    const uninstall = installCulling(camera);
    uninstall();
    for (const callback of callbacks.values()) callback(performance.now());

    expect(cancel).toHaveBeenCalledOnce();
    expect(wrapper.style.display).toBe('grid');
  });
});
