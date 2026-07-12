import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, ensureAuthSchema, type CloudAuth } from '../src/auth/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { createCloudServer, type CloudServer } from '../src/server.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

/**
 * THE cross-tenant isolation suite — the acceptance gate for Pitolet Cloud's
 * multi-tenant router. Real server, real PostgreSQL, real better-auth
 * sessions, real ws + fetch + MCP SDK clients. Two tenants (acme: alice,
 * globex: bob) and every credential type are driven against each other's
 * workspaces; ANY assertion here failing means a tenant leak.
 */

const PASSWORD = 'p4ssw0rd-super-secret';
const EDITOR_SENTINEL = '<!doctype html><title>pitolet-editor-sentinel</title>';

let pgi: EphemeralPg;
let cloud: CloudServer;
let auth: CloudAuth;
let dataRoot: string;
let editorDist: string;
let base: string;
let port: number;

// Session cookies per user.
let alice: string;
let bob: string;
let carol: string;

let acme: { id: string; slug: string; docId: string };
let globex: { id: string; slug: string; docId: string };

let acmeToken: string; // read+write
let acmeReadToken: string; // read only
let globexToken: string; // read+write, other tenant

/** Reserve a free port so better-auth's baseURL can be exact at boot. */
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
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  expect(cookies.some((c) => c.includes('session_token'))).toBe(true);
  return cookies.join('; ');
}

function api(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
}

/** WS connect; resolves the socket or rejects with `ws upgrade rejected: <status>`. */
function wsConnect(
  slug: string,
  creds: { cookie?: string; token?: string } = {},
): Promise<WebSocket> {
  const headers: Record<string, string> = {};
  if (creds.cookie) headers.cookie = creds.cookie;
  if (creds.token) headers.authorization = `Bearer ${creds.token}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/w/${slug}/ws`, { headers });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`ws upgrade rejected: ${res.statusCode}`));
      ws.terminate();
    });
    ws.on('error', (err) => reject(err));
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for ws message')),
      timeoutMs,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

