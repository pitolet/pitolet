import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext } from 'pitolet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, ensureAuthSchema } from '../src/auth/auth.js';
import { makeWorkspaceAuthHooks, WS_PATCHES_PER_MINUTE } from '../src/cloud/authHooks.js';
import { TokenBucketLimiter } from '../src/cloud/rateLimit.js';
import { runMigrations } from '../src/db/migrate.js';
import { createCloudServer, type CloudServer } from '../src/server.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

/**
 * Rate limiting: token-bucket unit behavior under a fake clock, the plan /
 * write-rate rules inside the workspace auth hooks, and the router's
 * per-agent-token MCP budget end-to-end (61st call in a frozen minute → 429).
 */

describe('TokenBucketLimiter (fake clock)', () => {
  it('allows exactly `capacity` calls in a frozen window, then refills continuously', () => {
    let now = 1_000_000;
    const limiter = new TokenBucketLimiter({ capacity: 60, clock: () => now });

    for (let i = 0; i < 60; i++) expect(limiter.allow('k'), `call ${i + 1}`).toBe(true);
    expect(limiter.allow('k')).toBe(false); // 61st in the same minute

    now += 1_000; // 1s refills 1 token at 60/min
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false);

    now += 60_000; // full window → full bucket again
    for (let i = 0; i < 60; i++) expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false);
  });

  it('tracks keys independently', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 2, clock: () => now });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true); // a's exhaustion never affects b
  });
});

describe('workspace auth hooks: plan gate + write budget (fake clock)', () => {
  const user = (id: string): AuthContext => ({
    kind: 'user',
    userId: id,
    displayName: id,
    scopes: ['read', 'write'],
  });

  it("denies doc:create at the free limit with a 429 naming the upgrade path", () => {
    let docs = 2;
    const hooks = makeWorkspaceAuthHooks('ws-1', {
      getPlan: () => 'free',
      getDocCount: () => docs,
      clock: () => 0,
    });
    expect(hooks.authorize!(user('u1'), 'doc:create')).toEqual({ ok: true });
    docs = 3;
    const denied = hooks.authorize!(user('u1'), 'doc:create');
    expect(denied).toMatchObject({ ok: false, status: 429 });
    expect((denied as { reason: string }).reason).toMatch(/limited to 3 documents/i);
    expect((denied as { reason: string }).reason).toMatch(/upgrade to Pro/i);
  });

  it('never doc-gates a pro workspace, and scope checks still precede plan checks', () => {
    const hooks = makeWorkspaceAuthHooks('ws-1', {
      getPlan: () => 'pro',
      getDocCount: () => 10_000,
      clock: () => 0,
    });
    expect(hooks.authorize!(user('u1'), 'doc:create')).toEqual({ ok: true });
    const readOnly: AuthContext = { kind: 'user', userId: 'u2', scopes: ['read'] };
    expect(hooks.authorize!(readOnly, 'doc:create')).toMatchObject({ ok: false, status: 403 });
  });

  it(`buckets doc:write at ${WS_PATCHES_PER_MINUTE}/min per user`, () => {
    let now = 0;
    const hooks = makeWorkspaceAuthHooks('ws-1', { clock: () => now });
    for (let i = 0; i < WS_PATCHES_PER_MINUTE; i++) {
      expect(hooks.authorize!(user('u1'), 'doc:write').ok, `patch ${i + 1}`).toBe(true);
    }
    const denied = hooks.authorize!(user('u1'), 'doc:write');
    expect(denied).toMatchObject({ ok: false, status: 429 });
    // Another user is unaffected; time heals the first.
    expect(hooks.authorize!(user('u2'), 'doc:write').ok).toBe(true);
    now += 60_000;
    expect(hooks.authorize!(user('u1'), 'doc:write').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the router's per-agent-token MCP budget with an injected clock.
// ---------------------------------------------------------------------------

describe('MCP per-token budget (end-to-end, fake clock)', () => {
  let pgi: EphemeralPg;
  let cloud: CloudServer;
  let dataRoot: string;
  let base: string;
  let token: string;
  // Frozen unless a test advances it — no refill mid-burst.
  let now = Date.now();

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-ratelimit-'));
    pgi = await startEphemeralPg('pitolet_ratelimit');
    await runMigrations(pgi.pool);

    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });
    base = `http://127.0.0.1:${port}`;
    const authConfig = { pool: pgi.pool, baseURL: base, secret: 'ratelimit-test-secret' };
    await ensureAuthSchema(authConfig);
    const auth = createAuth(authConfig);

    cloud = createCloudServer({
      pool: pgi.pool,
      auth,
      dataRoot,
      editorDist: null,
      dashboardDist: null,
      billing: null,
      clock: () => now,
    });
    await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));

    const signUp = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dana@ratelimit.test', password: 'p4ssw0rd!!', name: 'Dana' }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ');

    const ws = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rate', slug: 'rate' }),
    });
    expect(ws.status).toBe(201);
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    const minted = await fetch(`${base}/api/workspaces/${wsId}/tokens`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'burst-agent' }),
    });
    expect(minted.status).toBe(201);
    token = ((await minted.json()) as { token: string }).token;
  }, 180_000);

  afterAll(async () => {
    await cloud?.close();
    await pgi?.stop();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function mcpPost(): Promise<Response> {
    return fetch(`${base}/w/rate/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
  }

  it('answers the 61st MCP call in a (frozen) minute with 429, and recovers after refill', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await mcpPost();
      expect(res.status, `request ${i + 1}`).not.toBe(429);
      await res.arrayBuffer(); // drain
    }
    const blocked = await mcpPost();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/60 MCP requests\/min/);

    now += 61_000; // a minute later the bucket is full again
    const recovered = await mcpPost();
    expect(recovered.status).not.toBe(429);
    await recovered.arrayBuffer();
  });
});
