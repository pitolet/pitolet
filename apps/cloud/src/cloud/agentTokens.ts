import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Workspace-scoped agent tokens (`ptl_<40 hex>`). Only the sha256 of the raw
 * token is stored; the raw value is returned exactly once at creation.
 *
 * Verification is timing-safe by construction: the raw token is hashed
 * first, then looked up via the unique token_hash index — there is no
 * byte-by-byte comparison against stored secrets that could leak length or
 * prefix information.
 */

export type TokenScope = 'read' | 'write';

export interface VerifiedToken {
  workspaceId: string;
  tokenId: string;
  name: string;
  scopes: TokenScope[];
}

export interface AgentTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const RAW_TOKEN_PATTERN = /^ptl_[0-9a-f]{40}$/;

/** Milliseconds between last_used_at writes per token (verification stays cheap). */
const LAST_USED_THROTTLE_MS = 60_000;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a token. The returned `token` is shown to the caller ONCE and never
 * recoverable — the row stores sha256 + display prefix only.
 */
export async function createAgentToken(
  pool: Pool,
  input: {
    workspaceId: string;
    name: string;
    scopes?: TokenScope[];
    createdBy: string;
  },
): Promise<{ token: string; id: string; tokenPrefix: string; scopes: TokenScope[] }> {
  const scopes = input.scopes ?? ['read', 'write'];
  if (!scopes.includes('read') || scopes.some((s) => s !== 'read' && s !== 'write')) {
    throw new Error("scopes must be ['read'] or ['read','write']");
  }
  const token = `ptl_${randomBytes(20).toString('hex')}`;
  const tokenPrefix = token.slice(0, 12); // ptl_xxxxxxxx
  const res = await pool.query(
    `INSERT INTO agent_tokens (workspace_id, name, token_hash, token_prefix, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.workspaceId, input.name, hashToken(token), tokenPrefix, scopes, input.createdBy],
  );
  return { token, id: res.rows[0].id as string, tokenPrefix, scopes };
}

/**
 * Resolve a raw bearer token to its workspace grant; null for malformed,
 * unknown, or revoked tokens (indistinguishable to the caller).
 */
export async function verifyAgentToken(
  pool: Pool,
  rawToken: string,
): Promise<VerifiedToken | null> {
  if (!RAW_TOKEN_PATTERN.test(rawToken)) return null;
  const res = await pool.query(
    `SELECT id, workspace_id, name, scopes, last_used_at
     FROM agent_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(rawToken)],
  );
  const row = res.rows[0];
  if (!row) return null;

  // Throttled usage stamp: at most one UPDATE per token per minute, off the
  // request path (verification latency must not include a write).
  const lastUsed = row.last_used_at ? new Date(row.last_used_at as string).getTime() : 0;
  if (Date.now() - lastUsed >= LAST_USED_THROTTLE_MS) {
    pool
      .query(
        `UPDATE agent_tokens SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at <= now() - interval '60 seconds')`,
        [row.id],
      )
      .catch(() => {});
  }

  return {
    workspaceId: row.workspace_id as string,
    tokenId: row.id as string,
    name: row.name as string,
    scopes: row.scopes as TokenScope[],
  };
}

/** Revoke (idempotent). Scoped to the workspace so ids can't cross tenants. */
export async function revokeAgentToken(
  pool: Pool,
  workspaceId: string,
  tokenId: string,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE agent_tokens SET revoked_at = now()
     WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [tokenId, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** List a workspace's tokens — never returns hashes. */
export async function listAgentTokens(
  pool: Pool,
  workspaceId: string,
): Promise<AgentTokenSummary[]> {
  const res = await pool.query(
    `SELECT id, name, token_prefix, scopes, created_at, last_used_at, revoked_at
     FROM agent_tokens WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return res.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    tokenPrefix: row.token_prefix as string,
    scopes: row.scopes as TokenScope[],
    createdAt: new Date(row.created_at as string).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
  }));
}
