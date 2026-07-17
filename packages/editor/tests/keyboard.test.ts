import { createSampleDocument } from '@pitolet/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraController } from '../src/canvas/CameraController.js';
import {
  cancelActiveInteraction,
  setInteractionCancel,
} from '../src/canvas/interaction/interactionState.js';
import { installKeyboard } from '../src/keyboard.js';
import { useEditor } from '../src/store/index.js';

describe('keyboard escape behavior', () => {
  let removeKeyboard: (() => void) | null = null;

  beforeEach(() => {
    const camera = {
      zoom: 1,
      setZoomCentered: vi.fn(),
    } as unknown as CameraController;
    useEditor.getState().setDocument(createSampleDocument(), 0);
    useEditor.getState().setReadOnly(false);
    useEditor.getState().setSwitchingDocument(false);
    useEditor.getState().setConnected(true);
    useEditor.getState().setTool('select');
    useEditor.getState().setEditingContext({ breakpointId: null, state: null });
    useEditor.getState().select([]);
    removeKeyboard = installKeyboard(camera, vi.fn(), vi.fn());
  });

  afterEach(() => {
    removeKeyboard?.();
    removeKeyboard = null;
    cancelActiveInteraction();
  });

  it('returns an insert tool to Select before changing the editing context or selection', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    store.setTool('frame');
    store.select([frameId]);
    store.setEditingContext({ breakpointId: null, state: 'hover' });

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(useEditor.getState().activeTool).toBe('select');
    expect(useEditor.getState().editingContext).toEqual({ breakpointId: null, state: 'hover' });
    expect(useEditor.getState().selection).toEqual([frameId]);
  });

  it('cancels an active insert gesture and returns to Select with one Escape', () => {
    const cancel = vi.fn();
    useEditor.getState().setTool('element');
    setInteractionCancel(cancel);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(useEditor.getState().activeTool).toBe('select');
  });

  it('does not consume frame nudges while editing is unavailable', () => {
    const store = useEditor.getState();
    const frameId = store.doc!.rootOrder[0]!;
    const frame = store.doc!.nodes[frameId]!;
    if (frame.type !== 'frame') throw new Error('expected frame');
    const before = { ...frame.canvas };
    store.select([frameId]);
    store.setConnected(false);
    store.setSyncIssue(null);

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(useEditor.getState().doc!.nodes[frameId]).toMatchObject({ canvas: before });
    expect(useEditor.getState().syncIssue).toBeNull();
  });
});
