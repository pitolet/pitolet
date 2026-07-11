import { Button } from '@pitolet/ui';
import { FileText, Plus, Settings } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, api, type WorkspaceSummary } from '../api.js';
import { navigate } from '../router.js';
import { slugError, suggestSlug } from '../slug.js';

export function Workspaces({
  workspaces,
  onCreated,
}: {
  workspaces: WorkspaceSummary[];
  onCreated: (ws: WorkspaceSummary) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="ptl-dash-page-head">
        <div>
          <h1 className="ptl-dash-title">Workspaces</h1>
          <p className="ptl-dash-subtitle">Open a workspace or spin up a new one.</p>
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New workspace
          </Button>
        )}
      </div>

      {creating && (
        <CreateForm
          onCancel={() => setCreating(false)}
          onCreated={(ws) => {
            setCreating(false);
            onCreated(ws);
          }}
        />
      )}

      {workspaces.length === 0 && !creating ? (
        <div className="ptl-dash-empty">
          You're not in any workspaces yet. Create your first one to get started.
        </div>
      ) : (
        <div className="ptl-dash-grid">
          {workspaces.map((ws) => (
            <WorkspaceCard key={ws.id} ws={ws} />
          ))}
        </div>
      )}
    </>
  );
}

function WorkspaceCard({ ws }: { ws: WorkspaceSummary }) {
  return (
    <div className="ptl-dash-card">
      <div className="ptl-dash-card-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="ptl-dash-card-name">{ws.name}</h2>
          <p className="ptl-dash-card-slug">/{ws.slug}</p>
        </div>
        <span className="ptl-badge ptl-badge--role">{ws.role}</span>
      </div>
      <div>
        <span className="ptl-badge ptl-badge--plan">{ws.plan}</span>
      </div>
      <div className="ptl-dash-card-actions">
        {/* Plain link into the per-workspace editor runtime. */}
        <a href={`/w/${ws.slug}/`}>
          <Button variant="primary" size="sm">
            Open
          </Button>
        </a>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/docs/${ws.id}`)}>
          <FileText size={13} /> Documents
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/settings/${ws.id}`)}>
          <Settings size={13} /> Settings
        </Button>
      </div>
    </div>
  );
}

function CreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (ws: WorkspaceSummary) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Track whether the user has hand-edited the slug; if not, keep it in sync
  // with the name so typing a name auto-suggests a slug.
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveSlug = slugTouched ? slug : suggestSlug(name);
  const localSlugError = effectiveSlug ? slugError(effectiveSlug) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (localSlugError) {
      setError(localSlugError);
      return;
    }
    setBusy(true);
    try {
      const { workspace } = await api.createWorkspace({ name: name.trim(), slug: effectiveSlug });
      onCreated(workspace);
    } catch (err) {
      // 400 (slug rules) and 409 (taken) both carry a server message.
      setError(err instanceof ApiError ? err.message : 'Could not create workspace');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ptl-dash-form" onSubmit={submit}>
      <div className="ptl-dash-form-row">
        <div className="ptl-dash-field" style={{ margin: 0 }}>
          <label className="ptl-dash-label" htmlFor="ws-name">
            Name
          </label>
          <input
            id="ws-name"
            className="ptl-dash-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Design"
            autoFocus
          />
        </div>
        <div className="ptl-dash-field" style={{ margin: 0 }}>
          <label className="ptl-dash-label" htmlFor="ws-slug">
            Slug
          </label>
          <input
            id="ws-slug"
            className={`ptl-dash-input${localSlugError ? ' is-invalid' : ''}`}
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="acme-design"
            spellCheck={false}
          />
          <span className="ptl-dash-field-error">{localSlugError ?? ''}</span>
        </div>
      </div>

      {error && <div className="ptl-dash-error">{error}</div>}

      <div className="ptl-dash-form-actions">
        <Button type="submit" variant="primary" disabled={busy || !!localSlugError}>
          Create workspace
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
