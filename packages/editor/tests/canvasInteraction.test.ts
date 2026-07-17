import { createSampleDocument } from '@pitolet/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraController } from '../src/canvas/CameraController.js';
import { shouldStartSpacePan } from '../src/canvas/CanvasViewport.js';
import {
  applyResizeHandle,
  captureFrameWrapperInlineStyle,
  restoreFrameWrapperInlineStyle,
  startFrameMove,
  startFrameResize,
} from '../src/canvas/interaction/frameDrag.js';
import {
  captureElementInlineOpacity,
  restoreElementInlineOpacity,
} from '../src/canvas/interaction/inFlowMove.js';
import {
  cancelActiveInteraction,
  setInteractionCancel,
} from '../src/canvas/interaction/interactionState.js';
import { marqueeContains } from '../src/canvas/interaction/marquee.js';
import {
  chainTo,
  resolveClickTarget,
  resolveDirectClickTarget,
} from '../src/canvas/interaction/selection.js';
import { useEditor } from '../src/store/index.js';

function pointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  init: MouseEventInit = {},
): PointerEvent {
  return new MouseEvent(type, { bubbles: true, clientX, clientY, ...init }) as PointerEvent;
}

function cameraAt(zoom: number): CameraController {
  return {
    zoom,
    cancelAnimation: vi.fn(),
    toScreen: ({ x, y }: { x: number; y: number }) => ({ x: x * zoom, y: y * zoom }),
  } as unknown as CameraController;
}

beforeEach(() => {
  cancelActiveInteraction();
  document.body.replaceChildren();
  useEditor.getState().setDocument(createSampleDocument(), 0);
  useEditor.getState().setConnected(true);
  useEditor.getState().setReadOnly(false);
});

afterEach(() => {
  cancelActiveInteraction();
  document.body.replaceChildren();
});

describe('canvas selection', () => {
  it('lets command/control-click bypass the current selection depth', () => {
    const doc = createSampleDocument();
    const deepest = Object.values(doc.nodes)
      .map((node) => ({ node, chain: chainTo(doc, node.id) }))
      .sort((a, b) => b.chain.length - a.chain.length)[0];
    expect(deepest).toBeDefined();
    if (!deepest) return;

    expect(resolveClickTarget(doc, deepest.node.id, [])).toBe(deepest.chain[0]);
    expect(resolveDirectClickTarget(doc, deepest.node.id)).toBe(deepest.node.id);
  });
});

describe('space-to-pan focus handling', () => {
  it('preserves Space activation for application controls', () => {
    const button = document.createElement('button');
    const treeItem = document.createElement('div');
    treeItem.setAttribute('role', 'treeitem');
    treeItem.tabIndex = 0;
    const input = document.createElement('input');

    expect(shouldStartSpacePan(button)).toBe(false);
    expect(shouldStartSpacePan(treeItem)).toBe(false);
    expect(shouldStartSpacePan(input)).toBe(false);
    expect(shouldStartSpacePan(document.body)).toBe(true);
  });

  it('keeps canvas page content eligible for Space panning', () => {
    const canvasButton = document.createElement('button');
    canvasButton.dataset.nodeId = 'button';
    expect(shouldStartSpacePan(canvasButton)).toBe(true);
  });
});

describe('canvas marquee', () => {
  const selection = { left: 0, top: 0, right: 100, bottom: 100 };

  it('requires full enclosure when dragged left to right', () => {
    expect(marqueeContains(selection, { left: 20, top: 20, right: 80, bottom: 80 }, false)).toBe(
      true,
    );
    expect(marqueeContains(selection, { left: 80, top: 20, right: 120, bottom: 80 }, false)).toBe(
      false,
    );
  });

  it('uses crossing selection when dragged right to left', () => {
    expect(marqueeContains(selection, { left: 80, top: 20, right: 120, bottom: 80 }, true)).toBe(
      true,
    );
    expect(marqueeContains(selection, { left: 120, top: 20, right: 140, bottom: 80 }, true)).toBe(
      false,
    );
  });
});

