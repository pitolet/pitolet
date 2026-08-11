import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, ensureAuthSchema, type CloudAuth } from '../src/auth/auth.js';
import { recordProductEvent, runTelemetryRetention } from '../src/admin/telemetry.js';
import { runMigrations } from '../src/db/migrate.js';
import { createCloudServer, type CloudServer } from '../src/server.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

const PASSWORD = 'owner-console-test-password';
const ADMIN_EMAIL = 'owner@pitolet.test';

let pgi: EphemeralPg;
let cloud: CloudServer;
let auth: CloudAuth;
let dataRoot: string;
let base: string;
let adminCookie: string;
let memberCookie: string;
let workspace: { id: string; slug: string };
let docId: string;
let originalFetch: typeof fetch;
const originalEnv = {
  admins: process.env.PITOLET_ADMIN_EMAILS,
  notify: process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS,
  resend: process.env.RESEND_API_KEY,
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .join('; ');
}

function api(
  path: string,
  input: { method?: string; cookie?: string; body?: unknown; bearer?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (input.cookie) headers.cookie = input.cookie;
  if (input.bearer) headers.authorization = `Bearer ${input.bearer}`;
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: input.method ?? 'GET',
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    redirect: 'manual',
  });
}

function restoreEnvironment() {
  for (const [name, value] of [
    ['PITOLET_ADMIN_EMAILS', originalEnv.admins],
    ['PITOLET_FEEDBACK_NOTIFY_EMAILS', originalEnv.notify],
    ['RESEND_API_KEY', originalEnv.resend],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeAll(async () => {
  process.env.PITOLET_ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS = 'alerts@pitolet.test';
  process.env.RESEND_API_KEY = 'resend-test-key';
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://api.resend.com/emails') {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'email-test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-owner-console-'));
  pgi = await startEphemeralPg('pitolet_owner_console');
  await runMigrations(pgi.pool);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const authConfig = { pool: pgi.pool, baseURL: base, secret: 'owner-console-test-secret' };
  await ensureAuthSchema(authConfig);
  auth = createAuth(authConfig);
  cloud = createCloudServer({
    pool: pgi.pool,
    auth,
    dataRoot,
    editorDist: null,
    dashboardDist: null,
    billing: null,
  });
  await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));

  adminCookie = await signUp(ADMIN_EMAIL, 'Owner');
  memberCookie = await signUp('member@pitolet.test', 'Member');
  await pgi.pool.query('UPDATE "user" SET "emailVerified" = true WHERE lower(email) = lower($1)', [
    ADMIN_EMAIL,
  ]);
  const created = await api('/api/workspaces', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: 'Owner workspace', slug: 'owner-workspace' },
  });
  expect(created.status).toBe(201);
  workspace = ((await created.json()) as { workspace: { id: string; slug: string } }).workspace;
  const document = await pgi.pool.query<{ id: string }>(
    'SELECT id FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL',
    [workspace.id],
  );
  docId = document.rows[0]!.id;
  const member = await pgi.pool.query<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email) = lower($1)',
    ['member@pitolet.test'],
  );
  await pgi.pool.query(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`,
    [workspace.id, member.rows[0]!.id],
  );
}, 180_000);

afterAll(async () => {
  await cloud?.close();
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  restoreEnvironment();
});

describe('owner access', () => {
  it('exposes admin status through /api/me', async () => {
    const admin = await api('/api/me', { cookie: adminCookie });
    const member = await api('/api/me', { cookie: memberCookie });
    expect((await admin.json()) as { isPlatformAdmin: boolean }).toMatchObject({
      isPlatformAdmin: true,
    });
    expect((await member.json()) as { isPlatformAdmin: boolean }).toMatchObject({
      isPlatformAdmin: false,
    });

    process.env.PITOLET_ADMIN_EMAILS = `${ADMIN_EMAIL},unverified-admin@pitolet.test`;
    const unverifiedCookie = await signUp('unverified-admin@pitolet.test', 'Unverified admin');
    const unverified = await api('/api/me', { cookie: unverifiedCookie });
    expect((await unverified.json()) as { isPlatformAdmin: boolean }).toMatchObject({
      isPlatformAdmin: false,
    });
    process.env.PITOLET_ADMIN_EMAILS = ADMIN_EMAIL;
  });

  it('returns 401 to anonymous users and 404 to signed-in non-admins', async () => {
    expect((await api('/api/admin/overview')).status).toBe(401);
    expect((await api('/api/admin/overview', { cookie: memberCookie })).status).toBe(404);
    expect((await api('/api/admin/overview', { cookie: adminCookie })).status).toBe(200);
  });
});

describe('limited analytics', () => {
  it('records only allowlisted milestones and deduplicates repeated opens', async () => {
    const opened = {
      name: 'dashboard_opened',
      source: 'dashboard',
    };
    expect(
      (await api('/api/events', { method: 'POST', cookie: adminCookie, body: opened })).status,
    ).toBe(202);
    expect(
      (await api('/api/events', { method: 'POST', cookie: adminCookie, body: opened })).status,
    ).toBe(202);
    expect(
      (
        await api('/api/events', {
          method: 'POST',
          cookie: adminCookie,
          body: {
            name: 'prompt_copied',
            source: 'dashboard',
            workspaceId: workspace.id,
            properties: {
              intent: 'scratch',
              client: 'codex',
              includedConnection: true,
              prompt: 'private prompt text',
            },
          },
        })
      ).status,
    ).toBe(400);
    const rows = await pgi.pool.query<{ n: number; properties: Record<string, unknown> }>(
      `SELECT count(*)::int AS n, '{}'::jsonb AS properties
       FROM product_events WHERE name = 'dashboard_opened'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
    const serialized = await pgi.pool.query<{ body: string }>(
      `SELECT COALESCE(string_agg(properties::text, ''), '') AS body FROM product_events`,
    );
    expect(serialized.rows[0]!.body).not.toContain('private prompt text');
  });

  it('derives MCP connection and activation from token and revision data', async () => {
    const tokenResponse = await api(`/api/workspaces/${workspace.id}/tokens`, {
      method: 'POST',
      cookie: adminCookie,
      body: { name: 'Analytics agent', scopes: ['read', 'write'] },
    });
    expect(tokenResponse.status).toBe(201);
    const token = (await tokenResponse.json()) as { id: string };
    await pgi.pool.query('UPDATE agent_tokens SET last_used_at = now() WHERE id = $1', [token.id]);
    await pgi.pool.query(
      `INSERT INTO doc_revisions
         (doc_id, rev, origin, label, actor_id, actor_name, ops)
       VALUES ($1, 1, 'agent', 'agent edit', $2, 'Analytics agent', '[]'::jsonb)`,
      [docId, `token:${token.id}`],
    );
    const user = await pgi.pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE lower(email) = lower($1)',
      [ADMIN_EMAIL],
    );
    await recordProductEvent(pgi.pool, {
      name: 'document_imported',
      source: 'server',
      userId: user.rows[0]!.id,
      workspaceId: workspace.id,
      documentId: docId,
    });
    const overview = await api('/api/admin/overview?days=30', { cookie: adminCookie });
    expect(overview.status).toBe(200);
    const data = (await overview.json()) as {
      summary: { connectedWorkspaces: number; activatedWorkspaces: number; imports: number };
      funnel: Array<{ key: string; count: number }>;
    };
    expect(data.summary).toMatchObject({
      connectedWorkspaces: 1,
      activatedWorkspaces: 1,
      imports: 1,
    });
    expect(data.funnel.find((step) => step.key === 'activated')?.count).toBe(1);
  });
});

