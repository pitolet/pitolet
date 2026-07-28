import { Button } from '@pitolet/ui';
import { ArrowRight, FileInput, FilePlus2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  documentUrl,
  mcpUrl,
  preferredClient,
  taskPrompt,
  validateImportUrl,
  workspaceHomePriority,
  workspaceUrl,
  type AgentClient,
  type ConnectionStatus,
} from '../agentSetup.js';
import { ApiError, api, type DocumentSummary, type WorkspaceSummary } from '../api.js';
import { AgentSetup } from '../components/AgentSetup.js';
import { CopyButton } from '../components/CopyButton.js';
import { WorkspaceShell } from '../components/WorkspaceShell.js';
import { navigate, workspacePath } from '../router.js';

export function WorkspaceHome({ workspace }: { workspace: WorkspaceSummary }) {
  const canEdit = workspace.role === 'owner' || workspace.role === 'editor';
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [client, setClient] = useState<AgentClient>(() => {
    try {
      return preferredClient(typeof window === 'undefined' ? undefined : window.localStorage);
    } catch {
      return 'codex';
    }
  });
  const [brief, setBrief] = useState('');
  const [sourceUrl, setSourceUrl] = useState('http://localhost:3000');

  const loadDocuments = useCallback(async () => {
    setDocumentsError(null);
    try {
      const response = await api.documents(workspace.slug);
      setDocuments(response.documents);
    } catch (err) {
      setDocumentsError(err instanceof ApiError ? err.message : 'Could not load documents.');
    }
  }, [workspace.slug]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const origin = typeof window === 'undefined' ? 'https://app.pitolet.com' : window.location.origin;
  const endpoint = mcpUrl(origin, workspace);
  const destination = workspaceUrl(origin, workspace);
  const connected = connection === 'connected';
  const priority = workspaceHomePriority({
    canEdit,
    connection,
    documentCount: documents?.length ?? null,
  });
  const importError = validateImportUrl(sourceUrl);
  const startText = useMemo(
    () =>
      taskPrompt({
        client,
        intent: 'scratch',
        connected,
        endpoint,
        destination,
        brief,
      }),
    [brief, client, connected, destination, endpoint],
  );
  const importText = useMemo(
    () =>
      taskPrompt({
        client,
        intent: 'import',
        connected,
        endpoint,
        destination,
        sourceUrl,
      }),
    [client, connected, destination, endpoint, sourceUrl],
  );

  return (
    <WorkspaceShell workspace={workspace} active="home">
      {canEdit ? (
        <div className={`ptl-smart-home is-${priority}`}>
          <section className={`ptl-home-connection${connected ? ' is-collapsed' : ''}`}>
            <AgentSetup
              workspace={workspace}
              onStatusChange={setConnection}
              client={client}
              onClientChange={setClient}
              title={
                connection === 'waiting' ? 'Finish connecting your agent' : 'Connect your agent'
              }
              description={
                connection === 'waiting'
                  ? 'A write token exists, but an agent has not used it yet.'
                  : 'Once connected, your agent can create and update documents in this workspace.'
              }
              compact
              collapseWhenConnected
            />
          </section>

          <IntentSection
            brief={brief}
            setBrief={setBrief}
            sourceUrl={sourceUrl}
            setSourceUrl={setSourceUrl}
            importError={importError}
            startText={startText}
            importText={importText}
            connected={connected}
            hasDocuments={!!documents?.length}
          />

          <RecentDocuments
            documents={documents}
            documentsError={documentsError}
            loadDocuments={loadDocuments}
            origin={origin}
            workspace={workspace}
          />
        </div>
      ) : (
        <>
          <RecentDocuments
            documents={documents}
            documentsError={documentsError}
            loadDocuments={loadDocuments}
            origin={origin}
            workspace={workspace}
          />
          <div className="ptl-callout ptl-home-viewer-note">
            <div>
              <strong>This workspace is read only for you</strong>
              <p>
                You can open documents, history, and sharing links. An editor can connect an agent
                or import a site.
              </p>
            </div>
          </div>
        </>
      )}
    </WorkspaceShell>
  );
}

function IntentSection({
  brief,
  setBrief,
  sourceUrl,
  setSourceUrl,
  importError,
  startText,
  importText,
  connected,
  hasDocuments,
}: {
  brief: string;
  setBrief: (value: string) => void;
  sourceUrl: string;
  setSourceUrl: (value: string) => void;
  importError: string | null;
  startText: string;
  importText: string;
  connected: boolean;
  hasDocuments: boolean;
}) {
  return (
    <section className="ptl-home-intents">
      <div className="ptl-home-intro">
        <h2>{connected && hasDocuments ? 'Start something new' : 'What are you working on?'}</h2>
        <p>
          {connected
            ? 'Describe a new page or import one you already have.'
            : 'Choose a task now. The copied prompt will include the connection steps.'}
        </p>
      </div>

      <div className="ptl-intent-grid">
        <article className="ptl-intent-card">
          <div className="ptl-intent-icon">
            <FilePlus2 size={20} />
          </div>
          <div className="ptl-intent-copy">
            <h3>Start a new page</h3>
            <p>Tell your agent what to make. It will create the document in Pitolet.</p>
          </div>
          <div className="ptl-intent-controls">
            <label className="ptl-dash-label" htmlFor="agent-brief">
              What should the agent build?
            </label>
            <textarea
              id="agent-brief"
              className="ptl-dash-textarea"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="A pricing page for a small accounting app"
              rows={3}
            />
            <CopyButton
              value={startText}
              label="Copy prompt for my agent"
              copiedLabel="Prompt copied"
              variant="primary"
              className="ptl-intent-action"
              disabled={!brief.trim()}
            />
          </div>
        </article>

        <article className="ptl-intent-card">
          <div className="ptl-intent-icon">
            <FileInput size={20} />
          </div>
          <div className="ptl-intent-copy">
            <h3>Import a site</h3>
            <p>Point your agent at a page it can reach from your computer.</p>
          </div>
          <div className="ptl-intent-controls">
            <label className="ptl-dash-label" htmlFor="import-source">
              Site address
            </label>
            <input
              id="import-source"
              className={`ptl-dash-input${importError ? ' is-invalid' : ''}`}
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              spellCheck={false}
            />
            {importError && <span className="ptl-dash-field-error">{importError}</span>}
            <CopyButton
              value={importText}
              label="Copy prompt for my agent"
              copiedLabel="Prompt copied"
              variant="primary"
              className="ptl-intent-action"
              disabled={!!importError}
            />
          </div>
        </article>
      </div>
    </section>
  );
}

function RecentDocuments({
  documents,
  documentsError,
  loadDocuments,
  origin,
  workspace,
}: {
  documents: DocumentSummary[] | null;
  documentsError: string | null;
  loadDocuments: () => Promise<void>;
  origin: string;
  workspace: WorkspaceSummary;
}) {
  return (
    <section className="ptl-home-documents">
      <div className="ptl-dash-section-head">
        <div>
          <h2 className="ptl-dash-section-title">Recent documents</h2>
          <p className="ptl-dash-subtitle">Pick up where you left off.</p>
        </div>
        {!!documents?.length && (
          <Button
            variant="ghost"
            onClick={() => navigate(workspacePath(workspace.id, 'documents'))}
          >
            View all <ArrowRight size={14} />
          </Button>
        )}
      </div>

      {documentsError ? (
        <div className="ptl-state-card is-error">
          <span>{documentsError}</span>
          <Button variant="outline" size="sm" onClick={loadDocuments}>
            <RefreshCw size={13} /> Retry
          </Button>
        </div>
      ) : documents === null ? (
        <DocumentSkeleton />
      ) : documents.length === 0 ? (
        <div className="ptl-state-card">
          <strong>No documents yet</strong>
          <span>Your first document will appear here.</span>
        </div>
      ) : (
        <div className="ptl-recent-docs">
          {documents.slice(0, 4).map((document) => (
            <a
              key={document.id}
              className="ptl-recent-doc"
              href={documentUrl(origin, workspace, document.id)}
            >
              <div>
                <strong>{document.name || 'Untitled'}</strong>
                <span>
                  {document.frameCount} {document.frameCount === 1 ? 'frame' : 'frames'}
                </span>
              </div>
              <ArrowRight size={15} />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function DocumentSkeleton() {
  return (
    <div className="ptl-skeleton-list" aria-label="Loading documents">
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
    </div>
  );
}