describe('frame resize geometry', () => {
  it('restores React-owned wrapper styles after a transient resize', () => {
    const wrapper = document.createElement('div');
    wrapper.style.left = '156px';
    wrapper.style.top = '2536px';
    wrapper.style.width = '1843px';
    wrapper.style.height = '1227px';
    const initial = captureFrameWrapperInlineStyle(wrapper);

    wrapper.style.left = '0px';
    wrapper.style.top = '0px';
    wrapper.style.width = '1632px';
    wrapper.style.height = '1082px';
    restoreFrameWrapperInlineStyle(wrapper, initial);

    expect(wrapper.style.left).toBe('156px');
    expect(wrapper.style.top).toBe('2536px');
    expect(wrapper.style.width).toBe('1843px');
    expect(wrapper.style.height).toBe('1227px');

    wrapper.style.height = '';
    const autoHeightInitial = captureFrameWrapperInlineStyle(wrapper);
    wrapper.style.height = '600px';
    restoreFrameWrapperInlineStyle(wrapper, autoHeightInitial);
    expect(wrapper.style.height).toBe('');
  });

  it('resizes from the dragged edge and respects the minimum size', () => {
    expect(applyResizeHandle(10, 20, 100, 50, 'e', 20, 0, false)).toEqual({
      x: 10,
      y: 20,
      width: 120,
      height: 50,
    });
    expect(applyResizeHandle(10, 20, 100, 50, 'w', 200, 0, false)).toEqual({
      x: 94,
      y: 20,
      width: 16,
      height: 50,
    });
  });

  it('keeps proportions with Shift', () => {
    expect(applyResizeHandle(10, 20, 100, 50, 'se', 50, 0, true)).toEqual({
      x: 10,
      y: 20,
      width: 150,
      height: 75,
    });
    expect(applyResizeHandle(10, 20, 100, 50, 's', 0, 25, true)).toEqual({
      x: -15,
      y: 20,
      width: 150,
      height: 75,
    });
  });

  it('resizes around the center with Alt', () => {
    expect(applyResizeHandle(10, 20, 100, 50, 'e', 20, 0, false, true)).toEqual({
      x: -10,
      y: 20,
      width: 140,
      height: 50,
    });
  });

  it.each([
    ['n', { x: 10, y: 30, width: 100, height: 40 }],
    ['s', { x: 10, y: 20, width: 100, height: 60 }],
    ['e', { x: 10, y: 20, width: 120, height: 50 }],
    ['w', { x: 30, y: 20, width: 80, height: 50 }],
    ['ne', { x: 10, y: 30, width: 120, height: 40 }],
    ['nw', { x: 30, y: 30, width: 80, height: 40 }],
    ['se', { x: 10, y: 20, width: 120, height: 60 }],
    ['sw', { x: 30, y: 20, width: 80, height: 60 }],
  ] as const)('keeps the opposite edges anchored for the %s handle', (handle, expected) => {
    expect(applyResizeHandle(10, 20, 100, 50, handle, 20, 10, false)).toEqual(expected);
  });

  it.each(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const)(
    'keeps the frame center fixed for Alt+%s resize',
    (handle) => {
      const resized = applyResizeHandle(10, 20, 100, 50, handle, 20, 10, false, true);
      expect(resized.x + resized.width / 2).toBe(60);
      expect(resized.y + resized.height / 2).toBe(45);
    },
  );

  it('commits the pointer-up position even when the final preview frame has not run', () => {
    const frameId = useEditor.getState().doc!.rootOrder[0]!;
    const wrapper = document.createElement('div');
    wrapper.dataset.frameWrapper = frameId;
    wrapper.style.left = '120px';
    wrapper.style.top = '120px';
    wrapper.style.width = '1280px';
    wrapper.style.height = '800px';
    document.body.append(wrapper);
    const camera = cameraAt(0.5);

    startFrameResize(pointerEvent('pointerdown', 100, 100), frameId, 'w', camera);
    window.dispatchEvent(pointerEvent('pointermove', 120, 100));
    window.dispatchEvent(pointerEvent('pointerup', 150, 100));

    const frame = useEditor.getState().doc!.nodes[frameId]!;
    expect(frame.type).toBe('frame');
    if (frame.type !== 'frame') return;
    expect(frame.canvas).toMatchObject({ x: 220, y: 120, width: 1180, height: 800 });
    expect(wrapper.style.left).toBe('120px');
    expect(wrapper.style.top).toBe('120px');
    expect(wrapper.style.width).toBe('1280px');
    expect(wrapper.style.height).toBe('800px');
    expect(camera.cancelAnimation).toHaveBeenCalledOnce();
  });

  it('preserves auto height when only a horizontal edge is resized', () => {
    const frameId = useEditor.getState().doc!.rootOrder[0]!;
    const frame = useEditor.getState().doc!.nodes[frameId]!;
    if (frame.type !== 'frame') throw new Error('expected frame');
    frame.canvas.height = 'auto';
    const wrapper = document.createElement('div');
    wrapper.dataset.frameWrapper = frameId;
    wrapper.style.left = '120px';
    wrapper.style.top = '120px';
    wrapper.style.width = '1280px';
    document.body.append(wrapper);

    startFrameResize(pointerEvent('pointerdown', 100, 100), frameId, 'e', cameraAt(1));
    window.dispatchEvent(pointerEvent('pointermove', 140, 100));
    window.dispatchEvent(pointerEvent('pointerup', 160, 100));

    const resized = useEditor.getState().doc!.nodes[frameId]!;
    expect(resized.type).toBe('frame');
    if (resized.type !== 'frame') return;
    expect(resized.canvas).toMatchObject({ width: 1340, height: 'auto' });
    expect(wrapper.style.height).toBe('');
  });
});

