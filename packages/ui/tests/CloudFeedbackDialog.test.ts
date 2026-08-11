import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudFeedbackDialog } from '../src/CloudFeedbackDialog.js';

let root: Root;
let host: HTMLDivElement;

function setValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value() {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      },
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('CloudFeedbackDialog', () => {
  it('shows support access only when the server says it is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            workspaceId: 'workspace-1',
            documentId: 'document-1',
            canGrantSupportAccess: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await act(async () => {
      root.render(
        createElement(CloudFeedbackDialog, {
          open: true,
          onOpenChange: vi.fn(),
          source: 'editor',
          workspaceId: 'workspace-1',
          documentId: 'document-1',
        }),
      );
    });
    await act(async () => {});
    expect(host.textContent).toContain('Let Pitolet support open this document for 7 days');
  });

  it('submits the selected options without persisting credentials in browser storage', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
      });
      if (url.startsWith('/api/feedback/context')) {
        return new Response(
          JSON.stringify({ workspaceId: null, documentId: null, canGrantSupportAccess: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'feedback-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    await act(async () => {
      root.render(
        createElement(CloudFeedbackDialog, {
          open: true,
          onOpenChange: vi.fn(),
          source: 'dashboard',
          recentErrors: ['Bearer a-secret-that-must-not-be-stored-locally'],
        }),
      );
    });
    await act(async () => {});
    const textarea = host.querySelector('textarea')!;
    await act(async () => setValue(textarea, 'The import stopped.'));
    const diagnostics = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent?.includes('technical details'),
    )!;
    await act(async () => diagnostics.click());
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const submitted = requests.find((request) => request.url === '/api/feedback')?.body;
    expect(submitted).toMatchObject({
      category: 'general',
      message: 'The import stopped.',
      includeDiagnostics: true,
      source: 'dashboard',
    });
    expect(host.textContent).toContain('Feedback sent');
    expect([...storage.values()].join('')).not.toContain(
      'a-secret-that-must-not-be-stored-locally',
    );
  });
});