describe('feedback and support access', () => {
  it('accepts every category and keeps notification delivery outside the commit', async () => {
    for (const category of ['broken', 'confusing', 'feature', 'general']) {
      const response = await api('/api/feedback', {
        method: 'POST',
        cookie: adminCookie,
        body: { category, message: `Feedback for ${category}`, wantsReply: true },
      });
      expect(response.status).toBe(201);
    }
    const count = await pgi.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM feedback_items',
    );
    expect(count.rows[0]!.n).toBe(4);
  });

  it('keeps feedback when notification delivery is unavailable', async () => {
    delete process.env.RESEND_API_KEY;
    const response = await api('/api/feedback', {
      method: 'POST',
      cookie: adminCookie,
      body: { category: 'general', message: 'This must still be saved.' },
    });
    process.env.RESEND_API_KEY = 'resend-test-key';
    expect(response.status).toBe(201);
    const stored = await pgi.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feedback_items WHERE message = 'This must still be saved.'`,
    );
    expect(stored.rows[0]!.n).toBe(1);
  });

  it('does not let a viewer grant temporary support access', async () => {
    const response = await api('/api/feedback', {
      method: 'POST',
      cookie: memberCookie,
      body: {
        category: 'general',
        message: 'Please inspect this document.',
        workspaceId: workspace.id,
        documentId: docId,
        grantSupportAccess: true,
      },
    });
    expect(response.status).toBe(403);
  });

  it('creates an expiring support link without consuming the public quota', async () => {
    for (let index = 0; index < 2; index += 1) {
      const publicLink = await api(`/api/workspaces/${workspace.id}/share-links`, {
        method: 'POST',
        cookie: adminCookie,
        body: { docId },
      });
      expect(publicLink.status).toBe(201);
    }

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const response = await api('/api/feedback', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        category: 'broken',
        message: 'Support needs to inspect this. Bearer should-not-be-stored',
        workspaceId: workspace.id,
        documentId: docId,
        grantSupportAccess: true,
        includeDiagnostics: true,
        diagnostics: {
          clientErrors: ['ptl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa failed'],
        },
        screenshot: { mime: 'image/png', data: png },
      },
    });
    expect(response.status).toBe(201);
    const feedbackId = ((await response.json()) as { id: string }).id;

    const links = await pgi.pool.query<{
      purpose: string;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT purpose, expires_at, revoked_at FROM share_links
       WHERE workspace_id = $1 ORDER BY created_at ASC`,
      [workspace.id],
    );
    expect(links.rows.filter((link) => link.purpose === 'public')).toHaveLength(2);
    const support = links.rows.find((link) => link.purpose === 'support');
    expect(support).toBeDefined();
    expect(support!.expires_at!.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60_000);

    const stored = await pgi.pool.query<{
      message: string;
      diagnostics: Record<string, unknown>;
      screenshot_data: Buffer;
    }>(
      'SELECT message, diagnostics, screenshot_data FROM feedback_items ORDER BY created_at DESC LIMIT 1',
    );
    expect(stored.rows[0]!.message).not.toContain('should-not-be-stored');
    expect(JSON.stringify(stored.rows[0]!.diagnostics)).not.toContain('ptl_aaaaaaaa');
    expect(stored.rows[0]!.screenshot_data.length).toBeGreaterThan(0);

    const listed = await api(`/api/workspaces/${workspace.id}/share-links?docId=${docId}`, {
      cookie: adminCookie,
    });
    const summaries = (await listed.json()) as {
      shareLinks: Array<{ token: string; purpose: string }>;
    };
    const supportSummary = summaries.shareLinks.find((link) => link.purpose === 'support');
    expect(supportSummary).toBeDefined();
    const revoked = await api(`/api/workspaces/${workspace.id}/share-links`, {
      method: 'DELETE',
      cookie: adminCookie,
      body: { token: supportSummary!.token },
    });
    expect(revoked.status).toBe(200);
    const detail = await api(`/api/admin/feedback/${feedbackId}`, { cookie: adminCookie });
    expect(detail.status).toBe(200);
    expect((await detail.json()) as { feedback: { supportUrl: string | null } }).toMatchObject({
      feedback: { supportUrl: null },
    });
  });

  it('lets an admin review, update, and reply to feedback', async () => {
    const list = await api('/api/admin/feedback?status=new', { cookie: adminCookie });
    expect(list.status).toBe(200);
    const items = (await list.json()) as { feedback: Array<{ id: string }> };
    const id = items.feedback[0]!.id;
    expect((await api(`/api/admin/feedback/${id}`, { cookie: adminCookie })).status).toBe(200);
    expect(
      (
        await api(`/api/admin/feedback/${id}`, {
          method: 'PATCH',
          cookie: adminCookie,
          body: { status: 'reviewing' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(`/api/admin/feedback/${id}/replies`, {
          method: 'POST',
          cookie: adminCookie,
          body: { body: 'Thanks. I am looking into this.' },
        })
      ).status,
    ).toBe(201);
    const replies = await pgi.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM feedback_replies WHERE feedback_id = $1',
      [id],
    );
    expect(replies.rows[0]!.n).toBe(1);

    delete process.env.RESEND_API_KEY;
    const failedReply = await api(`/api/admin/feedback/${id}/replies`, {
      method: 'POST',
      cookie: adminCookie,
      body: { body: 'This send should fail.' },
    });
    process.env.RESEND_API_KEY = 'resend-test-key';
    expect(failedReply.status).toBe(500);
    const unchanged = await pgi.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM feedback_replies WHERE feedback_id = $1',
      [id],
    );
    expect(unchanged.rows[0]!.n).toBe(1);
  });
});

