import type { Pool } from 'pg';
import type { MetricsSnapshot } from '../ops/metrics.js';

export type AnalyticsRange = 7 | 30 | 90;

export function analyticsRange(value: string | null): AnalyticsRange {
  return value === '7' || value === '90' ? (Number(value) as AnalyticsRange) : 30;
}

function number(value: unknown): number {
  return Number(value ?? 0);
}

export async function ownerOverview(
  pool: Pool,
  days: AnalyticsRange,
  health: MetricsSnapshot & { databaseResponseMs: number; release: string },
) {
  const summary = await pool.query(
    `WITH cutoff AS (SELECT now() - make_interval(days => $1::int) AS at),
     activity AS (
       SELECT pe.user_id, pe.workspace_id, pe.occurred_at
       FROM product_events pe, cutoff WHERE pe.occurred_at >= cutoff.at
       UNION ALL
       SELECT COALESCE(
                at.created_by,
                CASE WHEN dr.actor_id NOT LIKE 'token:%' THEN dr.actor_id END
              ), d.workspace_id, dr.created_at
       FROM doc_revisions dr
       JOIN documents d ON d.id = dr.doc_id
       LEFT JOIN agent_tokens at
         ON dr.actor_id LIKE 'token:%'
        AND at.id::text = substring(dr.actor_id from 7)
       CROSS JOIN cutoff
       WHERE dr.created_at >= cutoff.at
     ),
     activated AS (
       SELECT DISTINCT at.workspace_id
       FROM agent_tokens at
       WHERE at.last_used_at IS NOT NULL AND 'write' = ANY(at.scopes)
         AND (
           EXISTS (
             SELECT 1 FROM product_events pe
             WHERE pe.workspace_id = at.workspace_id AND pe.name = 'document_imported'
           ) OR EXISTS (
             SELECT 1 FROM doc_revisions dr
             JOIN documents d ON d.id = dr.doc_id
             WHERE d.workspace_id = at.workspace_id AND dr.actor_id LIKE 'token:%'
           )
         )
     )
     SELECT
       (SELECT count(*) FROM "user") AS total_accounts,
       (SELECT count(*) FROM "user", cutoff WHERE "createdAt" >= cutoff.at) AS new_accounts,
       (SELECT count(DISTINCT user_id) FROM activity WHERE user_id IS NOT NULL) AS active_users,
       (SELECT count(DISTINCT workspace_id) FROM activity WHERE workspace_id IS NOT NULL) AS active_workspaces,
       (SELECT count(DISTINCT workspace_id) FROM agent_tokens WHERE last_used_at IS NOT NULL AND 'write' = ANY(scopes)) AS connected_workspaces,
       (SELECT count(*) FROM activated) AS activated_workspaces,
       (SELECT count(*) FROM product_events, cutoff WHERE name = 'document_imported' AND occurred_at >= cutoff.at) AS imports,
       (SELECT count(*) FROM feedback_items, cutoff WHERE created_at >= cutoff.at) AS new_feedback,
       (SELECT count(*) FROM problem_groups WHERE status = 'open') AS open_problems,
       (SELECT count(*) FROM (
          SELECT user_id FROM activity WHERE user_id IS NOT NULL
          GROUP BY user_id HAVING count(DISTINCT occurred_at::date) >= 2
        ) returning_activity) AS returning_users`,
    [days],
  );
  const row = summary.rows[0] ?? {};

  const funnel = await pool.query(
    `WITH cohort AS (
       SELECT id FROM "user"
       WHERE "createdAt" >= now() - make_interval(days => $1::int)
     ), owned AS (
       SELECT DISTINCT m.user_id, m.workspace_id
       FROM memberships m JOIN cohort c ON c.id = m.user_id
       WHERE m.role = 'owner'
     ), tokens AS (
       SELECT DISTINCT at.created_by AS user_id, at.workspace_id, at.last_used_at
       FROM agent_tokens at JOIN cohort c ON c.id = at.created_by
       WHERE at.revoked_at IS NULL AND 'write' = ANY(at.scopes)
     ), activated AS (
       SELECT DISTINCT t.user_id
       FROM tokens t
       WHERE t.last_used_at IS NOT NULL AND (
         EXISTS (SELECT 1 FROM product_events pe WHERE pe.workspace_id = t.workspace_id AND pe.name = 'document_imported')
         OR EXISTS (
           SELECT 1 FROM doc_revisions dr JOIN documents d ON d.id = dr.doc_id
           WHERE d.workspace_id = t.workspace_id AND dr.actor_id LIKE 'token:%'
         )
       )
     )
     SELECT
       (SELECT count(*) FROM cohort) AS accounts,
       (SELECT count(DISTINCT user_id) FROM owned) AS workspaces,
       (SELECT count(DISTINCT user_id) FROM tokens) AS tokens,
       (SELECT count(DISTINCT user_id) FROM tokens WHERE last_used_at IS NOT NULL) AS connected,
       (SELECT count(*) FROM activated) AS activated`,
    [days],
  );
  const funnelRow = funnel.rows[0] ?? {};

  const trends = await pool.query(
    `WITH days AS (
       SELECT generate_series(
         current_date - ($1::int - 1), current_date, interval '1 day'
       )::date AS day
     ), activity AS (
       SELECT pe.user_id, pe.workspace_id, pe.occurred_at::date AS day
       FROM product_events pe
       WHERE pe.occurred_at >= current_date - ($1::int - 1)
       UNION ALL
       SELECT COALESCE(
                at.created_by,
                CASE WHEN dr.actor_id NOT LIKE 'token:%' THEN dr.actor_id END
              ), d.workspace_id, dr.created_at::date
       FROM doc_revisions dr
       JOIN documents d ON d.id = dr.doc_id
       LEFT JOIN agent_tokens at
         ON dr.actor_id LIKE 'token:%'
        AND at.id::text = substring(dr.actor_id from 7)
       WHERE dr.created_at >= current_date - ($1::int - 1)
     )
     SELECT days.day,
            count(DISTINCT activity.user_id) AS users,
            count(DISTINCT activity.workspace_id) AS workspaces
     FROM days LEFT JOIN activity ON activity.day = days.day
     GROUP BY days.day ORDER BY days.day`,
    [days],
  );

  return {
    rangeDays: days,
    summary: {
      totalAccounts: number(row.total_accounts),
      newAccounts: number(row.new_accounts),
      activeUsers: number(row.active_users),
      activeWorkspaces: number(row.active_workspaces),
      connectedWorkspaces: number(row.connected_workspaces),
      activatedWorkspaces: number(row.activated_workspaces),
      imports: number(row.imports),
      returningUsers: number(row.returning_users),
      newFeedback: number(row.new_feedback),
      openProblems: number(row.open_problems),
    },
    funnel: [
      { key: 'accounts', label: 'Accounts', count: number(funnelRow.accounts) },
      { key: 'workspaces', label: 'Created a workspace', count: number(funnelRow.workspaces) },
      { key: 'tokens', label: 'Created a write token', count: number(funnelRow.tokens) },
      { key: 'connected', label: 'Used MCP', count: number(funnelRow.connected) },
      { key: 'activated', label: 'Activated', count: number(funnelRow.activated) },
    ],
    trends: trends.rows.map((trend) => ({
      date: new Date(trend.day as string).toISOString().slice(0, 10),
      users: number(trend.users),
      workspaces: number(trend.workspaces),
    })),
    health,
  };
}

