import type { Pool } from 'pg';

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
 * Create a workspace and its owner membership atomically. Throws SlugError
 * for invalid/reserved slugs and (from pg) a unique violation for taken ones.
 */
export async function createWorkspace(
  pool: Pool,
  input: { name: string; slug: string; ownerUserId: string },
): Promise<Workspace> {
  validateSlug(input.slug);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query(
      'INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id, slug, name, plan',
      [input.slug, input.name],
    );
    const row = ws.rows[0] as Workspace;
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [row.id, input.ownerUserId],
    );
    await client.query('COMMIT');
    return row;
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
