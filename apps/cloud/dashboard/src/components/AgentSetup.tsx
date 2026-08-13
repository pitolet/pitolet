import { Button, Tabs } from '@pitolet/ui';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  KeyRound,
  PlugZap,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  AGENT_CLIENTS,
  connectionPrompt,
  deriveConnectionStatus,
  manualSetup,
  mcpUrl,
  preferredClient,
  type AgentClient,
  type ConnectionStatus,
  type SetupMode,
} from '../agentSetup.js';
import {
  ApiError,
  api,
  type CreatedToken,
  type TokenSummary,
  type WorkspaceSummary,
} from '../api.js';
import { relativeTime } from '../time.js';
import { trackProductEvent } from '../analytics.js';
import { CopyButton } from './CopyButton.js';

export function AgentSetup({
  workspace,
  onStatusChange,
  client: controlledClient,
  onClientChange,
  title = 'Connect an agent',
  description = 'Choose your coding tool, then copy the setup prompt or its manual configuration.',
  compact = false,
  collapseWhenConnected = false,
  refreshTick,
}: {
  workspace: WorkspaceSummary;
  onStatusChange?: (status: ConnectionStatus) => void;
  client?: AgentClient;
  onClientChange?: (client: AgentClient) => void;
  title?: string;
  description?: string;
  compact?: boolean;
  collapseWhenConnected?: boolean;
  refreshTick?: number;
}) {
  const canConnect = workspace.role === 'owner' || workspace.role === 'editor';
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<SetupMode>('ask-agent');
  const [localClient, setLocalClient] = useState<AgentClient>(() => {
    try {
      return preferredClient(typeof window === 'undefined' ? undefined : window.localStorage);
    } catch {
      return 'codex';
    }
  });
  const client = controlledClient ?? localClient;

  const status = tokens ? deriveConnectionStatus(tokens) : 'not-connected';
  const endpoint = mcpUrl(
    typeof window === 'undefined' ? 'https://app.pitolet.com' : window.location.origin,
    workspace,
  );
  const setupText =
    mode === 'ask-agent' ? connectionPrompt(client, endpoint) : manualSetup(client, endpoint);
  const activeTokens = useMemo(() => tokens?.filter((token) => !token.revokedAt) ?? [], [tokens]);

  async function reload() {
    if (!canConnect) return;
    setError(null);
    try {
      const response = await api.tokens(workspace.id);
      setTokens(response.tokens.filter((token) => !token.revokedAt));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load agent connections.');
    }
  }

  useEffect(() => {
    if (canConnect) void reload();
    else setTokens([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, canConnect]);

  useEffect(() => {
    if (refreshTick === undefined || tokens === null || !canConnect) return;
    void reload();
    // reload is intentionally scoped to the current workspace values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    if (tokens !== null) onStatusChange?.(status);
  }, [onStatusChange, status, tokens]);

  function chooseClient(next: string) {
    const value = next as AgentClient;
    setLocalClient(value);
    onClientChange?.(value);
    try {
      window.localStorage.setItem('pitolet.agent-client', value);
    } catch {
      // A blocked storage API should not stop setup.
    }
  }

  async function createConnection() {
    setCreating(true);
    setError(null);
    try {
      const label = AGENT_CLIENTS.find((candidate) => candidate.value === client)?.label ?? 'Agent';
      const token = await api.createToken(workspace.id, {
        name: `${label} connection`,
        scopes: ['read', 'write'],
      });
      setCreated(token);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the connection.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: TokenSummary) {
    setError(null);
    try {
      await api.revokeToken(workspace.id, token.id);
      if (created?.id === token.id) setCreated(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the token.');
    }
  }

  if (!canConnect) {
    return (
      <div className="ptl-callout">
        <KeyRound size={18} />
        <div>
          <strong>You have view-only access</strong>
          <p>Ask a workspace owner or editor to connect an agent or import a site.</p>
        </div>
      </div>
    );
  }

  if (collapseWhenConnected && tokens === null) {
    return (
      <div className="ptl-home-connection-placeholder" aria-label="Loading agent connection">
        <span className="ptl-home-connection-placeholder-icon" />
        <span className="ptl-home-connection-placeholder-copy" />
      </div>
    );
  }

  const setupPanel = (
    <section className={`ptl-agent-setup${compact ? ' is-compact' : ''}`}>
      <div className="ptl-agent-setup-head">
        <div>
          <h2 className="ptl-dash-section-title">{title}</h2>
          <p className="ptl-dash-subtitle">{description}</p>
        </div>
        <ConnectionBadge status={tokens === null ? null : status} tokens={activeTokens} />
      </div>

      <div className="ptl-agent-client-picker" aria-label="Coding agent">
        {AGENT_CLIENTS.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`ptl-agent-client${client === option.value ? ' is-active' : ''}`}
            aria-pressed={client === option.value}
            onClick={() => chooseClient(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          const next = value as SetupMode;
          setMode(next);
          if (next === 'manual') {
            trackProductEvent({
              name: 'manual_setup_opened',
              source: 'dashboard',
              workspaceId: workspace.id,
              properties: { client },
            });
          }
        }}
        tabs={[
          { value: 'ask-agent', label: 'Ask my agent' },
          { value: 'manual', label: 'Manual setup' },
        ]}
      />

      <div className="ptl-setup-copy">
        <pre>{setupText}</pre>
        <CopyButton
          value={setupText}
          label={mode === 'ask-agent' ? 'Copy setup prompt' : 'Copy setup'}
          variant={mode === 'ask-agent' ? 'primary' : 'outline'}
        />
      </div>

      <div className="ptl-token-actions">
        <div>
          <strong>Write token</strong>
          <p>The token lets this agent read and edit the workspace. It is shown once.</p>
        </div>
        <Button variant="outline" onClick={createConnection} disabled={creating}>
          <KeyRound size={14} />
          {creating ? 'Creating…' : activeTokens.length ? 'Create another token' : 'Create token'}
        </Button>
      </div>

      {created && <TokenSecret token={created.token} onDone={() => setCreated(null)} />}

      {error && (
        <div className="ptl-inline-error" role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={reload}>
            <RefreshCw size={13} /> Retry
          </Button>
        </div>
      )}

      {activeTokens.length > 0 && (
        <details className="ptl-token-advanced">
          <summary>
            <span>Advanced token controls</span>
            <ChevronDown size={14} />
          </summary>
          <p className="ptl-token-help">
            Existing tokens cannot be shown again. Revoke one and create a replacement if it was
            lost.
          </p>
          <div className="ptl-token-list">
            {activeTokens.map((token) => (
              <div className="ptl-token-row" key={token.id}>
                <div>
                  <strong>{token.name}</strong>
                  <span>
                    {token.tokenPrefix}…,{` `}
                    {token.lastUsedAt ? `used ${relativeTime(token.lastUsedAt)}` : 'not used yet'}
                  </span>
                </div>
                <div className="ptl-token-row-actions">
                  <span className="ptl-badge ptl-badge--scope">
                    {token.scopes.includes('write') ? 'Can edit' : 'Read only'}
                  </span>
                  <RevokeButton onConfirm={() => revoke(token)} />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );

  if (collapseWhenConnected && status === 'connected') {
    return (
      <details className="ptl-home-connection-fold">
        <summary>
          <span className="ptl-home-connection-fold-icon">
            <PlugZap size={16} />
          </span>
          <span>
            <strong>Agent connection</strong>
            <small>Connected</small>
          </span>
          <ChevronDown size={15} />
        </summary>
        {setupPanel}
      </details>
    );
  }

  return setupPanel;
}

function RevokeButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      variant="danger"
      size="sm"
      onClick={() => {
        if (armed) onConfirm();
        setArmed((current) => !current);
      }}
    >
      {armed ? 'Confirm revoke' : 'Revoke'}
    </Button>
  );
}

function ConnectionBadge({
  status,
  tokens,
}: {
  status: ConnectionStatus | null;
  tokens: TokenSummary[];
}) {
  if (status === null) {
    return (
      <span className="ptl-connection-status is-loading" aria-label="Loading connection status" />
    );
  }
  if (status === 'connected') {
    const lastUsed = tokens
      .filter((token) => token.lastUsedAt)
      .sort((a, b) => Date.parse(b.lastUsedAt!) - Date.parse(a.lastUsedAt!))[0]?.lastUsedAt;
    return (
      <span className="ptl-connection-status is-connected">
        <CheckCircle2 size={14} />
        Connected{lastUsed ? `, ${relativeTime(lastUsed)}` : ''}
      </span>
    );
  }
  if (status === 'waiting') {
    return (
      <span className="ptl-connection-status is-waiting">
        <Clock3 size={14} />
        Waiting for first use
      </span>
    );
  }
  return (
    <span className="ptl-connection-status">
      <Circle size={13} />
      Not connected
    </span>
  );
}

function TokenSecret({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <div className="ptl-token-secret">
      <div className="ptl-token-secret-warning">
        <AlertTriangle size={15} />
        Copy this token now. Pitolet cannot show it again.
      </div>
      <code>{token}</code>
      <div className="ptl-token-secret-actions">
        <CopyButton value={token} label="Copy token" variant="primary" />
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
