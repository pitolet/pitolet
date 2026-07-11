import { nanoid } from 'nanoid';
import type { Pool } from 'pg';

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
    input.expiresInDays !== undefined && Number.isInteger(input.expiresInDays) && input.expiresInDays > 0
      ? input.expiresInDays
      : null;
  const res = await pool.query(
    `INSERT INTO share_links (token, doc_id, workspace_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE now() + make_interval(days => $5::int) END)
     RETURNING expires_at`,
    [token, input.docId, input.workspaceId, input.createdBy, days],
  );
  const expiresAt = res.rows[0]?.expires_at as Date | null;
  return {
    token,
    url: shareUrlPath(token),
    docId: input.docId,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };
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
