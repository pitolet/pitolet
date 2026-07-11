import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, ensureAuthSchema, type CloudAuth } from '../src/auth/auth.js';
import type { PaddleConfig } from '../src/billing/paddle.js';
import { runMigrations } from '../src/db/migrate.js';
import { createCloudServer, type CloudServer } from '../src/server.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

/**
 * Billing + plan-enforcement suite: Paddle webhook signature verification
 * (fake webhooks = REAL HMAC with a test secret), the idempotency ledger,
 * out-of-order protection, live plan propagation into a loaded runtime, and
 * every free-tier gate (docs, tokens, members, owned workspaces). Also the
 * router review nits (last-owner demote, anonymous-browser redirect).
 *
 * The suite is stateful and ordered, like isolation.test.ts: signature
 * failures first (must not mutate), then free-tier gates, then the upgrade
 * webhook, then dedupe/ordering, then cancellation.
 */

const PASSWORD = 'p4ssw0rd-super-secret';
const EDITOR_SENTINEL = '<!doctype html><title>pitolet-editor-sentinel</title>';

const BILLING: PaddleConfig = {
  apiKey: 'pdl_sdbx_test_apikey',
  webhookSecret: 'pdl_ntfset_test_webhook_secret',
  priceIdPro: 'pri_test_pro_monthly',
  env: 'sandbox',
  apiBase: 'https://sandbox-api.paddle.com',
};

let pgi: EphemeralPg;
let cloud: CloudServer;
let noBilling: CloudServer;
let auth: CloudAuth;
let dataRoot: string;
let editorDist: string;
let base: string;
let noBillingBase: string;
let port: number;

let alice: string; // owner of acme
let bob: string;
let carol: string;

let acme: { id: string; slug: string };
let acmeToken: string;
let mcp: Client;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');
}

