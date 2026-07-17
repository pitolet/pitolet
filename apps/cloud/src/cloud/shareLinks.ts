import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import { planOf, PlanLimitError, shareLinkLimitDenial } from './plans.js';

/**
 * Public share links (`pshare_<nanoid 24>`) — SECURITY-CRITICAL. One
 * unguessable token grants READ-ONLY access to exactly ONE document; the
 * token is the entire credential, so:
 *
 *   - verify() only resolves links that are not revoked, not expired, AND
 *     whose document is still live in the owning workspace (a deleted doc
 *     kills its links immediately).
 *   - Malformed, unknown, revoked, and expired tokens are indistinguishable
 *     to the caller (all → null); the router turns every failure into the
 *     same byte-identical 401 (API) or 404 page (/s/:token).
 *   - The docId/workspaceId pair returned here feeds the {kind:'share'}
 *     AuthContext; scope enforcement (read-only, single doc) happens in the
 *     router + the workspace authorize hook, both of which pin to docId.
 *
 * The raw token IS the primary key (schema 001) — unlike agent tokens it is
 * a URL the owner must be able to re-copy from the management UI, so it is
 * stored and listed verbatim. It carries no write capability by design.
 */

export interface VerifiedShareLink {
  docId: string;
  workspaceId: string;
}