describe('frame move gestures', () => {
  it('uses the pointer-up position at the frozen starting zoom', () => {
    const frameId = useEditor.getState().doc!.rootOrder[0]!;
    const wrapper = document.createElement('div');
    wrapper.dataset.frameWrapper = frameId;
    document.body.append(wrapper);
    const camera = cameraAt(0.5);

    startFrameMove(pointerEvent('pointerdown', 100, 100), [frameId], camera);
    window.dispatchEvent(pointerEvent('pointermove', 110, 110, { altKey: true }));
    window.dispatchEvent(pointerEvent('pointerup', 120, 130, { altKey: true }));

    const frame = useEditor.getState().doc!.nodes[frameId]!;
    expect(frame.type).toBe('frame');
    if (frame.type !== 'frame') return;
    expect(frame.canvas).toMatchObject({ x: 160, y: 180 });
    expect(wrapper.style.translate).toBe('');
    expect(camera.cancelAnimation).toHaveBeenCalledOnce();
  });

  it('restores the preview and document when Escape cancels a move', () => {
    const frameId = useEditor.getState().doc!.rootOrder[0]!;
    const wrapper = document.createElement('div');
    wrapper.dataset.frameWrapper = frameId;
    document.body.append(wrapper);

    startFrameMove(pointerEvent('pointerdown', 100, 100), [frameId], cameraAt(1));
    window.dispatchEvent(pointerEvent('pointermove', 140, 150, { altKey: true }));
    expect(cancelActiveInteraction()).toBe(true);

    const frame = useEditor.getState().doc!.nodes[frameId]!;
    expect(frame.type).toBe('frame');
    if (frame.type !== 'frame') return;
    expect(frame.canvas).toMatchObject({ x: 120, y: 120 });
    expect(wrapper.style.translate).toBe('');
  });
});

describe('in-flow drag previews', () => {
  it('restores the exact React-owned opacity after dragging', () => {
    const element = document.createElement('div');
    element.style.opacity = '0.65';
    const initial = captureElementInlineOpacity(element);

    element.style.opacity = '0.35';
    restoreElementInlineOpacity(element, initial);

    expect(element.style.opacity).toBe('0.65');
  });
});

describe('gesture cancellation', () => {
  it('cancels the active gesture exactly once', () => {
    const cancel = vi.fn();
    setInteractionCancel(cancel);
    expect(cancelActiveInteraction()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelActiveInteraction()).toBe(false);
  });
});

describe('camera interruption', () => {
  it('invalidates a queued initial fit and flushes the latest camera transform', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      callbacks.delete(id);
    });
    const resizeObserver = class {
      observe() {}
      disconnect() {}
    };
    vi.stubGlobal('ResizeObserver', resizeObserver);

    const viewport = document.createElement('div');
    const world = document.createElement('div');
    Object.defineProperty(viewport, 'clientWidth', { value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { value: 800 });
    const camera = new CameraController();
    camera.requestInitialFit(() => ({ x: 0, y: 0, width: 4000, height: 3000 }));
    camera.attach(viewport, world);
    camera.set(25, 30, 0.5);

    camera.cancelAnimation();
    for (const callback of [...callbacks.values()]) callback(performance.now());

    expect(camera).toMatchObject({ x: 25, y: 30, zoom: 0.5 });
    expect(world.style.transform).toBe('translate(25px, 30px) scale(0.5)');

    camera.detach();
    request.mockRestore();
    cancel.mockRestore();
    vi.unstubAllGlobals();
  });
});