function api(
  path: string,
  init: { method?: string; cookie?: string; token?: string; body?: unknown; base?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${init.base ?? base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
}

// --- webhook helpers: REAL HMAC over the raw bytes, exactly like Paddle ---

function paddleSignature(rawBody: string, opts: { secret?: string; ts?: number } = {}): string {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', opts.secret ?? BILLING.webhookSecret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');
  return `ts=${ts};h1=${h1}`;
}

function postWebhook(
  rawBody: string,
  opts: { signature?: string; secret?: string; ts?: number; base?: string } = {},
): Promise<Response> {
  return fetch(`${opts.base ?? base}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'paddle-signature': opts.signature ?? paddleSignature(rawBody, opts),
    },
    body: rawBody,
  });
}

let eventSeq = 0;
function subscriptionEvent(input: {
  workspaceId: unknown;
  type?: string;
  status?: string;
  occurredAt?: string;
  eventId?: string;
}): { event_id: string; body: string } {
  const event_id = input.eventId ?? `evt_test_${++eventSeq}`;
  const body = JSON.stringify({
    event_id,
    event_type: input.type ?? 'subscription.activated',
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    notification_id: `ntf_${event_id}`,
    data: {
      id: 'sub_test_1',
      customer_id: 'ctm_test_1',
      status: input.status ?? 'active',
      custom_data: { workspaceId: input.workspaceId },
      current_billing_period: {
        starts_at: '2026-07-01T00:00:00Z',
        ends_at: '2026-08-01T00:00:00Z',
      },
      items: [{ price: { id: BILLING.priceIdPro } }],
    },
  });
  return { event_id, body };
}

async function workspacePlan(id: string): Promise<string> {
  const res = await pgi.pool.query('SELECT plan FROM workspaces WHERE id = $1', [id]);
  return res.rows[0]?.plan as string;
}

async function subscriptionRow(id: string): Promise<Record<string, unknown> | undefined> {
  const res = await pgi.pool.query('SELECT * FROM subscriptions WHERE workspace_id = $1', [id]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

function mcpText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

// Occurred-at timeline for ordering tests (T0 < T1 < T2).
const T0 = new Date(Date.now() - 60_000).toISOString();
const T1 = new Date().toISOString();
const T2 = new Date(Date.now() + 1_000).toISOString();

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-billing-'));
  editorDist = mkdtempSync(join(tmpdir(), 'pitolet-cloud-billing-editor-'));
  writeFileSync(join(editorDist, 'index.html'), EDITOR_SENTINEL);

  pgi = await startEphemeralPg('pitolet_billing');
  await runMigrations(pgi.pool);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const authConfig = { pool: pgi.pool, baseURL: base, secret: 'billing-test-secret' };
  await ensureAuthSchema(authConfig);
  auth = createAuth(authConfig);

  cloud = createCloudServer({
    pool: pgi.pool,
    auth,
    dataRoot,
    editorDist,
    dashboardDist: null,
    billing: BILLING,
  });
  await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));

  // Second server sharing the pool with billing DISABLED (self-host shape).
  const noBillingPort = await freePort();
  noBillingBase = `http://127.0.0.1:${noBillingPort}`;
  noBilling = createCloudServer({
    pool: pgi.pool,
    auth,
    dataRoot,
    editorDist,
    dashboardDist: null,
    billing: null,
  });
  await new Promise<void>((resolve) => noBilling.server.listen(noBillingPort, '127.0.0.1', resolve));

  alice = await signUp('alice@acme.test', 'Alice');
  bob = await signUp('bob@acme.test', 'Bob');
  carol = await signUp('carol@acme.test', 'Carol');

  const created = await api('/api/workspaces', {
    method: 'POST',
    cookie: alice,
    body: { name: 'Acme', slug: 'acme' },
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { workspace: { id: string } };
  acme = { id: body.workspace.id, slug: 'acme' };

  const minted = await api(`/api/workspaces/${acme.id}/tokens`, {
    method: 'POST',
    cookie: alice,
    body: { name: 'acme-agent' },
  });
  expect(minted.status).toBe(201);
  acmeToken = ((await minted.json()) as { token: string }).token;

  mcp = new Client({ name: 'billing-test', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/w/acme/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${acmeToken}` } },
    }),
  );
}, 180_000);

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await cloud?.close();
  await noBilling?.close();
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(editorDist, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('webhook signature verification', () => {
  it('rejects a missing or garbage Paddle-Signature header with 401', async () => {
    const { body } = subscriptionEvent({ workspaceId: acme.id });
    const missing = await fetch(`${base}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(missing.status).toBe(401);
    const garbage = await postWebhook(body, { signature: 'ts=abc;h1=nothex' });
    expect(garbage.status).toBe(401);
    expect(await workspacePlan(acme.id)).toBe('free');
  });

  it('rejects a tampered body (valid MAC over DIFFERENT bytes) with 401', async () => {
    const { body } = subscriptionEvent({ workspaceId: acme.id });
    const tampered = body.replace('"active"', '"hacked"'); // sign body, send tampered
    const res = await postWebhook(tampered, { signature: paddleSignature(body) });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong-secret signature with 401', async () => {
    const { body } = subscriptionEvent({ workspaceId: acme.id });
    const res = await postWebhook(body, { secret: 'some-other-secret' });
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp (>5 min replay window) with 401 despite a valid MAC', async () => {
    const { body } = subscriptionEvent({ workspaceId: acme.id });
    const stale = await postWebhook(body, { ts: Math.floor(Date.now() / 1000) - 400 });
    expect(stale.status).toBe(401);
    const future = await postWebhook(body, { ts: Math.floor(Date.now() / 1000) + 400 });
    expect(future.status).toBe(401);
  });

  it('no rejected webhook left any trace in the ledger or on the workspace', async () => {
    const events = await pgi.pool.query('SELECT count(*)::int AS n FROM webhook_events');
    expect(events.rows[0].n).toBe(0);
    expect(await workspacePlan(acme.id)).toBe('free');
    expect(await subscriptionRow(acme.id)).toBeUndefined();
  });

  it('answers 400 for a correctly signed but structurally malformed event', async () => {
    const body = JSON.stringify({ event_type: 'subscription.activated' }); // no event_id
    const res = await postWebhook(body);
    expect(res.status).toBe(400);
  });
});

describe('free plan gates', () => {
  it('blocks the 2nd active agent token with 429 naming the limit', async () => {
    // acme-agent from beforeAll is the 1 allowed free token.
    const res = await api(`/api/workspaces/${acme.id}/tokens`, {
      method: 'POST',
      cookie: alice,
      body: { name: 'one-too-many' },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/agent token/i);
    expect(body.error).toMatch(/upgrade to Pro/i);
  });

  it('allows 3 documents via MCP create_document, denies the 4th with the limit message', async () => {
    for (let i = 1; i <= 3; i++) {
      const result = await mcp.callTool({
        name: 'create_document',
        arguments: { name: `Doc ${i}` },
      });
      expect(result.isError ?? false).toBe(false);
    }
    const fourth = await mcp.callTool({ name: 'create_document', arguments: { name: 'Doc 4' } });
    expect(fourth.isError).toBe(true);
    expect(mcpText(fourth)).toMatch(/limited to 3 documents/i);
    expect(mcpText(fourth)).toMatch(/upgrade to Pro/i);
  });

  it('allows the 2nd member, denies the 3rd with 429 naming the limit', async () => {
    const second = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: alice,
      body: { email: 'carol@acme.test', role: 'viewer' },
    });
    expect(second.status).toBe(200);

    const third = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: alice,
      body: { email: 'bob@acme.test', role: 'editor' },
    });
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string };
    expect(body.error).toMatch(/2 members/i);
    expect(body.error).toMatch(/upgrade to Pro/i);

    // Role changes for EXISTING members are not creation — never gated.
    const roleChange = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: alice,
      body: { email: 'carol@acme.test', role: 'editor' },
    });
    expect(roleChange.status).toBe(200);
  });

  it('blocks a 2nd owned workspace on the free plan with 429', async () => {
    const res = await api('/api/workspaces', {
      method: 'POST',
      cookie: alice,
      body: { name: 'Acme Two', slug: 'acme-two' },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/owned workspace/i);
    expect(body.error).toMatch(/Pro/);
  });

  it('GET /api/workspaces/:id/billing is owner-only and reflects the free state', async () => {
    const owner = await api(`/api/workspaces/${acme.id}/billing`, { cookie: alice });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      plan: 'free',
      status: null,
      currentPeriodEnd: null,
      priceId: BILLING.priceIdPro,
      billingEnabled: true,
    });

    const member = await api(`/api/workspaces/${acme.id}/billing`, { cookie: carol });
    expect(member.status).toBe(403);
    const stranger = await api(`/api/workspaces/${acme.id}/billing`, { cookie: bob });
    expect(stranger.status).toBe(404); // non-members must not learn the id is real
  });
});

