import { Button, Tabs } from '@pitolet/ui';
import { ArrowLeft, ArrowRight, FileText, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { documentUrl } from '../agentSetup.js';
import { ApiError, api, type DocumentSummary, type WorkspaceSummary } from '../api.js';
import { WorkspaceShell } from '../components/WorkspaceShell.js';
import { navigate, workspacePath } from '../router.js';
import { History } from './docs/History.js';
import { Sharing } from './docs/Sharing.js';

export function Documents({
  workspace,
  documentId,
}: {
  workspace: WorkspaceSummary;
  documentId?: string;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const response = await api.documents(workspace.slug);
      setDocuments(response.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load documents.');
    }
  }, [workspace.slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (documentId) {
    const document = documents?.find((candidate) => candidate.id === documentId);
    return (
      <DocumentDetail
        workspace={workspace}
        documentId={documentId}
        document={document}
        loading={documents === null && !error}
      />
    );
  }

  return (
    <WorkspaceShell
      workspace={workspace}
      active="documents"
      title="Documents"
      description={`Pages in ${workspace.name}`}
    >
      <DocumentBrowser workspace={workspace} documents={documents} error={error} onRetry={reload} />
    </WorkspaceShell>
  );
}

function DocumentBrowser({
  workspace,
  documents,
  error,
  onRetry,
}: {
  workspace: WorkspaceSummary;
  documents: DocumentSummary[] | null;
  error: string | null;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return documents ?? [];
    return (documents ?? []).filter((document) =>
      (document.name || 'Untitled').toLowerCase().includes(needle),
    );
  }, [documents, query]);
  const origin = typeof window === 'undefined' ? 'https://app.pitolet.com' : window.location.origin;

  return (
    <section>
      <div className="ptl-document-tools">
        <label className="ptl-search-field">
          <Search size={15} />
          <span className="ptl-visually-hidden">Search documents</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search documents"
          />
        </label>
      </div>

      {error ? (
        <div className="ptl-state-card is-error">
          <strong>Documents could not load</strong>
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw size={13} /> Retry
          </Button>
        </div>
      ) : documents === null ? (
        <div className="ptl-skeleton-list" aria-label="Loading documents">
          <div className="ptl-skeleton-row" />
          <div className="ptl-skeleton-row" />
          <div className="ptl-skeleton-row" />
        </div>
      ) : documents.length === 0 ? (
        <div className="ptl-state-card">
          <FileText size={20} />
          <strong>No documents yet</strong>
          <span>Start from the workspace home or open the editor.</span>
          <Button variant="outline" onClick={() => navigate(workspacePath(workspace.id))}>
            Go to workspace home
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="ptl-state-card">
          <strong>No matching documents</strong>
          <Button variant="ghost" onClick={() => setQuery('')}>
            Clear search
          </Button>
        </div>
      ) : (
        <div className="ptl-document-list">
          {filtered.map((document) => (
            <article className="ptl-document-row" key={document.id}>
              <div className="ptl-document-icon">
                <FileText size={16} />
              </div>
              <div className="ptl-document-main">
                <strong>{document.name || 'Untitled'}</strong>
                <span>
                  {document.frameCount} {document.frameCount === 1 ? 'frame' : 'frames'}
                  {`, revision ${document.rev}`}
                </span>
              </div>
              <div className="ptl-document-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    navigate(
                      `${workspacePath(workspace.id, 'documents')}/${encodeURIComponent(document.id)}`,
                    )
                  }
                >
                  History and sharing
                </Button>
                <a
                  className="ptl-button ptl-button--outline ptl-button--sm"
                  href={documentUrl(origin, workspace, document.id)}
                >
                  Open <ArrowRight size={13} />
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function DocumentDetail({
  workspace,
  documentId,
  document,
  loading,
}: {
  workspace: WorkspaceSummary;
  documentId: string;
  document: DocumentSummary | undefined;
  loading: boolean;
}) {
  const [tab, setTab] = useState('history');
  const origin = typeof window === 'undefined' ? 'https://app.pitolet.com' : window.location.origin;

  return (
    <WorkspaceShell
      workspace={workspace}
      active="documents"
      title={loading ? 'Loading document…' : document?.name || 'Document'}
      description={
        document
          ? `${document.frameCount} ${document.frameCount === 1 ? 'frame' : 'frames'}, revision ${document.rev}`
          : 'History and sharing'
      }
      editorHref={document ? documentUrl(origin, workspace, document.id) : undefined}
      editorLabel={document ? 'Open document' : 'Open editor'}
      showEditorAction={!!document}
    >
      <button
        type="button"
        className="ptl-dash-back ptl-document-back"
        onClick={() => navigate(workspacePath(workspace.id, 'documents'))}
      >
        <ArrowLeft size={14} /> Documents
      </button>

      {!loading && !document ? (
        <div className="ptl-state-card">
          <strong>Document not found</strong>
          <span>It may have been removed.</span>
          <Button
            variant="outline"
            onClick={() => navigate(workspacePath(workspace.id, 'documents'))}
          >
            Back to documents
          </Button>
        </div>
      ) : (
        <section className="ptl-document-detail">
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: 'history', label: 'History' },
              { value: 'sharing', label: 'Sharing' },
            ]}
          />
          <div className="ptl-document-detail-body">
            {tab === 'history' ? (
              <History ws={workspace} docId={documentId} />
            ) : (
              <Sharing ws={workspace} docId={documentId} />
            )}
          </div>
        </section>
      )}
    </WorkspaceShell>
  );
}