export async function listOwnerUsers(pool: Pool, query: string | null) {
  const search = query?.trim().slice(0, 100) ?? '';
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u."createdAt" AS created_at,
            (SELECT count(*)::int FROM memberships m WHERE m.user_id = u.id) AS workspace_count,
            (SELECT count(DISTINCT d.id)::int
             FROM memberships m JOIN documents d ON d.workspace_id = m.workspace_id
             WHERE m.user_id = u.id AND d.deleted_at IS NULL) AS document_count,
            (SELECT count(*)::int FROM agent_tokens at
             WHERE at.created_by = u.id AND at.revoked_at IS NULL
               AND at.last_used_at IS NOT NULL AND 'write' = ANY(at.scopes)) AS connected_agents,
            (SELECT count(*)::int FROM feedback_items f WHERE f.user_id = u.id) AS feedback_count,
            (SELECT count(*)::int FROM problem_groups pg
             WHERE pg.last_user_id = u.id AND pg.status = 'open') AS open_problems,
            GREATEST(
              COALESCE((SELECT max(pe.occurred_at) FROM product_events pe WHERE pe.user_id = u.id), u."createdAt"),
              COALESCE((SELECT max(dr.created_at) FROM doc_revisions dr WHERE dr.actor_id = u.id), u."createdAt"),
              COALESCE((SELECT max(at.last_used_at) FROM agent_tokens at WHERE at.created_by = u.id), u."createdAt"),
              u."createdAt"
            ) AS last_active_at,
            (SELECT string_agg(DISTINCT w.plan, ',')
             FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = u.id) AS plans
     FROM "user" u
     WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%')
     ORDER BY last_active_at DESC
     LIMIT 200`,
    [search],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    lastActiveAt: new Date(row.last_active_at as string).toISOString(),
    workspaceCount: number(row.workspace_count),
    documentCount: number(row.document_count),
    connectedAgentCount: number(row.connected_agents),
    feedbackCount: number(row.feedback_count),
    openProblemCount: number(row.open_problems),
    plans: typeof row.plans === 'string' ? row.plans.split(',').filter(Boolean) : [],
  }));
}

export async function ownerUserDetail(pool: Pool, userId: string) {
  const userResult = await pool.query(
    `SELECT id, name, email, "createdAt" AS created_at FROM "user" WHERE id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return null;
  const workspaces = await pool.query(
    `SELECT w.id, w.name, w.slug, w.plan, m.role,
            count(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL)::int AS document_count,
            max(at.last_used_at) AS last_agent_use
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     LEFT JOIN documents d ON d.workspace_id = w.id
     LEFT JOIN agent_tokens at ON at.workspace_id = w.id AND at.revoked_at IS NULL
     WHERE m.user_id = $1
     GROUP BY w.id, w.name, w.slug, w.plan, m.role
     ORDER BY w.created_at ASC`,
    [userId],
  );
  const timeline = await pool.query(
    `SELECT name, source, workspace_id, document_id, properties, occurred_at
     FROM product_events WHERE user_id = $1
     ORDER BY occurred_at DESC LIMIT 100`,
    [userId],
  );
  return {
    user: {
      id: user.id as string,
      name: user.name as string,
      email: user.email as string,
      createdAt: new Date(user.created_at as string).toISOString(),
    },
    workspaces: workspaces.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      plan: row.plan as string,
      role: row.role as string,
      documentCount: number(row.document_count),
      lastAgentUse: row.last_agent_use
        ? new Date(row.last_agent_use as string).toISOString()
        : null,
    })),
    timeline: timeline.rows.map((row) => ({
      name: row.name as string,
      source: row.source as string,
      workspaceId: (row.workspace_id as string | null) ?? null,
      documentId: (row.document_id as string | null) ?? null,
      properties: (row.properties as Record<string, unknown>) ?? {},
      occurredAt: new Date(row.occurred_at as string).toISOString(),
    })),
  };
}

