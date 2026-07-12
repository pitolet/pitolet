import { Button } from '@pitolet/ui';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type CreatedToken,
  type TokenSummary,
  type WorkspaceSummary,
} from '../../api.js';
import { ConfirmButton } from '../Settings.js';

type Scopes = Array<'read' | 'write'>;

/**
 * Agent tokens tab (owner|editor — viewers get 403 and see the error). The raw
 * `ptl_…` token is returned by POST exactly once and stored only as a hash
 * server-side, so on 201 we stash the raw value in local state and render it in
 * a copy-to-clipboard panel with a "shown only once" warning. It is never
 * re-fetchable; dismissing the panel drops it from memory for good.
 */
export function Tokens({ ws }: { ws: WorkspaceSummary }) {
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreatedToken | null>(null);

  async function reload() {
    try {
      const { tokens } = await api.tokens(ws.id);
      // Hide revoked tokens from the active list.
      setTokens(tokens.filter((t) => !t.revokedAt));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load tokens');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id]);

  async function revoke(token: TokenSummary) {
    setError(null);
    try {
      await api.revokeToken(ws.id, token.id);
      if (justCreated?.id === token.id) setJustCreated(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke token');
    }
  }

  return (
    <>
      {justCreated && (
        <TokenReveal token={justCreated} ws={ws} onDismiss={() => setJustCreated(null)} />
      )}

      <CreateTokenForm
        ws={ws}
        onCreated={(t) => {
          setJustCreated(t);
          void reload();
        }}
      />

      <div className="ptl-dash-section-head">
        <h2 className="ptl-dash-section-title">Active tokens</h2>
      </div>

      {error && (
        <div className="ptl-dash-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {tokens === null ? (
        <div className="ptl-dash-empty">Loading tokens…</div>
      ) : tokens.length === 0 ? (
        <div className="ptl-dash-empty">No agent tokens yet.</div>
      ) : (
        <div className="ptl-dash-list">
          {tokens.map((t) => (
            <div className="ptl-dash-row" key={t.id}>
              <div className="ptl-dash-row-main">
                <span className="ptl-dash-row-name">{t.name}</span>
                <span className="ptl-dash-row-meta">
                  <code>{t.tokenPrefix}…</code> · created {formatDate(t.createdAt)} · last used{' '}
                  {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'never'}
                </span>
              </div>
              <div className="ptl-dash-row-actions">
                {t.scopes.map((s) => (
                  <span key={s} className="ptl-badge ptl-badge--scope">
                    {s}
                  </span>
                ))}
                <ConfirmButton
                  label="Revoke"
                  confirmLabel="Confirm revoke"
                  onConfirm={() => revoke(t)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TokenReveal({
  token,
  ws,
  onDismiss,
}: {
  token: CreatedToken;
  ws: WorkspaceSummary;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [importCopied, setImportCopied] = useState(false);
  const importCommand = `PITOLET_TOKEN='${token.token}' npx pitolet import http://localhost:3000 --to ${window.location.origin}/w/${ws.slug}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (e.g. insecure context) — the value is selectable.
    }
  }

  async function copyImportCommand() {
    try {
      await navigator.clipboard.writeText(importCommand);
      setImportCopied(true);
      setTimeout(() => setImportCopied(false), 2000);
    } catch {
      // The command remains selectable if clipboard access is unavailable.
    }
  }

  return (
    <div className="ptl-dash-token-reveal">
      <div className="ptl-dash-token-warn">
        <AlertTriangle size={15} />
        Copy this token now — it is shown only once and cannot be recovered.
      </div>
      <div className="ptl-dash-token-value">
        <span className="ptl-dash-token-code">{token.token}</span>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {token.scopes.includes('write') && (
        <>
          <div className="ptl-dash-token-warn" style={{ marginTop: 12 }}>
            Run this on the same machine as the site you want to import:
          </div>
          <div className="ptl-dash-token-value">
            <span className="ptl-dash-token-code">{importCommand}</span>
            <Button variant="outline" size="sm" onClick={copyImportCommand}>
              {importCopied ? <Check size={13} /> : <Copy size={13} />}{' '}
              {importCopied ? 'Copied' : 'Copy command'}
            </Button>
          </div>
        </>
      )}
      <div className="ptl-dash-form-actions">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          I've saved it
        </Button>
      </div>
    </div>
  );
}

function CreateTokenForm({
  ws,
  onCreated,
}: {
  ws: WorkspaceSummary;
  onCreated: (t: CreatedToken) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scopes>(['read', 'write']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readWrite = scopes.includes('write');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    try {
      const created = await api.createToken(ws.id, { name: name.trim(), scopes });
      setName('');
      setScopes(['read', 'write']);
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create token');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ptl-dash-form" onSubmit={submit}>
      <div className="ptl-dash-form-row">
        <div className="ptl-dash-field" style={{ margin: 0, flex: '2 1 240px' }}>
          <label className="ptl-dash-label" htmlFor="token-name">
            New agent token
          </label>
          <input
            id="token-name"
            className="ptl-dash-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CI bot"
          />
        </div>
        <div className="ptl-dash-scope" style={{ flex: '1 1 200px' }}>
          <span className="ptl-dash-label">Scope</span>
          <div className="ptl-dash-scope-options">
            <button
              type="button"
              className={`ptl-dash-scope-opt${!readWrite ? ' is-active' : ''}`}
              onClick={() => setScopes(['read'])}
            >
              Read only
            </button>
            <button
              type="button"
              className={`ptl-dash-scope-opt${readWrite ? ' is-active' : ''}`}
              onClick={() => setScopes(['read', 'write'])}
            >
              Read + write
            </button>
          </div>
        </div>
      </div>
      {error && <div className="ptl-dash-error">{error}</div>}
      <div className="ptl-dash-form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          Create token
        </Button>
      </div>
    </form>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
