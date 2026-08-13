import { BrandMark, Button } from '@pitolet/ui';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { authClient } from '../authClient.js';

type Mode = 'sign-in' | 'sign-up';
type AuthError = { code?: string; message?: string; status?: number };
type VerificationState = 'needed' | 'sent' | 'resent';
type VerificationNotice = { email: string; state: VerificationState };

function isEmailNotVerified(error: AuthError): boolean {
  return (
    error.code === 'EMAIL_NOT_VERIFIED' ||
    error.message?.trim().toLowerCase() === 'email not verified'
  );
}

function verificationSendError(error: AuthError): string {
  if (error.status === 429 || error.code === 'TOO_MANY_REQUESTS') {
    return 'Too many verification emails were requested. Wait a minute, then try again.';
  }
  return 'We could not send another verification email. Try again in a moment.';
}

export function SignIn({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationNotice | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setVerification(null);
    setBusy(true);
    try {
      if (mode === 'sign-up') {
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) throw new Error(result.error.message ?? 'Could not create account');
        const session = await authClient.getSession();
        if (!session.data) {
          setVerification({ email, state: 'sent' });
          setMode('sign-in');
          setPassword('');
          return;
        }
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) {
          if (isEmailNotVerified(result.error)) {
            await sendVerification(email, 'resent');
            return;
          }
          throw new Error(result.error.message ?? 'Email or password is incorrect');
        }
      }
      const next = new URLSearchParams(window.location.search).get('next');
      if (next && next.startsWith('/') && !next.startsWith('//')) {
        window.location.assign(next);
        return;
      }
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function sendVerification(address: string, successState: VerificationState) {
    setVerification({ email: address, state: 'needed' });
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const callbackURL = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      const result = await authClient.sendVerificationEmail({
        email: address,
        callbackURL,
      });
      if (result.error) {
        setError(verificationSendError(result.error));
        return;
      }
      setVerification({ email: address, state: successState });
    } catch {
      setError('We could not send another verification email. Try again in a moment.');
    }
  }

  async function resendVerification() {
    if (!verification || busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    await sendVerification(verification.email, 'resent');
    setBusy(false);
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
      const next = new URLSearchParams(window.location.search).get('next');
      const callbackURL = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      const result = await authClient.signIn.magicLink({ email, callbackURL });
      if (result.error) throw new Error(result.error.message ?? 'Could not send the link');
      setNotice(`We sent a sign-in link to ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="ptl-auth-page">
      <section className="ptl-auth-intro">
        <div className="ptl-auth-brand">
          <BrandMark size={24} />
          <span>Pitolet</span>
        </div>
        <div>
          <h1>Edit the pages your coding agent builds.</h1>
          <p>
            Pitolet gives you and your agent the same editable page. Your changes remain usable as
            code.
          </p>
        </div>
        <div className="ptl-auth-points">
          <span>
            <CheckCircle2 size={15} /> Edit the live page
          </span>
          <span>
            <CheckCircle2 size={15} /> Import an existing site
          </span>
        </div>
      </section>

      <section className="ptl-auth-panel">
        <form className="ptl-dash-auth-card" onSubmit={submit}>
          <div className="ptl-auth-form-head">
            <h2>{mode === 'sign-in' ? 'Sign in' : 'Create your account'}</h2>
            <p>
              {mode === 'sign-in'
                ? 'Open your Pitolet workspaces.'
                : 'Start with a free workspace.'}
            </p>
          </div>

          {notice && <div className="ptl-dash-notice">{notice}</div>}

          {verification && (
            <div className="ptl-auth-verification" role="status" aria-live="polite">
              <MailCheck size={20} aria-hidden="true" />
              <div>
                <strong>
                  {verification.state === 'needed'
                    ? 'Verify your email'
                    : verification.state === 'resent'
                      ? 'Verification email sent again'
                      : 'Verification email sent'}
                </strong>
                <p>
                  {verification.state === 'needed' ? (
                    <>
                      <b>{verification.email}</b> has not been verified. Send a new verification
                      email to continue.
                    </>
                  ) : (
                    <>
                      Open the email sent to <b>{verification.email}</b> to verify your address and
                      continue.
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className="ptl-dash-link ptl-auth-resend"
                  disabled={busy}
                  onClick={resendVerification}
                >
                  {busy ? 'Sending…' : 'Resend verification email'}
                </button>
              </div>
            </div>
          )}

          {mode === 'sign-up' && (
            <div className="ptl-dash-field">
              <label className="ptl-dash-label" htmlFor="name">
                Name
              </label>
              <input
                id="name"
                className="ptl-dash-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
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
              onChange={(event) => {
                setEmail(event.target.value);
                setVerification(null);
                setError(null);
                setNotice(null);
              }}
              autoComplete="email"
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
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              required
            />
          </div>

          {error && (
            <div className="ptl-dash-error" role="alert">
              {error}
            </div>
          )}

          <Button type="submit" variant="primary" className="ptl-dash-btn-block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </Button>

          <div className="ptl-dash-divider">
            <span>or</span>
          </div>

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
            <span>{mode === 'sign-in' ? 'New to Pitolet?' : 'Already have an account?'}</span>
            <button
              type="button"
              className="ptl-dash-link"
              onClick={() => {
                setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                setError(null);
                setNotice(null);
                setVerification(null);
              }}
            >
              {mode === 'sign-in' ? 'Create an account' : 'Sign in'}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