describe('router nits', () => {
  it('refuses to demote the last owner via the members POST upsert', async () => {
    const res = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: alice,
      body: { email: 'alice@acme.test', role: 'editor' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/last owner/i);
  });

  it('302-redirects anonymous BROWSER navigation to /?next=…, keeps 401 for JSON clients', async () => {
    const browser = await fetch(`${base}/w/acme/`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get('location')).toBe(`/?next=${encodeURIComponent('/w/acme/')}`);

    const jsonClient = await fetch(`${base}/w/acme/api/documents`, {
      headers: { accept: 'application/json' },
    });
    expect(jsonClient.status).toBe(401);

    // A bad Bearer token is a credentialed agent, not a browser — still 401.
    const badToken = await fetch(`${base}/w/acme/`, {
      headers: { accept: 'text/html', authorization: `Bearer ptl_${'0'.repeat(40)}` },
    });
    expect(badToken.status).toBe(401);
  });
});

describe('upgrade via verified webhook', () => {
  it('applies subscription.activated: subscriptions row + workspaces.plan=pro', async () => {
    const { event_id, body } = subscriptionEvent({
      workspaceId: acme.id,
      type: 'subscription.activated',
      status: 'active',
      occurredAt: T1,
      eventId: 'evt_activate',
    });
    const res = await postWebhook(body);
    expect(res.status).toBe(200);

    expect(await workspacePlan(acme.id)).toBe('pro');
    const sub = await subscriptionRow(acme.id);
    expect(sub).toMatchObject({
      paddle_subscription_id: 'sub_test_1',
      paddle_customer_id: 'ctm_test_1',
      plan: 'pro',
      status: 'active',
    });
    expect(sub!.current_period_end).toBeTruthy();

    const ledger = await pgi.pool.query(
      'SELECT processed_at FROM webhook_events WHERE event_id = $1',
      [event_id],
    );
    expect(ledger.rowCount).toBe(1);
    expect(ledger.rows[0].processed_at).toBeTruthy();
  });

  it('lifts every gate LIVE — same runtime, no reload needed', async () => {
    // The runtime loaded during the free-plan tests must be the same object:
    // the webhook propagated through manager.onPlanChanged, not a reload.
    const runtimeBefore = await cloud.manager.getRuntime(acme.id);

    // 4th document now allowed, over the SAME MCP client/connection.
    const fourth = await mcp.callTool({ name: 'create_document', arguments: { name: 'Doc 4' } });
    expect(fourth.isError ?? false).toBe(false);

    // 2nd token now allowed.
    const token = await api(`/api/workspaces/${acme.id}/tokens`, {
      method: 'POST',
      cookie: alice,
      body: { name: 'second-agent' },
    });
    expect(token.status).toBe(201);

    // 3rd member now allowed.
    const member = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: alice,
      body: { email: 'bob@acme.test', role: 'editor' },
    });
    expect(member.status).toBe(200);

    // Owning a pro workspace unlocks creating more workspaces.
    const ws = await api('/api/workspaces', {
      method: 'POST',
      cookie: alice,
      body: { name: 'Acme Two', slug: 'acme-two' },
    });
    expect(ws.status).toBe(201);

    expect(await cloud.manager.getRuntime(acme.id)).toBe(runtimeBefore);

    const billing = await api(`/api/workspaces/${acme.id}/billing`, { cookie: alice });
    expect(await billing.json()).toMatchObject({ plan: 'pro', status: 'active' });
  });
});

