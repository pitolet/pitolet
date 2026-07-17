import { createSampleDocument } from '@pitolet/schema';
import type { Pool, PoolClient } from 'pg';
import { memberLimitDenial, planOf, PlanLimitError, workspaceCreateDenial } from './plans.js';

/**
 * Workspace lifecycle + membership queries. All identity ids are better-auth
 * user ids (text — see migration 002).
 */

export type Role = 'owner' | 'editor' | 'viewer';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  plan: string;
}

export interface WorkspaceWithRole extends Workspace {
  role: Role;
}

/**
 * Slug shape: lowercase alphanumeric, single-dash separated, 2–40 chars,
 * no leading/trailing/double dash.
 */
export const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9]){1,38}$/;

/** Route/subdomain namespace collisions — never claimable as workspace slugs. */
export const RESERVED_SLUGS = new Set([
  'api',
  'auth',
  'www',
  'app',
  'admin',
  's',
  'w',
  'assets',
  'mcp',
  'ws',
  'docs',
  'billing',
]);

export class SlugError extends Error {}

async function insertStarterDocument(client: PoolClient, workspaceId: string): Promise<string> {
  const document = createSampleDocument();
  await client.query(
    `INSERT INTO documents (id, workspace_id, name, doc, rev)
     VALUES ($1, $2, $3, $4::jsonb, 0)`,
    [document.id, workspaceId, document.name, JSON.stringify(document)],
  );
  return document.id;
}

export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new SlugError(
      'invalid slug: 2-40 chars, lowercase letters/digits, single dashes between',
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new SlugError(`slug "${slug}" is reserved`);
  }
}

/**
 * Create a workspace, owner membership, and starter document atomically.
 * Throws SlugError for invalid/reserved slugs and (from pg) a unique
 * violation for taken ones.
 */
export async function createWorkspace(
  pool: Pool,
  input: { name: string; slug: string; ownerUserId: string },
): Promise<Workspace> {
  validateSlug(input.slug);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The quota belongs to the owner, not a workspace row that exists yet.
    // A per-user advisory transaction lock serializes concurrent creates.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `pitolet:workspace-owner:${input.ownerUserId}`,
    ]);
    const owned = await client.query(
      `SELECT w.plan FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 AND m.role = 'owner'`,
      [input.ownerUserId],
    );
    const denial = workspaceCreateDenial(owned.rows.map((row) => row.plan as string));
    if (denial) throw new PlanLimitError(denial);
    const ws = await client.query(
      'INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id, slug, name, plan',
      [input.slug, input.name],
    );
    const row = ws.rows[0] as Workspace;
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [row.id, input.ownerUserId],
    );
    await insertStarterDocument(client, row.id);
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type MemberMutationResult =
  | { status: 'updated'; userId: string; role: Role }
  | { status: 'user-not-found' }
  | { status: 'last-owner' };

/**
 * Add or change a member while holding the workspace row lock. This makes
 * the member quota and last-owner rule safe under concurrent requests.
 */
export async function upsertMember(
  pool: Pool,
  input: {
    workspaceId: string;
    email: string;
    role: Role;
    requireVerifiedEmail: boolean;
  },
): Promise<MemberMutationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workspace = await client.query('SELECT plan FROM workspaces WHERE id = $1 FOR UPDATE', [
      input.workspaceId,
    ]);
    const target = await client.query(
      `SELECT id FROM "user"
       WHERE lower(email) = lower($1)
         AND ($2::boolean = false OR "emailVerified" = true)`,
      [input.email, input.requireVerifiedEmail],
    );
    const userId = target.rows[0]?.id as string | undefined;
    if (!userId) {
      await client.query('ROLLBACK');
      return { status: 'user-not-found' };
    }
    const current = await client.query(
      'SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
      [input.workspaceId, userId],
    );
    const currentRole = current.rows[0]?.role as Role | undefined;
    if (currentRole === 'owner' && input.role !== 'owner') {
      const owners = await client.query(
        `SELECT count(*)::int AS n FROM memberships
         WHERE workspace_id = $1 AND role = 'owner'`,
        [input.workspaceId],
      );
      if (Number(owners.rows[0]?.n ?? 0) <= 1) {
        await client.query('ROLLBACK');
        return { status: 'last-owner' };
      }
    }
    if (!currentRole) {
      const members = await client.query(
        'SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1',
        [input.workspaceId],
      );
      const denial = memberLimitDenial(
        planOf(workspace.rows[0]?.plan),
        Number(members.rows[0]?.n ?? 0),
      );
      if (denial) throw new PlanLimitError(denial);
    }
    await client.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [input.workspaceId, userId, input.role],
    );
    await client.query('COMMIT');
    return { status: 'updated', userId, role: input.role };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type RemoveMemberResult =
  { status: 'removed'; userId: string } | { status: 'not-found' } | { status: 'last-owner' };

export async function removeMember(
  pool: Pool,
  workspaceId: string,
  userId: string,
): Promise<RemoveMemberResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
    const target = await client.query(
      'SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
      [workspaceId, userId],
    );
    const role = target.rows[0]?.role as Role | undefined;
    if (!role) {
      await client.query('ROLLBACK');
      return { status: 'not-found' };
    }
    if (role === 'owner') {
      const owners = await client.query(
        `SELECT count(*)::int AS n FROM memberships
         WHERE workspace_id = $1 AND role = 'owner'`,
        [workspaceId],
      );
      if (Number(owners.rows[0]?.n ?? 0) <= 1) {
        await client.query('ROLLBACK');
        return { status: 'last-owner' };
      }
    }
    await client.query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [
      workspaceId,
      userId,
    ]);
    await client.query('COMMIT');
    return { status: 'removed', userId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Repair workspaces created before starter documents were seeded. This is
 * intentionally idempotent and runs at boot after migrations. The advisory
 * lock serializes concurrent application starts so two replicas cannot seed
 * the same empty workspace at once.
 */
export async function ensureWorkspaceStarterDocuments(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pitolet:starter-documents'))");
    const empty = await client.query<{ id: string }>(
      `SELECT w.id
       FROM workspaces w
       WHERE NOT EXISTS (
         SELECT 1 FROM documents d
         WHERE d.workspace_id = w.id AND d.deleted_at IS NULL
       )
       ORDER BY w.created_at ASC`,
    );
    for (const workspace of empty.rows) {
      await insertStarterDocument(client, workspace.id);
    }
    await client.query('COMMIT');
    return empty.rowCount ?? empty.rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The user's role in a workspace, or null when not a member. */
export async function roleFor(
  pool: Pool,
  userId: string,
  workspaceId: string,
): Promise<Role | null> {
  const res = await pool.query(
    'SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  return (res.rows[0]?.role as Role | undefined) ?? null;
}

export async function listWorkspacesFor(pool: Pool, userId: string): Promise<WorkspaceWithRole[]> {
  const res = await pool.query(
    `SELECT w.id, w.slug, w.name, w.plan, m.role
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1
     ORDER BY w.created_at ASC`,
    [userId],
  );
  return res.rows as WorkspaceWithRole[];
}

export async function findWorkspaceBySlug(pool: Pool, slug: string): Promise<Workspace | null> {
  const res = await pool.query('SELECT id, slug, name, plan FROM workspaces WHERE slug = $1', [
    slug,
  ]);
  return (res.rows[0] as Workspace | undefined) ?? null;
}
