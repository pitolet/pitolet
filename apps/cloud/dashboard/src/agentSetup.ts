import type { TokenSummary, WorkspaceSummary } from './api.js';

export type AgentClient = 'codex' | 'claude-code' | 'cursor' | 'other';
export type AgentIntent = 'scratch' | 'import';
export type SetupMode = 'ask-agent' | 'manual';
export type ConnectionStatus = 'not-connected' | 'waiting' | 'connected';
export type WorkspaceHomePriority = 'connection' | 'documents' | 'actions';

export const AGENT_CLIENTS: Array<{ value: AgentClient; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'other', label: 'Other' },
];

export function workspaceUrl(origin: string, workspace: Pick<WorkspaceSummary, 'slug'>): string {
  return `${origin}/w/${workspace.slug}`;
}

export function mcpUrl(origin: string, workspace: Pick<WorkspaceSummary, 'slug'>): string {
  return `${workspaceUrl(origin, workspace)}/mcp`;
}

export function documentUrl(
  origin: string,
  workspace: Pick<WorkspaceSummary, 'slug'>,
  docId: string,
): string {
  return `${workspaceUrl(origin, workspace)}/?document=${encodeURIComponent(docId)}`;
}

export function deriveConnectionStatus(tokens: TokenSummary[]): ConnectionStatus {
  const writable = tokens.filter((token) => !token.revokedAt && token.scopes.includes('write'));
  if (writable.some((token) => token.lastUsedAt)) return 'connected';
  if (writable.length > 0) return 'waiting';
  return 'not-connected';
}

export function workspaceHomePriority(input: {
  canEdit: boolean;
  connection: ConnectionStatus | null;
  documentCount: number | null;
}): WorkspaceHomePriority {
  if (!input.canEdit) return 'documents';
  if (input.connection !== 'connected') return 'connection';
  return input.documentCount && input.documentCount > 0 ? 'documents' : 'actions';
}

export function connectionPrompt(client: AgentClient, endpoint: string): string {
  const clientName = AGENT_CLIENTS.find((candidate) => candidate.value === client)?.label;
  const opening =
    client === 'other'
      ? 'Connect this project to my Pitolet workspace using MCP.'
      : `Connect this project to my Pitolet workspace using MCP in ${clientName}.`;
  return `${opening}

Endpoint: ${endpoint}

Use a write token as the bearer token. Ask me for the token when you need it. Keep it out of the repository. Verify the connection by listing the Pitolet documents.`;
}

export function scratchPrompt(brief: string): string {
  return `Use Pitolet for this page: ${brief.trim()}

Create a new Pitolet document with a clear name and build the page there. Keep it responsive. I want to edit it in Pitolet while you work. After substantial visual changes, use the Pitolet MCP get_screenshot tool to inspect the result and refine it.`;
}

export function importPrompt(sourceUrl: string, destination: string): string {
  return `Import ${sourceUrl.trim()} into this Pitolet workspace: ${destination}

Use npx pitolet import and the PITOLET_TOKEN environment variable. Ask me for the token if it is not already set. When the import finishes, give me the document link, the editability result, and any compatibility issues. Then use the Pitolet MCP get_screenshot tool to inspect the imported document.`;
}

export function taskPrompt(input: {
  client: AgentClient;
  intent: AgentIntent;
  connected: boolean;
  endpoint: string;
  destination: string;
  brief?: string;
  sourceUrl?: string;
}): string {
  const task =
    input.intent === 'scratch'
      ? scratchPrompt(input.brief ?? '')
      : importPrompt(input.sourceUrl ?? '', input.destination);
  return input.connected ? task : `${connectionPrompt(input.client, input.endpoint)}\n\n${task}`;
}

export function manualSetup(client: AgentClient, endpoint: string): string {
  if (client === 'codex') {
    return `codex mcp add pitolet --url ${endpoint} --bearer-token-env-var PITOLET_TOKEN`;
  }
  if (client === 'claude-code') {
    return `claude mcp add --transport http pitolet ${endpoint} --header 'Authorization: Bearer \${PITOLET_TOKEN}'`;
  }
  if (client === 'cursor') {
    return JSON.stringify(
      {
        mcpServers: {
          pitolet: {
            url: endpoint,
            headers: {
              Authorization: 'Bearer ${env:PITOLET_TOKEN}',
            },
          },
        },
      },
      null,
      2,
    );
  }
  return `MCP endpoint: ${endpoint}
Authorization header: Bearer $PITOLET_TOKEN
Transport: Streamable HTTP`;
}

export function validateImportUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter the address of the site.';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Use an http or https address.';
    }
    return null;
  } catch {
    return 'Enter a complete address, such as http://localhost:3000.';
  }
}

export function preferredClient(storage: Pick<Storage, 'getItem'> | undefined): AgentClient {
  const value = storage?.getItem('pitolet.agent-client');
  return AGENT_CLIENTS.some((client) => client.value === value) ? (value as AgentClient) : 'codex';
}