describe('problem grouping', () => {
  it('redacts credentials, groups repeats, and reopens resolved problems', async () => {
    const problem = {
      source: 'dashboard',
      title: 'TypeError: request failed with Bearer raw-credential',
      route: '/workspace/example?token=query-secret',
      context: { component: 'WorkspaceHome', requestBody: 'must not be accepted' },
    };
    expect(
      (await api('/api/problems/client', { method: 'POST', cookie: adminCookie, body: problem }))
        .status,
    ).toBe(202);
    const first = await pgi.pool.query<{ fingerprint: string; title: string; route: string }>(
      `SELECT fingerprint, title, route FROM problem_groups
       WHERE source = 'dashboard' ORDER BY last_seen_at DESC LIMIT 1`,
    );
    expect(first.rows[0]!.title).not.toContain('raw-credential');
    expect(first.rows[0]!.route).not.toContain('query-secret');

    expect(
      (
        await api(`/api/admin/problems/${first.rows[0]!.fingerprint}`, {
          method: 'PATCH',
          cookie: adminCookie,
          body: { status: 'resolved' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await api('/api/problems/client', { method: 'POST', cookie: adminCookie, body: problem }))
        .status,
    ).toBe(202);
    const reopened = await pgi.pool.query<{ status: string; occurrence_count: number }>(
      'SELECT status, occurrence_count FROM problem_groups WHERE fingerprint = $1',
      [first.rows[0]!.fingerprint],
    );
    expect(reopened.rows[0]).toMatchObject({ status: 'open', occurrence_count: 2 });
  });
});

describe('owner console ingestion limits', () => {
  it('rate limits feedback, product events, and client problems per account', async () => {
    const feedbackCookie = await signUp('feedback-limit@pitolet.test', 'Feedback limit');
    for (let index = 0; index < 10; index += 1) {
      expect(
        (
          await api('/api/feedback', {
            method: 'POST',
            cookie: feedbackCookie,
            body: { category: 'general', message: `Feedback ${index}` },
          })
        ).status,
      ).toBe(201);
    }
    expect(
      (
        await api('/api/feedback', {
          method: 'POST',
          cookie: feedbackCookie,
          body: { category: 'general', message: 'One too many' },
        })
      ).status,
    ).toBe(429);

    const eventCookie = await signUp('event-limit@pitolet.test', 'Event limit');
    for (let index = 0; index < 60; index += 1) {
      expect(
        (
          await api('/api/events', {
            method: 'POST',
            cookie: eventCookie,
            body: { name: 'dashboard_opened', source: 'dashboard' },
          })
        ).status,
      ).toBe(202);
    }
    expect(
      (
        await api('/api/events', {
          method: 'POST',
          cookie: eventCookie,
          body: { name: 'dashboard_opened', source: 'dashboard' },
        })
      ).status,
    ).toBe(429);

    const problemCookie = await signUp('problem-limit@pitolet.test', 'Problem limit');
    for (let index = 0; index < 30; index += 1) {
      expect(
        (
          await api('/api/problems/client', {
            method: 'POST',
            cookie: problemCookie,
            body: { source: 'dashboard', title: 'TypeError' },
          })
        ).status,
      ).toBe(202);
    }
    expect(
      (
        await api('/api/problems/client', {
          method: 'POST',
          cookie: problemCookie,
          body: { source: 'dashboard', title: 'TypeError' },
        })
      ).status,
    ).toBe(429);
  });
});

describe('retention cleanup', () => {
  it('removes expired analytics and problems and strips old screenshots', async () => {
    await pgi.pool.query(
      `UPDATE product_events SET occurred_at = now() - interval '91 days'
       WHERE id = (SELECT min(id) FROM product_events)`,
    );
    await pgi.pool.query(
      `UPDATE problem_groups SET last_seen_at = now() - interval '91 days'
       WHERE fingerprint = (SELECT fingerprint FROM problem_groups ORDER BY last_seen_at ASC LIMIT 1)`,
    );
    await pgi.pool.query(
      `UPDATE feedback_items SET created_at = now() - interval '31 days'
       WHERE screenshot_data IS NOT NULL`,
    );
    await runTelemetryRetention(pgi.pool);
    const oldEvents = await pgi.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM product_events
       WHERE occurred_at < now() - interval '90 days'`,
    );
    const oldProblems = await pgi.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM problem_groups
       WHERE last_seen_at < now() - interval '90 days'`,
    );
    const oldScreenshots = await pgi.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feedback_items
       WHERE screenshot_data IS NOT NULL AND created_at < now() - interval '30 days'`,
    );
    expect(oldEvents.rows[0]!.n).toBe(0);
    expect(oldProblems.rows[0]!.n).toBe(0);
    expect(oldScreenshots.rows[0]!.n).toBe(0);
  });
});