export interface ShareLinkSummary {
  token: string;
  /** Public path for the link (relative — the caller owns the origin). */
  url: string;
  docId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** nanoid default alphabet, fixed length — reject anything else before SQL. */
const SHARE_TOKEN_PATTERN = /^pshare_[A-Za-z0-9_-]{24}$/;
const SHARE_SESSION_PATTERN = /^psess_[A-Za-z0-9_-]{32}$/;
const SHARE_SESSION_TTL_HOURS = 12;

function hashSession(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function shareUrlPath(token: string): string {
  return `/s/${token}`;
}

/**
 * Mint a share link for a document. The caller (router) is responsible for
 * the workspace-ownership guard on docId and the per-doc plan gate — this
 * function only creates the row.
 */
export async function createShareLink(
  pool: Pool,
  input: {
    docId: string;
    workspaceId: string;
    createdBy: string;
    expiresInDays?: number;
  },
): Promise<{ token: string; url: string; docId: string; expiresAt: string | null }> {
  const token = `pshare_${nanoid(24)}`;
  const days =
    input.expiresInDays !== undefined &&
    Number.isInteger(input.expiresInDays) &&
    input.expiresInDays > 0
      ? input.expiresInDays
      : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the workspace row so concurrent link creation and plan changes
    // serialize around the same quota snapshot.
    const workspace = await client.query('SELECT plan FROM workspaces WHERE id = $1 FOR UPDATE', [
      input.workspaceId,
    ]);
    const owned = await client.query(
      `SELECT 1 FROM documents
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [input.docId, input.workspaceId],
    );
    if (owned.rowCount === 0) {
      throw new Error('document not found in workspace');
    }
    const count = await client.query(
      `SELECT count(*)::int AS n FROM share_links
       WHERE workspace_id = $1 AND doc_id = $2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [input.workspaceId, input.docId],
    );
    const denial = shareLinkLimitDenial(
      planOf(workspace.rows[0]?.plan),
      Number(count.rows[0]?.n ?? 0),
    );
    if (denial) throw new PlanLimitError(denial);
    const res = await client.query(
      `INSERT INTO share_links (token, doc_id, workspace_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $5::int IS NULL THEN NULL
                    ELSE now() + make_interval(days => $5::int) END)
       RETURNING expires_at`,
      [token, input.docId, input.workspaceId, input.createdBy, days],
    );
    await client.query('COMMIT');
    const expiresAt = res.rows[0]?.expires_at as Date | null;
    return {
      token,
      url: shareUrlPath(token),
      docId: input.docId,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve a raw share token to its single-document grant; null for
 * malformed, unknown, revoked, expired, or dead-document tokens — all
 * indistinguishable to the caller.
 */
export async function verifyShareLink(
  pool: Pool,
  rawToken: string,
): Promise<VerifiedShareLink | null> {
  if (!SHARE_TOKEN_PATTERN.test(rawToken)) return null;
  const res = await pool.query(
    `SELECT s.doc_id, s.workspace_id
     FROM share_links s
     JOIN documents d ON d.id = s.doc_id AND d.workspace_id = s.workspace_id
       AND d.deleted_at IS NULL
     WHERE s.token = $1
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())`,
    [rawToken],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { docId: row.doc_id as string, workspaceId: row.workspace_id as string };
}

/**
 * Exchange a URL credential for a short-lived browser session. Only the
 * sha256 digest is stored; the raw value is returned once for an HttpOnly
 * cookie and never appears in a redirect URL.
 */
export async function createShareSession(
  pool: Pool,
  rawShareToken: string,
): Promise<(VerifiedShareLink & { sessionToken: string; expiresAt: string }) | null> {
  if (!SHARE_TOKEN_PATTERN.test(rawShareToken)) return null;
  // Sessions are intentionally short-lived; opportunistic indexed cleanup
  // keeps the table bounded without needing a separate cron process.
  await pool.query('DELETE FROM share_sessions WHERE expires_at <= now()');
  const sessionToken = `psess_${nanoid(32)}`;
  const res = await pool.query(
    `INSERT INTO share_sessions
       (token_hash, share_token, doc_id, workspace_id, expires_at)
     SELECT $2, s.token, s.doc_id, s.workspace_id,
            LEAST(
              COALESCE(s.expires_at, now() + make_interval(hours => $3)),
              now() + make_interval(hours => $3)
            )
     FROM share_links s
     JOIN documents d ON d.id = s.doc_id AND d.workspace_id = s.workspace_id
       AND d.deleted_at IS NULL
     WHERE s.token = $1
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
     RETURNING doc_id, workspace_id, expires_at`,
    [rawShareToken, hashSession(sessionToken), SHARE_SESSION_TTL_HOURS],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    sessionToken,
    docId: row.doc_id as string,
    workspaceId: row.workspace_id as string,
    expiresAt: new Date(row.expires_at as string).toISOString(),
  };
}

/** Verify an HttpOnly browser share session against the still-active link. */
export async function verifyShareSession(
  pool: Pool,
  rawSessionToken: string,
): Promise<VerifiedShareLink | null> {
  if (!SHARE_SESSION_PATTERN.test(rawSessionToken)) return null;
  const res = await pool.query(
    `SELECT ss.doc_id, ss.workspace_id, ss.id
     FROM share_sessions ss
     JOIN share_links s ON s.token = ss.share_token
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
     JOIN documents d ON d.id = ss.doc_id AND d.workspace_id = ss.workspace_id
       AND d.deleted_at IS NULL
     WHERE ss.token_hash = $1
       AND ss.expires_at > now()`,
    [hashSession(rawSessionToken)],
  );
  const row = res.rows[0];
  if (!row) return null;
  void pool
    .query(
      `UPDATE share_sessions SET last_used_at = now()
     WHERE id = $1
       AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
      [row.id],
    )
    .catch(() => {});
  return { docId: row.doc_id as string, workspaceId: row.workspace_id as string };
}

/** Revoke (idempotent). Scoped to the workspace so tokens can't cross tenants. */
export async function revokeShareLink(
  pool: Pool,
  workspaceId: string,
  token: string,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE share_links SET revoked_at = now()
     WHERE token = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [token, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** List a document's share links (workspace-scoped — foreign docIds list nothing). */
export async function listShareLinks(
  pool: Pool,
  workspaceId: string,
  docId: string,
): Promise<ShareLinkSummary[]> {
  const res = await pool.query(
    `SELECT token, doc_id, created_by, created_at, expires_at, revoked_at
     FROM share_links
     WHERE workspace_id = $1 AND doc_id = $2
     ORDER BY created_at DESC`,
    [workspaceId, docId],
  );
  return res.rows.map((row) => ({
    token: row.token as string,
    url: shareUrlPath(row.token as string),
    docId: row.doc_id as string,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
  }));
}

/** Count of currently ACTIVE (mintable-against) links for a doc — the plan-gate input. */
export async function countActiveShareLinks(
  pool: Pool,
  workspaceId: string,
  docId: string,
): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM share_links
     WHERE workspace_id = $1 AND doc_id = $2
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [workspaceId, docId],
  );
  return (res.rows[0]?.n as number) ?? 0;
}