export async function listProblems(
  pool: Pool,
  input: { status?: string | null; source?: string | null; query?: string | null },
) {
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (input.status && ['open', 'resolved', 'ignored'].includes(input.status)) {
    values.push(input.status);
    conditions.push(`pg.status = $${values.length}`);
  }
  if (
    input.source &&
    ['dashboard', 'editor', 'server', 'runtime', 'storage'].includes(input.source)
  ) {
    values.push(input.source);
    conditions.push(`pg.source = $${values.length}`);
  }
  if (input.query?.trim()) {
    values.push(`%${input.query.trim().slice(0, 100)}%`);
    conditions.push(
      `(pg.title ILIKE $${values.length} OR u.email ILIKE $${values.length} OR w.name ILIKE $${values.length})`,
    );
  }
  const result = await pool.query(
    `SELECT pg.*, u.name AS user_name, u.email AS user_email,
            w.name AS workspace_name, w.slug AS workspace_slug
     FROM problem_groups pg
     LEFT JOIN "user" u ON u.id = pg.last_user_id
     LEFT JOIN workspaces w ON w.id = pg.last_workspace_id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY CASE pg.status WHEN 'open' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END,
              pg.last_seen_at DESC
     LIMIT 200`,
    values,
  );
  return result.rows.map((row) => ({
    fingerprint: row.fingerprint as string,
    source: row.source as string,
    severity: row.severity as string,
    title: row.title as string,
    stack: (row.stack as string | null) ?? null,
    count: number(row.occurrence_count),
    status: row.status as string,
    firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
    lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
    release: (row.release as string | null) ?? null,
    route: (row.route as string | null) ?? null,
    user: row.last_user_id
      ? {
          id: row.last_user_id as string,
          name: (row.user_name as string | null) ?? '',
          email: (row.user_email as string | null) ?? '',
        }
      : null,
    workspace: row.last_workspace_id
      ? {
          id: row.last_workspace_id as string,
          name: (row.workspace_name as string | null) ?? '',
          slug: (row.workspace_slug as string | null) ?? '',
        }
      : null,
    documentId: (row.last_document_id as string | null) ?? null,
    context: (row.context as Record<string, unknown>) ?? {},
  }));
}

export async function updateProblemStatus(
  pool: Pool,
  fingerprint: string,
  status: string,
): Promise<boolean> {
  if (!['open', 'resolved', 'ignored'].includes(status)) throw new Error('invalid status');
  const result = await pool.query(
    `UPDATE problem_groups
     SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END
     WHERE fingerprint = $1`,
    [fingerprint, status],
  );
  return (result.rowCount ?? 0) > 0;
}
