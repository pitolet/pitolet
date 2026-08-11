import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setDiagnosticsEnabled, setProblemContext } = vi.hoisted(() => ({
  setDiagnosticsEnabled: vi.fn(),
  setProblemContext: vi.fn(),
}));

vi.mock('../src/sync/serverBase.js', () => ({
  serverBase: '/w/acme',
  isShareSession: false,
  apiUrl: (path: string) => `/w/acme${path}`,
}));

vi.mock('../src/store/index.js', () => ({
  useEditor: (selector: (state: { doc: { id: string } }) => unknown) =>
    selector({ doc: { id: 'doc-1' } }),
}));

vi.mock('../src/cloudDiagnostics.js', () => ({
  recentCloudErrors: () => [],
  setCloudDiagnosticsEnabled: setDiagnosticsEnabled,
  setCloudProblemContext: setProblemContext,
}));

vi.mock('@pitolet/ui', async () => {
  const React = await import('react');
  return {
    CloudFeedbackDialog: ({ open }: { open: boolean }) =>
      open ? React.createElement('div', { role: 'dialog' }, 'Feedback dialog') : null,
    IconButton: ({ label, children }: { label: string; children: ReactNode }) =>
      React.createElement('button', { type: 'button', 'aria-label': label }, children),
    Popover: ({
      open,
      onOpenChange,
      trigger,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      trigger: ReactNode;
      children: ReactNode;
    }) =>
      React.createElement(
        'div',
        null,
        React.createElement('div', { onClick: () => onOpenChange(true) }, trigger),
        open ? children : null,
      ),
    Tooltip: ({ children }: { children: ReactNode }) => children,
  };
});

import { CloudHelp } from '../src/panels/CloudHelp.js';

describe('cloud editor help', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: 'user',
            workspace: { id: '00000000-0000-0000-0000-000000000001', slug: 'acme', name: 'Acme' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens feedback for a signed-in Cloud editor session', async () => {
    await act(async () => root.render(<CloudHelp />));
    await act(async () => {});
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Help"]')!.click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('Send feedback'))!
        .click(),
    );

    expect(container.querySelector('[role="dialog"]')?.textContent).toBe('Feedback dialog');
    expect(setDiagnosticsEnabled).toHaveBeenCalledWith(true);
    expect(setProblemContext).toHaveBeenCalledWith({
      workspaceId: '00000000-0000-0000-0000-000000000001',
    });
  });
});
