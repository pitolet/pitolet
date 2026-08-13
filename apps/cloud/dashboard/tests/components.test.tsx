import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInEmail, signUpEmail, getSession, sendMagicLink, sendVerificationEmail } = vi.hoisted(
  () => ({
    signInEmail: vi.fn(),
    signUpEmail: vi.fn(),
    getSession: vi.fn(),
    sendMagicLink: vi.fn(),
    sendVerificationEmail: vi.fn(),
  }),
);

vi.mock('../src/authClient.js', () => ({
  authClient: {
    signIn: { email: signInEmail, magicLink: sendMagicLink },
    signUp: { email: signUpEmail },
    getSession,
    sendVerificationEmail,
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
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
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

  it('explains that signing in sent another verification email', async () => {
    signInEmail.mockResolvedValue({
      error: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified', status: 403 },
    });
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });

    await act(async () => root.render(<SignIn onAuthed={vi.fn()} />));
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('#email')!, 'person@example.com');
      setInput(container.querySelector<HTMLInputElement>('#password')!, 'correct-password');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Verification email sent again');
    expect(container.textContent).toContain('person@example.com');
    expect(container.textContent).toContain('Resend verification email');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: 'person@example.com',
      callbackURL: '/',
    });
  });

  it('reports the first verification email after account creation', async () => {
    signUpEmail.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    getSession.mockResolvedValue({ data: null });

    await act(async () => root.render(<SignIn onAuthed={vi.fn()} />));
    await act(async () => button(container, 'Create an account').click());
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('#name')!, 'Person');
      setInput(container.querySelector<HTMLInputElement>('#email')!, 'person@example.com');
      setInput(container.querySelector<HTMLInputElement>('#password')!, 'new-password');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Verification email sent');
    expect(container.textContent).not.toContain('Verification email sent again');
  });

  it('lets an unverified user request another verification email', async () => {
    signInEmail.mockResolvedValue({
      error: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified', status: 403 },
    });
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });

    await act(async () => root.render(<SignIn onAuthed={vi.fn()} />));
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('#email')!, 'person@example.com');
      setInput(container.querySelector<HTMLInputElement>('#password')!, 'correct-password');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    sendVerificationEmail.mockClear();
    await act(async () => button(container, 'Resend verification email').click());

    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: 'person@example.com',
      callbackURL: '/',
    });
    expect(container.textContent).toContain('Verification email sent again');
  });

  it('explains when verification email requests are rate limited', async () => {
    signInEmail.mockResolvedValue({
      error: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified', status: 403 },
    });
    sendVerificationEmail.mockResolvedValue({
      data: null,
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests', status: 429 },
    });

    await act(async () => root.render(<SignIn onAuthed={vi.fn()} />));
    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('#email')!, 'person@example.com');
      setInput(container.querySelector<HTMLInputElement>('#password')!, 'correct-password');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain(
      'Too many verification emails were requested. Wait a minute, then try again.',
    );
    expect(container.textContent).toContain('Verify your email');
    expect(container.textContent).toContain('Resend verification email');
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
        <TopBar
          user={{ name: 'Jacques', email: 'jacques@example.com' }}
          isPlatformAdmin={false}
          onSignOut={vi.fn()}
        />,
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

  it('shows every owner-console destination only to platform admins', async () => {
    await act(async () =>
      root.render(
        <TopBar
          user={{ name: 'Jacques', email: 'jacques@example.com' }}
          isPlatformAdmin
          onSignOut={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain('Owner console');
    expect(container.textContent).toContain('Overview');
    expect(container.textContent).toContain('Users');
    expect(container.textContent).toContain('Feedback');
    expect(container.textContent).toContain('Problems');
  });

  it('opens dashboard feedback with the current document context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaceId: '00000000-0000-0000-0000-000000000001',
          documentId: 'doc-1',
          canGrantSupportAccess: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () =>
      root.render(
        <TopBar
          user={{ name: 'Jacques', email: 'jacques@example.com' }}
          isPlatformAdmin={false}
          workspaceId="00000000-0000-0000-0000-000000000001"
          documentId="doc-1"
          onSignOut={vi.fn()}
        />,
      ),
    );
    container.querySelector<HTMLDetailsElement>('.ptl-account-menu')!.open = true;
    await act(async () => button(container, 'Send feedback').click());
    await act(async () => {});

    expect(container.querySelector<HTMLDialogElement>('.ptl-feedback-dialog')?.open).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/feedback/context?workspaceId=00000000-0000-0000-0000-000000000001&documentId=doc-1',
    );
    expect(container.textContent).toContain('Let Pitolet support open this document for 7 days');
  });
});
