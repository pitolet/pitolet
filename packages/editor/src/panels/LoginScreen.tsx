import { BrandMark, Button, Input } from '@pitolet/ui';
import { useState } from 'react';
import { apiUrl } from '../sync/serverBase.js';
import './LoginScreen.css';

/**
 * Minimal centered login, shown INSTEAD of the editor when the boot fetch
 * returns 401 (before any document loads). On a successful login the server
 * sets an httpOnly cookie; we then re-run the boot sequence via `onSuccess`.
 */
export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      if (res.status === 401) {
        setError('Incorrect password');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ptl-login">
      <form className="ptl-login-card" onSubmit={submit}>
        <div className="ptl-login-brand">
          <BrandMark size={22} />
          <span className="ptl-login-wordmark">Pitolet</span>
        </div>
        <Input
          type="password"
          value={password}
          autoFocus
          placeholder="Password"
          aria-label="Password"
          className="ptl-login-input"
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
        />
        {error && <p className="ptl-login-error">{error}</p>}
        <Button type="submit" variant="primary" className="ptl-login-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
