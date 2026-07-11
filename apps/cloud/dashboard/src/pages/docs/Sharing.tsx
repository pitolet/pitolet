import { Button, Select } from '@pitolet/ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, type ShareLink, type WorkspaceSummary } from '../../api.js';
import { ConfirmButton } from '../Settings.js';
import { formatDate } from '../../time.js';

/**
 * Public share links for one document (owner|editor). Each link's token IS the
 * URL — there is no secret-once ceremony (unlike agent tokens); the full link is
 * listable and re-copyable any time. Free-plan workspaces cap active links per
 * doc; the server's 429 reason surfaces inline on the create form.
 */
export function Sharing({ ws, docId }: { ws: WorkspaceSummary; docId: string }) {
  const canManage = ws.role === 'owner' || ws.role === 'editor';

  if (!canManage) {
    return (
      <div className="ptl-dash-notice">
        Your role is read-only. Only an editor or owner can create or revoke
        sharing links.
      </div>
    );
  }

  return <SharingManager ws={ws} docId={docId} />;
}

function SharingManager({ ws, docId }: { ws: WorkspaceSummary; docId: string }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const { shareLinks } = await api.shareLinks(ws.id, docId);
      // Hide revoked/expired links from the active list.
      const now = Date.now();
      setLinks(
        shareLinks.filter(
          (l) => !l.revokedAt && (!l.expiresAt || new Date(l.expiresAt).getTime() > now),
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load share links');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id, docId]);

  async function revoke(link: ShareLink) {
    setError(null);
    try {
      await api.revokeShareLink(ws.id, link.token);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke link');
    }
  }

  return (
    <>
      <CreateLinkForm ws={ws} docId={docId} onCreated={reload} />

      <div className="ptl-dash-section-head">
        <h2 className="ptl-dash-section-title">Active links</h2>
      </div>

      {error && (
        <div className="ptl-dash-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {links === null ? (
        <div className="ptl-dash-empty">Loading links…</div>
      ) : links.length === 0 ? (
        <div className="ptl-dash-empty">
          No active share links. Anyone with a link gets read-only access to this
          document.
        </div>
      ) : (
        <div className="ptl-dash-list">
          {links.map((l) => (
            <div className="ptl-dash-row" key={l.token}>
              <div className="ptl-dash-row-main">
                <ShareUrl url={l.url} />
                <span className="ptl-dash-row-meta">
                  created {formatDate(l.createdAt)} ·{' '}
                  {l.expiresAt ? `expires ${formatDate(l.expiresAt)}` : 'never expires'}
                </span>
              </div>
              <div className="ptl-dash-row-actions">
                <ConfirmButton
                  label="Revoke"
                  confirmLabel="Confirm revoke"
                  onConfirm={() => revoke(l)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The full share URL (origin + path) with a copy-to-clipboard affordance. */
function ShareUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const full = window.location.origin + url;

  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (e.g. insecure context) — the value is selectable.
    }
  }

  return (
    <span className="ptl-dash-share-url">
      <code className="ptl-dash-share-code">{full}</code>
      <Button variant="ghost" size="sm" onClick={copy}>
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never expires' },
  { value: '7', label: 'Expires in 7 days' },
  { value: '30', label: 'Expires in 30 days' },
];

function CreateLinkForm({
  ws,
  docId,
  onCreated,
}: {
  ws: WorkspaceSummary;
  docId: string;
  onCreated: () => void;
}) {
  const [expiry, setExpiry] = useState('never');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      const expiresInDays = expiry === 'never' ? undefined : Number(expiry);
      await api.createShareLink(ws.id, { docId, ...(expiresInDays ? { expiresInDays } : {}) });
      onCreated();
    } catch (err) {
      // 429 → free-plan limit; the server's reason string is the message.
      setError(err instanceof ApiError ? err.message : 'Could not create share link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="ptl-dash-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="ptl-dash-form-row">
        <div className="ptl-dash-field" style={{ margin: 0, flex: '1 1 200px', maxWidth: 220 }}>
          <label className="ptl-dash-label">Create a share link</label>
          <Select value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS} />
        </div>
        <div className="ptl-dash-form-actions" style={{ margin: 0, alignItems: 'flex-end' }}>
          <Button type="submit" variant="primary" disabled={busy}>
            Create share link
          </Button>
        </div>
      </div>
      {error && <div className="ptl-dash-error">{error}</div>}
    </form>
  );
}
