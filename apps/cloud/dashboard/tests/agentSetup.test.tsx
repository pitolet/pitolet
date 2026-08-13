import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  connectionPrompt,
  deriveConnectionStatus,
  documentUrl,
  manualSetup,
  preferredClient,
  taskPrompt,
  validateImportUrl,
  workspaceHomePriority,
  type AgentClient,
} from '../src/agentSetup.js';
import type { TokenSummary, WorkspaceSummary } from '../src/api.js';
import { AgentSetup } from '../src/components/AgentSetup.js';

const workspace: WorkspaceSummary = {
  id: 'workspace-1',
  name: 'Product',
  slug: 'product',
  plan: 'free',
  role: 'owner',
};

function token(input: Partial<TokenSummary> = {}): TokenSummary {
  return {
    id: 'token-1',
    name: 'Codex',
    tokenPrefix: 'ptl_test',
    scopes: ['read', 'write'],
    createdAt: '2026-07-28T10:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...input,
  };
}

describe('agent setup utilities', () => {
  it('derives connection status from active write tokens', () => {
    expect(deriveConnectionStatus([])).toBe('not-connected');
    expect(deriveConnectionStatus([token({ scopes: ['read'] })])).toBe('not-connected');
    expect(deriveConnectionStatus([token()])).toBe('waiting');
    expect(deriveConnectionStatus([token({ lastUsedAt: '2026-07-28T11:00:00.000Z' })])).toBe(
      'connected',
    );
    expect(deriveConnectionStatus([token({ revokedAt: '2026-07-28T11:00:00.000Z' })])).toBe(
      'not-connected',
    );
  });

  it('builds task prompts without putting a token in them', () => {
    const secret = 'ptl_raw_secret_that_must_not_leak';
    const prompt = taskPrompt({
      client: 'codex',
      intent: 'scratch',
      connected: false,
      endpoint: 'https://app.pitolet.com/w/product/mcp',
      destination: 'https://app.pitolet.com/w/product',
      brief: 'A settings page',
    });
    expect(prompt).toContain('A settings page');
    expect(prompt).toContain('Ask me for the token');
    expect(prompt).toContain('MCP get_screenshot');
    expect(prompt).not.toContain(secret);
    expect(connectionPrompt('cursor', 'https://example.test/mcp')).not.toContain(secret);
  });

  it.each<AgentClient>(['codex', 'claude-code', 'cursor', 'other'])(
    'generates manual setup for %s without credentials',
    (client) => {
      const setup = manualSetup(client, 'https://example.test/mcp');
      expect(setup).toContain('https://example.test/mcp');
      expect(setup).not.toContain('ptl_');
      expect(setup).toMatch(/PITOLET_TOKEN|Bearer \$PITOLET_TOKEN/);
    },
  );

  it('tells importing agents to report editability and inspect through MCP', () => {
    const prompt = taskPrompt({
      client: 'codex',
      intent: 'import',
      connected: true,
      endpoint: 'https://app.pitolet.com/w/product/mcp',
      destination: 'https://app.pitolet.com/w/product',
      sourceUrl: 'http://localhost:3000',
    });
    expect(prompt).toContain('npx pitolet import');
    expect(prompt).toContain('editability result');
    expect(prompt).toContain('MCP get_screenshot');
  });

  it.each<AgentClient>(['codex', 'claude-code', 'cursor', 'other'])(
    'names MCP in the %s connection prompt',
    (client) => {
      expect(connectionPrompt(client, 'https://example.test/mcp')).toContain('MCP');
    },
  );

  it('validates source URLs', () => {
    expect(validateImportUrl('http://localhost:3000')).toBeNull();
    expect(validateImportUrl('https://example.com/page')).toBeNull();
    expect(validateImportUrl('file:///tmp/page.html')).toBe('Use an http or https address.');
    expect(validateImportUrl('example.com')).toContain('complete address');
  });

  it('only accepts a known locally stored client', () => {
    expect(preferredClient({ getItem: () => 'cursor' })).toBe('cursor');
    expect(preferredClient({ getItem: () => 'unknown' })).toBe('codex');
  });

  it('builds the correct editor deep link', () => {
    expect(documentUrl('https://app.pitolet.com', workspace, 'doc / 1')).toBe(
      'https://app.pitolet.com/w/product/?document=doc%20%2F%201',
    );
  });

  it('prioritizes the right workspace home section', () => {
    expect(
      workspaceHomePriority({
        canEdit: true,
        connection: 'not-connected',
        documentCount: 4,
      }),
    ).toBe('connection');
    expect(workspaceHomePriority({ canEdit: true, connection: 'waiting', documentCount: 4 })).toBe(
      'connection',
    );
    expect(
      workspaceHomePriority({ canEdit: true, connection: 'connected', documentCount: 4 }),
    ).toBe('documents');
    expect(
      workspaceHomePriority({ canEdit: true, connection: 'connected', documentCount: 0 }),
    ).toBe('actions');
    expect(
      workspaceHomePriority({ canEdit: false, connection: 'not-connected', documentCount: 4 }),
    ).toBe('documents');
  });
});

describe('AgentSetup', () => {
  it('shows viewers a specific read-only message without token controls', () => {
    const html = renderToStaticMarkup(<AgentSetup workspace={{ ...workspace, role: 'viewer' }} />);
    expect(html).toContain('You have view-only access');
    expect(html).not.toContain('Create token');
  });

  it('uses a quiet placeholder while the connection state loads', () => {
    const html = renderToStaticMarkup(<AgentSetup workspace={workspace} collapseWhenConnected />);
    expect(html).toContain('Loading agent connection');
    expect(html).not.toContain('Checking your agent connection');
  });
});
