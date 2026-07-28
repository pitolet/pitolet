import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInEmail, signUpEmail, getSession, sendMagicLink } = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getSession: vi.fn(),
  sendMagicLink: vi.fn(),
}));

vi.mock('../src/authClient.js', () => ({
  authClient: {
    signIn: { email: signInEmail, magicLink: sendMagicLink },
    signUp: { email: signUpEmail },
    getSession,
  },
}));

import type { WorkspaceSummary } from '../src/api.js';
import { AgentSetup } from '../src/components/AgentSetup.js';
import { TopBar } from '../src/components/TopBar.js';
import { SignIn } from '../src/pages/SignIn.js';
import { Workspaces } from '../src/pages/Workspaces.js';

const workspace: WorkspaceSummary = {
  id: 'workspace-1',
  name: 'Product',
  slug: 'product',
  plan: 'free',
  role: 'owner',
};

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe('dashboard interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // React uses this flag to ensure state updates are awaited in tests.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps a sign-in failure on the form', async () => {
    signInEmail.mockResolvedValue({
      error: { message: 'Email or password is incorrect' },
    });

    await act(async () => root.render(<SignIn onAuthed={vi.fn()} />));
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('#email')!, 'person@example.com');
      setInput(container.querySelector<HTMLInputElement>('#password')!, 'wrong');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Email or password is incorrect');
    expect(container.textContent).toContain('Sign in');
  });

  it('creates a workspace from the contextual empty state', async () => {
    const created = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ workspace }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await act(async () => root.render(<Workspaces workspaces={[]} onCreated={created} />));
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('#ws-name')!, 'Product');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(created).toHaveBeenCalledWith(workspace);
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows document and frame counts on workspace cards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            documents: [
              { id: 'doc-1', name: 'Home', rev: 1, frameCount: 3 },
              { id: 'doc-2', name: 'Pricing', rev: 1, frameCount: 2 },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    await act(async () => root.render(<Workspaces workspaces={[workspace]} onCreated={vi.fn()} />));
    await act(async () => {});

    expect(container.textContent).toContain('2 documents');
    expect(container.textContent).toContain('5 frames');
  });

  it('shows token-limit failures inline and keeps setup available', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tokens: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Free workspaces can have one active token.' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(<AgentSetup workspace={workspace} />));
    await act(async () => {});
    await act(async () => button(container, 'Create token').click());

    expect(container.textContent).toContain('Free workspaces can have one active token.');
    expect(container.textContent).toContain('Connect an agent');
  });

  it('closes the account menu when clicking outside or pressing Escape', async () => {
    await act(async () =>
      root.render(
        <TopBar user={{ name: 'Jacques', email: 'jacques@example.com' }} onSignOut={vi.fn()} />,
      ),
    );
    const menu = container.querySelector<HTMLDetailsElement>('.ptl-account-menu')!;

    menu.open = true;
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(menu.open).toBe(false);

    menu.open = true;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('summary'));
  });
});