describe('idempotency + ordering', () => {
  it('a duplicate event_id is a 200 no-op (ledger holds one row, state unchanged)', async () => {
    const { body } = subscriptionEvent({
      workspaceId: acme.id,
      type: 'subscription.canceled',
      status: 'canceled',
      occurredAt: T2,
      eventId: 'evt_activate', // same id as the applied activation — must dedupe
    });
    const res = await postWebhook(body);
    expect(res.status).toBe(200);

    const ledger = await pgi.pool.query(
      'SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1',
      ['evt_activate'],
    );
    expect(ledger.rows[0].n).toBe(1);
    expect(await workspacePlan(acme.id)).toBe('pro'); // canceled payload NOT applied
    expect((await subscriptionRow(acme.id))!.status).toBe('active');
  });

  it('an out-of-order older event is recorded but not applied', async () => {
    const { body } = subscriptionEvent({
      workspaceId: acme.id,
      type: 'subscription.canceled',
      status: 'canceled',
      occurredAt: T0, // OLDER than the applied activation (T1)
      eventId: 'evt_stale_cancel',
    });
    const res = await postWebhook(body);
    expect(res.status).toBe(200);
    expect(await workspacePlan(acme.id)).toBe('pro');
    expect((await subscriptionRow(acme.id))!.status).toBe('active');
    const ledger = await pgi.pool.query(
      'SELECT processed_at FROM webhook_events WHERE event_id = $1',
      ['evt_stale_cancel'],
    );
    expect(ledger.rowCount).toBe(1); // recorded for audit, never applied
  });

  it('an unknown workspaceId is a logged 200 no-op', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const { body } = subscriptionEvent({ workspaceId: ghost, occurredAt: T2 });
    expect((await postWebhook(body)).status).toBe(200);
    expect(await subscriptionRow(ghost)).toBeUndefined();

    const { body: junk } = subscriptionEvent({ workspaceId: 'not-a-uuid', occurredAt: T2 });
    expect((await postWebhook(junk)).status).toBe(200);
    expect(await workspacePlan(acme.id)).toBe('pro');
  });
});

describe('cancellation', () => {
  it('subscription.canceled (newer) flips the workspace back to free', async () => {
    const { body } = subscriptionEvent({
      workspaceId: acme.id,
      type: 'subscription.canceled',
      status: 'canceled',
      occurredAt: T2,
      eventId: 'evt_cancel',
    });
    expect((await postWebhook(body)).status).toBe(200);
    expect(await workspacePlan(acme.id)).toBe('free');
    expect((await subscriptionRow(acme.id))!.status).toBe('canceled');
  });

  it('the doc gate re-engages live (4 docs > free limit of 3)', async () => {
    const res = await mcp.callTool({ name: 'create_document', arguments: { name: 'Doc 5' } });
    expect(res.isError).toBe(true);
    expect(mcpText(res)).toMatch(/limited to 3 documents/i);
  });
});

describe('billing disabled (self-host / dev shape)', () => {
  it('the webhook route does not exist', async () => {
    const { body } = subscriptionEvent({ workspaceId: acme.id });
    const res = await postWebhook(body, { base: noBillingBase });
    expect(res.status).toBe(404);
  });

  it('the billing endpoint reports billingEnabled=false with no priceId', async () => {
    const res = await api(`/api/workspaces/${acme.id}/billing`, {
      cookie: alice,
      base: noBillingBase,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ billingEnabled: false, priceId: null });
  });
});
