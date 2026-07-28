import { Button } from '@pitolet/ui';
import { ArrowRight, Files, PanelsTopLeft, Plus } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, type WorkspaceSummary } from '../api.js';
import { navigate, workspacePath } from '../router.js';
import { slugError, suggestSlug } from '../slug.js';

export function Workspaces({
  workspaces,
  onCreated,
}: {
  workspaces: WorkspaceSummary[];
  onCreated: (workspace: WorkspaceSummary) => void;
}) {
  const [creating, setCreating] = useState(workspaces.length === 0);

  return (
    <>
      <div className="ptl-dash-page-head">
        <div>
          <h1 className="ptl-dash-title">Workspaces</h1>
          <p className="ptl-dash-subtitle">Choose where you want to work.</p>
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New workspace
          </Button>
        )}
      </div>

      {creating && (
        <CreateForm
          canCancel={workspaces.length > 0}
          onCancel={() => setCreating(false)}
          onCreated={onCreated}
        />
      )}

      {workspaces.length > 0 && (
        <div className="ptl-workspace-grid">
          {workspaces.map((workspace) => (
            <WorkspaceCard workspace={workspace} key={workspace.id} />
          ))}
        </div>
      )}
    </>
  );
}

function WorkspaceCard({ workspace }: { workspace: WorkspaceSummary }) {
  const [stats, setStats] = useState<{ documents: number; frames: number } | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setStats(null);
    setStatsFailed(false);
    void api
      .documents(workspace.slug)
      .then(({ documents }) => {
        if (!active) return;
        setStats({
          documents: documents.length,
          frames: documents.reduce((total, document) => total + document.frameCount, 0),
        });
      })
      .catch(() => {
        if (active) setStatsFailed(true);
      });
    return () => {
      active = false;
    };
  }, [workspace.slug]);

  return (
    <button
      type="button"
      className="ptl-workspace-card"
      onClick={() => navigate(workspacePath(workspace.id))}
    >
      <div>
        <h2>{workspace.name}</h2>
        <p>/{workspace.slug}</p>
      </div>

      <div className="ptl-workspace-card-stats">
        {stats ? (
          <>
            <span>
              <Files size={13} />
              {stats.documents} {stats.documents === 1 ? 'document' : 'documents'}
            </span>
            <span>
              <PanelsTopLeft size={13} />
              {stats.frames} {stats.frames === 1 ? 'frame' : 'frames'}
            </span>
          </>
        ) : statsFailed ? (
          <span>Workspace details unavailable</span>
        ) : (
          <>
            <span className="ptl-workspace-stat-skeleton" />
            <span className="ptl-workspace-stat-skeleton is-short" />
          </>
        )}
      </div>

      <div className="ptl-workspace-card-foot">
        <span>{workspace.role}</span>
        <span className="ptl-workspace-open">
          Open <ArrowRight size={14} />
        </span>
      </div>
    </button>
  );
}

function CreateForm({
  canCancel,
  onCancel,
  onCreated,
}: {
  canCancel: boolean;
  onCancel: () => void;
  onCreated: (workspace: WorkspaceSummary) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugTouched ? slug : suggestSlug(name);
  const localSlugError = effectiveSlug ? slugError(effectiveSlug) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Enter a workspace name');
      return;
    }
    if (!effectiveSlug) {
      setError('Enter a workspace address');
      return;
    }
    if (localSlugError) {
      setError(localSlugError);
      return;
    }
    setBusy(true);
    try {
      const result = await api.createWorkspace({
        name: name.trim(),
        slug: effectiveSlug,
      });
      onCreated(result.workspace);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the workspace');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ptl-create-workspace" onSubmit={submit}>
      <div className="ptl-create-workspace-copy">
        <h2>Create a workspace</h2>
        <p>Your documents and agent connections live here.</p>
      </div>
      <div className="ptl-create-workspace-fields">
        <div className="ptl-dash-field">
          <label className="ptl-dash-label" htmlFor="ws-name">
            Workspace name
          </label>
          <input
            id="ws-name"
            className="ptl-dash-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme"
            autoFocus
          />
        </div>
        <div className="ptl-dash-field">
          <label className="ptl-dash-label" htmlFor="ws-slug">
            Workspace address
          </label>
          <div className="ptl-slug-field">
            <span>app.pitolet.com/w/</span>
            <input
              id="ws-slug"
              className={`ptl-dash-input${localSlugError ? ' is-invalid' : ''}`}
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
              spellCheck={false}
            />
          </div>
          {localSlugError && <span className="ptl-dash-field-error">{localSlugError}</span>}
        </div>
        {error && (
          <div className="ptl-dash-error" role="alert">
            {error}
          </div>
        )}
        <div className="ptl-dash-form-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !name.trim() || !effectiveSlug || !!localSlugError}
          >
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
          {canCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
