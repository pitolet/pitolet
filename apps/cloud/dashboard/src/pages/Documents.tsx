import { Button, Tabs } from '@pitolet/ui';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, type DocumentSummary, type Me, type WorkspaceSummary } from '../api.js';
import { navigate } from '../router.js';
import { History } from './docs/History.js';
import { Sharing } from './docs/Sharing.js';

/**
 * /docs/:workspaceId — the workspace documents page. Resolves the workspace
 * (and the caller's role) from the already-loaded /api/me payload, then lists
 * the workspace's documents via the per-workspace runtime (/w/:slug/api/
 * documents — the session cookie authenticates it). Each doc row expands into
 * a two-tab detail panel: History (version snapshots) and Sharing (public
 * read-only links). Role gating mirrors the API: any member browses history;
 * editor|owner save/restore versions and manage share links.
 */
export function Documents({ me, workspaceId }: { me: Me; workspaceId: string }) {
  const ws = me.workspaces.find((w) => w.id === workspaceId);

  if (!ws) {
    return (
      <>
        <BackLink />
        <div className="ptl-dash-empty">
          Workspace not found, or you don't have access to it.
        </div>
      </>
    );
  }

  return <DocumentsList ws={ws} />;
}

function DocumentsList({ ws }: { ws: WorkspaceSummary }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { documents } = await api.documents(ws.slug);
        if (!cancelled) setDocs(documents);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load documents');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ws.slug]);

  return (
    <>
      <BackLink />
      <div className="ptl-dash-page-head">
        <div>
          <h1 className="ptl-dash-title">{ws.name}</h1>
          <p className="ptl-dash-subtitle">
            Documents · version history and sharing ·{' '}
            <span style={{ textTransform: 'capitalize' }}>{ws.role}</span>
          </p>
        </div>
      </div>

      {error && (
        <div className="ptl-dash-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {docs === null ? (
        <div className="ptl-dash-empty">Loading documents…</div>
      ) : docs.length === 0 ? (
        <div className="ptl-dash-empty">
          This workspace has no documents yet. Open the editor to create one.
        </div>
      ) : (
        <div className="ptl-dash-list">
          {docs.map((doc) => (
            <DocRow
              key={doc.id}
              ws={ws}
              doc={doc}
              open={openId === doc.id}
              onToggle={() => setOpenId((cur) => (cur === doc.id ? null : doc.id))}
            />
          ))}
        </div>
      )}
    </>
  );
}

function DocRow({
  ws,
  doc,
  open,
  onToggle,
}: {
  ws: WorkspaceSummary;
  doc: DocumentSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState('history');

  return (
    <div className="ptl-dash-doc">
      <div className="ptl-dash-row">
        <button type="button" className="ptl-dash-doc-toggle" onClick={onToggle}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span className="ptl-dash-row-name">{doc.name || 'Untitled'}</span>
        </button>
        <div className="ptl-dash-row-actions">
          <span className="ptl-dash-row-meta">
            {doc.frameCount} {doc.frameCount === 1 ? 'frame' : 'frames'} · rev {doc.rev}
          </span>
          {/* The editor opens the workspace's first doc; multi-doc routing is a
              future editor feature (noted in the spec). */}
          <a href={`/w/${ws.slug}/`}>
            <Button variant="ghost" size="sm">
              Open in editor
            </Button>
          </a>
        </div>
      </div>

      {open && (
        <div className="ptl-dash-doc-detail">
          <div className="ptl-dash-tabbar">
            <Tabs
              value={tab}
              onValueChange={setTab}
              tabs={[
                { value: 'history', label: 'History' },
                { value: 'sharing', label: 'Sharing' },
              ]}
            />
          </div>
          {tab === 'history' ? (
            <History ws={ws} docId={doc.id} />
          ) : (
            <Sharing ws={ws} docId={doc.id} />
          )}
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <button type="button" className="ptl-dash-back" onClick={() => navigate('/')}>
      <ChevronLeft size={14} /> All workspaces
    </button>
  );
}