function mcpConnect(slug: string, token: string): Promise<Client> {
  const client = new Client({ name: 'isolation-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/w/${slug}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  return client.connect(transport).then(() => client);
}

function mcpText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

async function starterDocumentId(workspaceId: string): Promise<string> {
  const result = await pgi.pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL',
    [workspaceId],
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.name).toBe('Welcome');
  return result.rows[0]!.id;
}

async function createWorkspaceVia(cookie: string, name: string, slug: string) {
  const res = await api('/api/workspaces', { method: 'POST', cookie, body: { name, slug } });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { workspace: { id: string; slug: string } };
  return body.workspace;
}

async function mintToken(
  cookie: string,
  workspaceId: string,
  name: string,
  scopes?: string[],
): Promise<{ token: string; id: string }> {
  const res = await api(`/api/workspaces/${workspaceId}/tokens`, {
    method: 'POST',
    cookie,
    body: { name, ...(scopes ? { scopes } : {}) },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; id: string };
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-isolation-'));
  editorDist = mkdtempSync(join(tmpdir(), 'pitolet-cloud-editor-'));
  writeFileSync(join(editorDist, 'index.html'), EDITOR_SENTINEL);

  pgi = await startEphemeralPg('pitolet_isolation');
  await runMigrations(pgi.pool);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const authConfig = { pool: pgi.pool, baseURL: base, secret: 'isolation-test-secret' };
  await ensureAuthSchema(authConfig);
  auth = createAuth(authConfig);

  cloud = createCloudServer({
    pool: pgi.pool,
    auth,
    dataRoot,
    editorDist,
    // Null dashboard dist → `/` serves the placeholder text asserted below;
    // dashboard SPA serving has its own suite (dashboard.test.ts).
    dashboardDist: null,
    // Fast lifecycle so the eviction test runs in real time.
    manager: { idleMs: 100, sweepMs: 50 },
  });
  await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));

  alice = await signUp('alice@acme.test', 'Alice');
  bob = await signUp('bob@globex.test', 'Bob');
  carol = await signUp('carol@acme.test', 'Carol');

  const acmeWs = await createWorkspaceVia(alice, 'Acme', 'acme');
  const globexWs = await createWorkspaceVia(bob, 'Globex', 'globex');
  // This suite is about TENANCY, not plans: run both fixture workspaces on
  // pro so free-tier limits (1 token, 2 members) never interfere with the
  // isolation matrix. Plan gates have their own suite (billing.test.ts).
  await pgi.pool.query("UPDATE workspaces SET plan = 'pro' WHERE id = ANY($1)", [
    [acmeWs.id, globexWs.id],
  ]);
  acme = { id: acmeWs.id, slug: 'acme', docId: await starterDocumentId(acmeWs.id) };
  globex = { id: globexWs.id, slug: 'globex', docId: await starterDocumentId(globexWs.id) };

  acmeToken = (await mintToken(alice, acme.id, 'acme-agent')).token;
  acmeReadToken = (await mintToken(alice, acme.id, 'acme-reader', ['read'])).token;
  globexToken = (await mintToken(bob, globex.id, 'globex-agent')).token;

  // carol joins acme as viewer (added by the owner).
  const add = await api(`/api/workspaces/${acme.id}/members`, {
    method: 'POST',
    cookie: alice,
    body: { email: 'carol@acme.test', role: 'viewer' },
  });
  expect(add.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await cloud?.close();
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(editorDist, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('boot surface', () => {
  it('serves the placeholder root and rejects anonymous /api/me', async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('Pitolet cloud');

    const me = await fetch(`${base}/api/me`);
    expect(me.status).toBe(401);
  });

  it('reports identity and workspaces on /api/me with a session', async () => {
    const res = await api('/api/me', { cookie: alice });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { email: string };
      workspaces: Array<{ slug: string; role: string }>;
    };
    expect(body.user.email).toBe('alice@acme.test');
    expect(body.workspaces).toEqual([
      expect.objectContaining({ slug: 'acme', role: 'owner' }),
    ]);
  });
});

describe('workspace slugs', () => {
  it('rejects reserved slugs', async () => {
    for (const slug of ['api', 'auth', 'w', 'admin']) {
      const res = await api('/api/workspaces', {
        method: 'POST',
        cookie: alice,
        body: { name: 'Squat', slug },
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects malformed slugs', async () => {
    for (const slug of ['Bad', 'x', '-lead', 'trail-', 'dou--ble', 'a'.repeat(41), 'sp ace']) {
      const res = await api('/api/workspaces', {
        method: 'POST',
        cookie: alice,
        body: { name: 'Squat', slug },
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects taken slugs with 409', async () => {
    const res = await api('/api/workspaces', {
      method: 'POST',
      cookie: bob,
      body: { name: 'Acme Two', slug: 'acme' },
    });
    expect(res.status).toBe(409);
  });
});

describe('anonymous requests', () => {
  it('gets 401 for every /w/acme HTTP surface', async () => {
    for (const path of [
      '/w/acme/api/documents',
      '/w/acme/api/session',
      '/w/acme/mcp',
      '/w/acme/assets-store/anything',
      '/w/acme/',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
    }
    const upload = await fetch(`${base}/w/acme/api/assets`, { method: 'POST', body: 'x' });
    expect(upload.status).toBe(401);
  });

  it('gets a destroyed 401 socket on WS upgrade', async () => {
    await expect(wsConnect('acme')).rejects.toThrow('ws upgrade rejected: 401');
  });
});

describe("cross-tenant sessions: bob against alice's acme", () => {
  it('sees 404 for the whole /w/acme space (existence hidden)', async () => {
    for (const path of ['/w/acme/api/documents', '/w/acme/api/session', '/w/acme/']) {
      const res = await api(path, { cookie: bob });
      expect(res.status, path).toBe(404);
    }
    const upload = await api('/w/acme/api/assets', { method: 'POST', cookie: bob, body: {} });
    expect(upload.status).toBe(404);
    const exp = await api('/w/acme/api/export', {
      method: 'POST',
      cookie: bob,
      body: { docId: acme.docId },
    });
    expect(exp.status).toBe(404);
  });

  it('gets the same 404 for a workspace that does not exist at all', async () => {
    const res = await api('/w/no-such-tenant/api/documents', { cookie: bob });
    expect(res.status).toBe(404);
  });

  it('cannot open a WS to acme', async () => {
    await expect(wsConnect('acme', { cookie: bob })).rejects.toThrow(
      'ws upgrade rejected: 404',
    );
  });

  it('cannot read acme membership or tokens by workspace id', async () => {
    const members = await api(`/api/workspaces/${acme.id}/members`, { cookie: bob });
    expect(members.status).toBe(404);
    const tokens = await api(`/api/workspaces/${acme.id}/tokens`, { cookie: bob });
    expect(tokens.status).toBe(404);
  });
});

describe('agent tokens', () => {
  it("rejects globex's token on acme with 401, indistinguishable from an invalid token", async () => {
    const foreign = await api('/w/acme/api/documents', { token: globexToken });
    const invalid = await api('/w/acme/api/documents', {
      token: `ptl_${'0'.repeat(40)}`,
    });
    const garbage = await api('/w/acme/api/documents', { token: 'not-even-a-token' });
    expect(foreign.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(garbage.status).toBe(401);
    // Byte-identical bodies: a foreign token learns nothing an invalid one doesn't.
    expect(await foreign.text()).toBe(await invalid.text());
  });

  it('rejects cross-tenant and invalid tokens on /w/acme/mcp with 401', async () => {
    await expect(mcpConnect('acme', globexToken)).rejects.toThrow(/401|unauthorized/);
    await expect(mcpConnect('acme', `ptl_${'f'.repeat(40)}`)).rejects.toThrow(/401|unauthorized/);
  });

  it('rejects revoked tokens with 401', async () => {
    const doomed = await mintToken(alice, acme.id, 'doomed');
    // Works before revocation…
    const before = await api('/w/acme/api/documents', { token: doomed.token });
    expect(before.status).toBe(200);
    const revoke = await api(`/api/workspaces/${acme.id}/tokens`, {
      method: 'DELETE',
      cookie: alice,
      body: { tokenId: doomed.id },
    });
    expect(revoke.status).toBe(200);
    // …and is dead afterwards, HTTP and MCP alike.
    const after = await api('/w/acme/api/documents', { token: doomed.token });
    expect(after.status).toBe(401);
    await expect(mcpConnect('acme', doomed.token)).rejects.toThrow(/401|unauthorized/);
  });

  it('never returns hashes or raw tokens from the token list', async () => {
    const res = await api(`/api/workspaces/${acme.id}/tokens`, { cookie: alice });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain(acmeToken);
    const body = JSON.parse(raw) as { tokens: Array<Record<string, unknown>> };
    for (const t of body.tokens) {
      expect(Object.keys(t).sort()).toEqual([
        'createdAt',
        'id',
        'lastUsedAt',
        'name',
        'revokedAt',
        'scopes',
        'tokenPrefix',
      ]);
      expect(String(t.tokenPrefix)).toMatch(/^ptl_[0-9a-f]{8}$/);
    }
  });

  it('hides write tools from read-scope tokens on MCP', async () => {
    const client = await mcpConnect('acme', acmeReadToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_node');
    expect(names).toContain('list_frames');
    for (const writeTool of [
      'insert_nodes',
      'update_node',
      'delete_nodes',
      'create_document',
      'create_frame',
      'set_tokens',
      'set_selection',
      'import_design_system',
      'add_comment',
      'resolve_comment',
    ]) {
      expect(names, writeTool).not.toContain(writeTool);
    }
    await client.close();
  });
});

describe('members can work (the positive matrix)', () => {
  it('alice lists exactly her own documents', async () => {
    const res = await api('/w/acme/api/documents', { cookie: alice });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).toEqual([acme.docId]);

    // And the tenant boundary from the other side: bob sees only globex's doc.
    const bobRes = await api('/w/globex/api/documents', { cookie: bob });
    const bobBody = (await bobRes.json()) as { documents: Array<{ id: string }> };
    expect(bobBody.documents.map((d) => d.id)).toEqual([globex.docId]);
  });

  it('exposes identity via /w/acme/api/session', async () => {
    const res = await api('/w/acme/api/session', { cookie: alice });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.workspace).toMatchObject({ id: acme.id, slug: 'acme', name: 'Acme' });
    expect(body.role).toBe('owner');
    expect(body.user.name).toBe('Alice');
    expect(body.plan).toBe('pro'); // set in beforeAll — see the tenancy note
  });

  it('alice opens a WS, edits, and gets an ack', async () => {
    const ws = await wsConnect('acme', { cookie: alice });
    ws.send(JSON.stringify({ t: 'open', docId: acme.docId }));
    const doc = await nextMessage(ws);
    expect(doc.t).toBe('doc');
    expect(doc.rev).toBe(0);

    ws.send(
      JSON.stringify({
        t: 'patch',
        docId: acme.docId,
        patchId: 'p1',
        baseRev: 0,
        label: 'rename',
        ops: [{ op: 'replace', path: ['name'], value: 'Acme Landing' }],
      }),
    );
    const ack = await nextMessage(ws);
    expect(ack).toMatchObject({ t: 'ack', patchId: 'p1', rev: 1 });
    ws.close();
  });

  it('MCP list_frames works with the acme write token', async () => {
    const client = await mcpConnect('acme', acmeToken);
    const frames = JSON.parse(
      mcpText(await client.callTool({ name: 'list_frames', arguments: {} })),
    ) as { frames: Array<{ name: string }> };
    expect(frames.frames.map((f) => f.name)).toContain('Landing');
    await client.close();
  });

  it('serves the editor SPA under /w/acme/ and redirects /w/acme', async () => {
    const spa = await api('/w/acme/', { cookie: alice });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe(EDITOR_SENTINEL);

    const redirect = await api('/w/acme', { cookie: alice });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/w/acme/');
  });
});

describe('viewer role (carol on acme)', () => {
  it('can list documents and open the doc over WS', async () => {
    const res = await api('/w/acme/api/documents', { cookie: carol });
    expect(res.status).toBe(200);

    const ws = await wsConnect('acme', { cookie: carol });
    ws.send(JSON.stringify({ t: 'open', docId: acme.docId }));
    const doc = await nextMessage(ws);
    expect(doc.t).toBe('doc');
    ws.close();
  });

  it('gets a reject on patch and the store stays unchanged', async () => {
    const ws = await wsConnect('acme', { cookie: carol });
    ws.send(JSON.stringify({ t: 'open', docId: acme.docId }));
    const before = (await nextMessage(ws)) as { rev: number; document: { name: string } };

    ws.send(
      JSON.stringify({
        t: 'patch',
        docId: acme.docId,
        patchId: 'evil-1',
        baseRev: before.rev,
        label: 'vandalize',
        ops: [{ op: 'replace', path: ['name'], value: 'Pwned' }],
      }),
    );
    const reject = await nextMessage(ws);
    expect(reject).toMatchObject({ t: 'reject', patchId: 'evil-1' });

    // Server-side state is untouched: re-open shows the same rev and name.
    ws.send(JSON.stringify({ t: 'open', docId: acme.docId }));
    const after = (await nextMessage(ws)) as { rev: number; document: { name: string } };
    expect(after.rev).toBe(before.rev);
    expect(after.document.name).toBe(before.document.name);
    expect(after.document.name).not.toBe('Pwned');
    ws.close();
  });

  it('cannot manage agent tokens (403) but can read membership', async () => {
    const tokens = await api(`/api/workspaces/${acme.id}/tokens`, { cookie: carol });
    expect(tokens.status).toBe(403);
    const mint = await api(`/api/workspaces/${acme.id}/tokens`, {
      method: 'POST',
      cookie: carol,
      body: { name: 'sneaky' },
    });
    expect(mint.status).toBe(403);

    const members = await api(`/api/workspaces/${acme.id}/members`, { cookie: carol });
    expect(members.status).toBe(200);

    // …and membership writes stay owner-only.
    const promote = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: carol,
      body: { email: 'carol@acme.test', role: 'owner' },
    });
    expect(promote.status).toBe(403);
  });
});

describe('workspace lifecycle (idle eviction)', () => {
  it('evicts idle runtimes and reloads them intact', async () => {
    // Load acme via a request.
    const warm = await api('/w/acme/api/documents', { cookie: alice });
    expect(warm.status).toBe(200);
    expect(cloud.manager.loadedCount()).toBeGreaterThan(0);

    // No WS clients are open; idle 100ms + sweep 50ms → evicted shortly.
    await expect
      .poll(() => cloud.manager.loadedCount(), { timeout: 5_000, interval: 25 })
      .toBe(0);

    // Next request reloads from PG: document intact, rev preserved (the
    // rev-1 rename from the WS test survived flush-on-evict).
    const res = await api('/w/acme/api/documents', { cookie: alice });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).toEqual([acme.docId]);

    const ws = await wsConnect('acme', { cookie: alice });
    ws.send(JSON.stringify({ t: 'open', docId: acme.docId }));
    const doc = (await nextMessage(ws)) as { rev: number; document: { name: string } };
    expect(doc.rev).toBe(1);
    expect(doc.document.name).toBe('Acme Landing');
    ws.close();
  });
});
