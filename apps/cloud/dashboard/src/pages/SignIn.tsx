import { BrandMark, Button } from '@pitolet/ui';
import { type FormEvent, useState } from 'react';
import { authClient } from '../authClient.js';

type Mode = 'sign-in' | 'sign-up';

/**
 * Signed-out `/` screen. Email+password (sign in / create account toggle) plus
 * a magic-link option. Uses the better-auth react client; on success the parent
 * re-fetches /api/me and swaps to the workspace list.
 *
 * Social sign-in (github/google) is intentionally omitted here — the server
 * only registers those providers when their env credentials exist (I6). Render
 * them behind a config check when that lands:
 *   // <Button onClick={() => authClient.signIn.social({ provider: 'github' })}>…
 */
export function SignIn({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'sign-up') {
        const { error } = await authClient.signUp.email({ email, password, name });
        if (error) throw new Error(error.message ?? 'Could not create account');
      } else {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) throw new Error(error.message ?? 'Invalid email or password');
      }
      // Honor `/?next=<path>` (set by the server when an anonymous browser
      // hits a workspace URL). Same-origin paths only — a leading single `/`
      // and never `//host` — so this can't become an open redirect.
      const next = new URLSearchParams(window.location.search).get('next');
      if (next && next.startsWith('/') && !next.startsWith('//')) {
        window.location.assign(next);
        return;
      }
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function sendMagicLink() {
    setError(null);
    setNotice(null);
    if (!email) {
      setError('Enter your email first');
      return;
    }
    setBusy(true);
    try {
      // Carry ?next through the email round-trip (same-origin guard as above).
      const next = new URLSearchParams(window.location.search).get('next');
      const callbackURL = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      const { error } = await authClient.signIn.magicLink({
        email,
        callbackURL,
      });
      if (error) throw new Error(error.message ?? 'Could not send link');
      setNotice(`We emailed a sign-in link to ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ptl-dash-auth">
      <form className="ptl-dash-auth-card" onSubmit={submit}>
        <div className="ptl-dash-auth-brand" style={{ color: 'var(--ptl-accent)' }}>
          <BrandMark size={24} />
          <span className="ptl-dash-auth-brand-name">Pitolet</span>
        </div>
        <p className="ptl-dash-auth-tagline">
          {mode === 'sign-in' ? 'Sign in to your workspaces' : 'Create your Pitolet account'}
        </p>

        {notice && <div className="ptl-dash-notice">{notice}</div>}

        {mode === 'sign-up' && (
          <div className="ptl-dash-field">
            <label className="ptl-dash-label" htmlFor="name">
              Name
            </label>
            <input
              id="name"
              className="ptl-dash-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="Ada Lovelace"
            />
          </div>
        )}

        <div className="ptl-dash-field">
          <label className="ptl-dash-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="ptl-dash-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@company.com"
            required
          />
        </div>

        <div className="ptl-dash-field">
          <label className="ptl-dash-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="ptl-dash-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            required
          />
        </div>

        {error && <div className="ptl-dash-error">{error}</div>}

        <div className="ptl-dash-auth-actions">
          <Button
            type="submit"
            variant="primary"
            className="ptl-dash-btn-block"
            disabled={busy}
          >
            {mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </Button>
        </div>

        <div className="ptl-dash-divider">or</div>

        <Button
          type="button"
          variant="outline"
          className="ptl-dash-btn-block"
          disabled={busy}
          onClick={sendMagicLink}
        >
          Email me a sign-in link
        </Button>

        <div className="ptl-dash-linkrow">
          <span style={{ color: 'var(--ptl-text-3)' }}>
            {mode === 'sign-in' ? 'No account yet?' : 'Already have an account?'}
          </span>
          <button
            type="button"
            className="ptl-dash-link"
            onClick={() => {
              setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
              setError(null);
              setNotice(null);
            }}
          >
            {mode === 'sign-in' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
