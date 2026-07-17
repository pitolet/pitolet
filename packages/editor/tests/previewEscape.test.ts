import { createSampleDocument } from '@pitolet/schema';
import { TooltipProvider } from '@pitolet/ui';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewMode } from '../src/preview/PreviewMode.js';
import { useEditor } from '../src/store/index.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  useEditor.getState().setDocument(createSampleDocument(), 0);
  useEditor.getState().setPreviewFrame(null);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

function renderPreview(): void {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(createElement(TooltipProvider, null, createElement(PreviewMode)));
  });
}

describe('preview Escape handling', () => {
  it('does not intercept Escape while preview is closed', () => {
    renderPreview();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('closes an open preview without allowing the editor shortcut to continue', () => {
    const frameId = useEditor.getState().doc!.rootOrder[0]!;
    useEditor.getState().setPreviewFrame(frameId);
    renderPreview();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(useEditor.getState().previewFrameId).toBeNull();
  });
});
