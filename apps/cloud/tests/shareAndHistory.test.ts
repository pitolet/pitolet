import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSampleDocument } from '@pitolet/schema';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * Share links + version history acceptance suite. Real server, real
 * PostgreSQL, real ws + fetch + MCP SDK clients — the same harness as
 * isolation.test.ts, because share links ARE a tenancy surface: one
 * unguessable token must grant read-only access to exactly ONE document and
 * nothing else, ever.
 *
 * Fixtures: acme (pro; alice owner, erin editor, carol viewer; docs A and B)
 * and globex (free; bob owner; one doc) — globex doubles as the
 * cross-tenant foil and the free-plan share-link gate.
 */

const PASSWORD = 'p4ssw0rd-super-secret';

let pgi: EphemeralPg;
let cloud: CloudServer;
let auth: CloudAuth;
let dataRoot: string;
let base: string;
let port: number;

let alice: string; // acme owner
let erin: string; // acme editor
let carol: string; // acme viewer
let bob: string; // globex owner

let acme: { id: string; slug: string; docA: string; docB: string };
let globex: { id: string; slug: string; docId: string };

/** The canonical share link for acme's doc A, minted in beforeAll. */
let shareA: string;
let docBOnlyAsset: string;

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
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
}

interface WsClient {
  ws: WebSocket;
  /** Next buffered message matching the predicate (default: any). */
  next(
    predicate?: (m: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * Connect and attach a buffering inbox IMMEDIATELY — broadcasts that arrive
 * between two awaits are queued, never dropped (a bare `once('message')`
 * between awaits loses them).
 */
function wsConnect(url: string, cookie?: string): Promise<WsClient> {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  const queue: Array<Record<string, unknown>> = [];
  let notify: (() => void) | null = null;
  ws.on('message', (data) => {
    queue.push(JSON.parse(String(data)) as Record<string, unknown>);
    notify?.();
  });
  const next: WsClient['next'] = async (predicate = () => true, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = queue.findIndex(predicate);
      if (idx >= 0) return queue.splice(idx, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for ws message');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          notify = null;
          reject(new Error('timed out waiting for ws message'));
        }, remaining);
        notify = () => {
          clearTimeout(timer);
          notify = null;
          resolve();
        };
      });
    }
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, next, close: () => ws.close() }));
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`ws upgrade rejected: ${res.statusCode}`));
      ws.terminate();
    });
    ws.on('error', (err) => reject(err));
  });
}

function mcpShareConnect(slug: string, token: string): Promise<Client> {
  const client = new Client({ name: 'share-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/w/${slug}/mcp`), {
    requestInit: { headers: { 'x-pitolet-share': token } },
  });
  return client.connect(transport).then(() => client);
}

function mcpText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

async function exchangeShare(token: string): Promise<string> {
  const exchange = await fetch(`${base}/s/${token}`, { redirect: 'manual' });
  expect(exchange.status).toBe(302);
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]!;
  expect(cookie).toContain('pitolet_share=psess_');
  expect(exchange.headers.get('location')).not.toContain(token);
  return cookie;
}

async function seedDocument(workspaceId: string, name: string): Promise<string> {
  const doc = createSampleDocument();
  doc.name = name;
  await pgi.pool.query(
    'INSERT INTO documents (id, workspace_id, name, doc, rev) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [doc.id, workspaceId, doc.name, JSON.stringify(doc), 0],
  );
  return doc.id;
}

async function createWorkspaceVia(cookie: string, name: string, slug: string) {
  const res = await api('/api/workspaces', { method: 'POST', cookie, body: { name, slug } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { workspace: { id: string; slug: string } }).workspace;
}

async function mintShare(
  cookie: string,
  workspaceId: string,
  docId: string,
  expiresInDays?: number,
): Promise<{
  status: number;
  token?: string;
  url?: string;
  expiresAt?: string | null;
  error?: string;
}> {
  const res = await api(`/api/workspaces/${workspaceId}/share-links`, {
    method: 'POST',
    cookie,
    body: { docId, ...(expiresInDays !== undefined ? { expiresInDays } : {}) },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, ...(body as object) };
}

/** Send a WS patch and wait for its ack (rev). */
async function patchDoc(
  client: WsClient,
  docId: string,
  patchId: string,
  name: string,
  baseRev: number,
): Promise<number> {
  client.ws.send(
    JSON.stringify({
      t: 'patch',
      docId,
      patchId,
      baseRev,
      label: 'rename',
      ops: [{ op: 'replace', path: ['name'], value: name }],
    }),
  );
  const ack = await client.next((m) => m.t === 'ack' && m.patchId === patchId);
  return ack.rev as number;
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-share-'));
  pgi = await startEphemeralPg('pitolet_share_history');
  await runMigrations(pgi.pool);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const authConfig = { pool: pgi.pool, baseURL: base, secret: 'share-test-secret' };
  await ensureAuthSchema(authConfig);
  auth = createAuth(authConfig);

  cloud = createCloudServer({
    pool: pgi.pool,
    auth,
    dataRoot,
    editorDist: null,
    dashboardDist: null,
    // Long idle: runtimes must survive the whole suite (restore state lives
    // in them). Fast storage: 25ms doc-write debounce and a 2-rev snapshot
    // cadence so auto-snapshots are forced deterministically.
    manager: {
      idleMs: 10 * 60_000,
      sweepMs: 60_000,
      storage: {
        debounceMs: 25,
        maxWaitMs: 100,
        snapshotEveryRevs: 2,
        snapshotEveryMs: 60 * 60_000,
      },
    },
  });
  await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));

  alice = await signUp('alice@acme.test', 'Alice');
  erin = await signUp('erin@acme.test', 'Erin');
  carol = await signUp('carol@acme.test', 'Carol');
  bob = await signUp('bob@globex.test', 'Bob');

  const acmeWs = await createWorkspaceVia(alice, 'Acme', 'acme');
  const globexWs = await createWorkspaceVia(bob, 'Globex', 'globex');
  // acme on pro (member + share-link headroom); globex STAYS free — it is
  // the plan-gate fixture (2 share links per doc).
  await pgi.pool.query("UPDATE workspaces SET plan = 'pro' WHERE id = $1", [acmeWs.id]);

  acme = {
    id: acmeWs.id,
    slug: 'acme',
    docA: await seedDocument(acmeWs.id, 'Doc A'),
    docB: await seedDocument(acmeWs.id, 'Doc B'),
  };
  const privateAssetBytes = Buffer.from('doc-b-only-image');
  docBOnlyAsset = `${createHash('sha256').update(privateAssetBytes).digest('hex')}.png`;
  const assetDir = join(dataRoot, 'workspaces', acme.id, 'assets');
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, docBOnlyAsset), privateAssetBytes);
  await pgi.pool.query(
    `UPDATE documents
     SET doc = jsonb_set(
       doc,
       '{assets}',
       COALESCE(doc -> 'assets', '{}'::jsonb) ||
         jsonb_build_object($2::text, $3::jsonb)
     )
     WHERE id = $1`,
    [
      acme.docB,
      docBOnlyAsset,
      JSON.stringify({
        fileName: 'private.png',
        width: 1,
        height: 1,
        mime: 'image/png',
      }),
    ],
  );
  globex = {
    id: globexWs.id,
    slug: 'globex',
    docId: await seedDocument(globexWs.id, 'Globex Doc'),
  };

  for (const [email, role] of [
    ['erin@acme.test', 'editor'],
    ['carol@acme.test', 'viewer'],
  ] as const) {
    const add = await api(`/api/workspaces/${acme.id}/members`, {
      method: 'POST',
      cookie: alice,
      body: { email, role },
    });
    expect(add.status).toBe(200);
  }

  const minted = await mintShare(alice, acme.id, acme.docA);
  expect(minted.status).toBe(201);
  shareA = minted.token!;
}, 180_000);

afterAll(async () => {
  await cloud?.close();
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('share link management', () => {
  it('mints pshare_ tokens with a /s/ url (owner and editor)', async () => {
    expect(shareA).toMatch(/^pshare_[A-Za-z0-9_-]{24}$/);

    const byEditor = await mintShare(erin, acme.id, acme.docA);
    expect(byEditor.status).toBe(201);
    expect(byEditor.url).toBe(`/s/${byEditor.token}`);
    expect(byEditor.expiresAt).toBeNull();

    const expiring = await mintShare(alice, acme.id, acme.docA, 7);
    expect(expiring.status).toBe(201);
    expect(new Date(expiring.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('viewers cannot mint, list, or revoke (403)', async () => {
    const mint = await mintShare(carol, acme.id, acme.docA);
    expect(mint.status).toBe(403);
    const list = await api(`/api/workspaces/${acme.id}/share-links?docId=${acme.docA}`, {
      cookie: carol,
    });
    expect(list.status).toBe(403);
    const del = await api(`/api/workspaces/${acme.id}/share-links`, {
      method: 'DELETE',
      cookie: carol,
      body: { token: shareA },
    });
    expect(del.status).toBe(403);
  });

  it('404s a cross-workspace docId on POST (existence hidden)', async () => {
    const res = await mintShare(alice, acme.id, globex.docId);
    expect(res.status).toBe(404);
  });

  it('non-members get 404 for the whole share-links surface', async () => {
    const res = await api(`/api/workspaces/${acme.id}/share-links?docId=${acme.docA}`, {
      cookie: bob,
    });
    expect(res.status).toBe(404);
  });

  it('lists links for a doc, newest first, with urls', async () => {
    const res = await api(`/api/workspaces/${acme.id}/share-links?docId=${acme.docA}`, {
      cookie: alice,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shareLinks: Array<Record<string, unknown>> };
    expect(body.shareLinks.length).toBeGreaterThanOrEqual(3);
    const mine = body.shareLinks.find((l) => l.token === shareA);
    expect(mine).toMatchObject({ url: `/s/${shareA}`, docId: acme.docA, revokedAt: null });
  });
});

describe('GET /s/:token (public entry)', () => {
  it('exchanges a valid URL token for an HttpOnly workspace cookie', async () => {
    const res = await fetch(`${base}/s/${shareA}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/w/acme/');
    expect(res.headers.get('location')).not.toContain(shareA);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('pitolet_share=psess_');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/w/acme/');

    const browser = await fetch(`${base}/w/acme/api/documents`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(browser.status).toBe(200);
    const body = (await browser.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((doc) => doc.id)).toEqual([acme.docA]);
  });

  it('serves one byte-identical dark 404 page for invalid, revoked, and expired', async () => {
    const revoked = (await mintShare(alice, acme.id, acme.docA)).token!;
    await api(`/api/workspaces/${acme.id}/share-links`, {
      method: 'DELETE',
      cookie: alice,
      body: { token: revoked },
    });
    const expired = (await mintShare(alice, acme.id, acme.docA)).token!;
    await pgi.pool.query(
      "UPDATE share_links SET expires_at = now() - interval '1 hour' WHERE token = $1",
      [expired],
    );

    const responses = await Promise.all(
      [`pshare_${'0'.repeat(24)}`, 'not-even-a-token', revoked, expired].map((t) =>
        fetch(`${base}/s/${t}`),
      ),
    );
    const texts = await Promise.all(responses.map((r) => r.text()));
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(texts[i]).toBe(texts[0]); // byte-identical across ALL failure modes
    }
    expect(texts[0]).toContain('404');
  });
});

describe('share-authenticated access (the security boundary)', () => {
  it('lists only the shared document through an exchanged HttpOnly session', async () => {
    const shareCookie = await exchangeShare(shareA);
    const res = await fetch(`${base}/w/acme/api/documents`, {
      headers: { cookie: shareCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pitolet-read-only')).toBe('true');
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).toEqual([acme.docA]); // docB invisible
  });

  it('serves only assets declared by the shared document', async () => {
    const shareCookie = await exchangeShare(shareA);
    const denied = await fetch(`${base}/w/acme/assets-store/${docBOnlyAsset}`, {
      headers: { cookie: shareCookie },
    });
    expect(denied.status).toBe(404);

    const owner = await fetch(`${base}/w/acme/assets-store/${docBOnlyAsset}`, {
      headers: { cookie: alice },
    });
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer())).toEqual(Buffer.from('doc-b-only-image'));
  });

  it('rejects a share session on another workspace with a byte-identical 401', async () => {
    const shareCookie = await exchangeShare(shareA);
    const foreign = await fetch(`${base}/w/globex/api/documents`, {
      headers: { cookie: shareCookie },
    });
    const invalid = await fetch(`${base}/w/globex/api/documents`, {
      headers: { 'x-pitolet-share': `pshare_${'0'.repeat(24)}` },
    });
    expect(foreign.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(await foreign.text()).toBe(await invalid.text());
  });

  it('opens a WS with the share cookie, reads one doc, and rejects writes and other docs', async () => {
    const shareCookie = await exchangeShare(shareA);
    const client = await wsConnect(`ws://127.0.0.1:${port}/w/acme/ws`, shareCookie);
    try {
      client.ws.send(JSON.stringify({ t: 'open', docId: acme.docA }));
      const doc = await client.next();
      expect(doc.t).toBe('doc');
      expect((doc.document as { id: string }).id).toBe(acme.docA);

      // The OTHER doc in the same workspace: invisible.
      client.ws.send(JSON.stringify({ t: 'open', docId: acme.docB }));
      const denied = await client.next();
      expect(denied.t).toBe('error');

      // Writes: rejected (share links are read-only).
      client.ws.send(
        JSON.stringify({
          t: 'patch',
          docId: acme.docA,
          patchId: 'share-evil',
          baseRev: 0,
          label: 'vandalize',
          ops: [{ op: 'replace', path: ['name'], value: 'Pwned' }],
        }),
      );
      const reject = await client.next();
      expect(reject).toMatchObject({ t: 'reject', patchId: 'share-evil' });
    } finally {
      client.close();
    }

    // Server state untouched.
    const list = await fetch(`${base}/w/acme/api/documents`, {
      headers: { cookie: shareCookie },
    });
    const body = (await list.json()) as { documents: Array<{ name: string }> };
    expect(body.documents[0]!.name).not.toBe('Pwned');
  });

  it('MCP via X-Pitolet-Share: read tools only, other docs invisible', async () => {
    const client = await mcpShareConnect('acme', shareA);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_documents');
    expect(names).toContain('list_frames');
    for (const writeTool of [
      'insert_nodes',
      'update_node',
      'delete_nodes',
      'create_document',
      'create_frame',
      'set_tokens',
      'import_design_system',
      'add_comment',
    ]) {
      expect(names, writeTool).not.toContain(writeTool);
    }

    const docs = JSON.parse(
      mcpText(await client.callTool({ name: 'list_documents', arguments: {} })),
    ) as {
      documents: Array<{ id: string }>;
    };
    expect(docs.documents.map((d) => d.id)).toEqual([acme.docA]);

    // Naming the other doc explicitly still fails.
    const other = await client.callTool({ name: 'list_frames', arguments: { docId: acme.docB } });
    expect(other.isError).toBe(true);
    expect(mcpText(other)).toContain('unknown document');
    await client.close();
  });

  it('revoked and expired tokens die with the byte-identical API 401', async () => {
    const doomed = (await mintShare(alice, acme.id, acme.docA)).token!;
    const shareCookie = await exchangeShare(doomed);
    const before = await fetch(`${base}/w/acme/api/documents`, {
      headers: { cookie: shareCookie },
    });
    expect(before.status).toBe(200);
    const revoke = await api(`/api/workspaces/${acme.id}/share-links`, {
      method: 'DELETE',
      cookie: alice,
      body: { token: doomed },
    });
    expect(revoke.status).toBe(200);

    const fading = (await mintShare(alice, acme.id, acme.docA)).token!;
    await pgi.pool.query(
      "UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE token = $1",
      [fading],
    );

    const revokedRes = await fetch(`${base}/w/acme/api/documents`, {
      headers: { 'x-pitolet-share': doomed },
    });
    const expiredRes = await fetch(`${base}/w/acme/api/documents`, {
      headers: { 'x-pitolet-share': fading },
    });
    const invalidRes = await fetch(`${base}/w/acme/api/documents`, {
      headers: { 'x-pitolet-share': `pshare_${'f'.repeat(24)}` },
    });
    expect(revokedRes.status).toBe(401);
    expect(expiredRes.status).toBe(401);
    expect(invalidRes.status).toBe(401);
    const revokedSession = await fetch(`${base}/w/acme/api/documents`, {
      headers: { cookie: shareCookie },
    });
    expect(revokedSession.status).toBe(401);
    const invalidText = await invalidRes.text();
    expect(await revokedRes.text()).toBe(invalidText);
    expect(await expiredRes.text()).toBe(invalidText);

    // And the WS upgrade dies the same way.
    await expect(wsConnect(`ws://127.0.0.1:${port}/w/acme/ws`, shareCookie)).rejects.toThrow(
      'ws upgrade rejected: 401',
    );
  });

  it('never accepts raw share credentials in API, asset, or WebSocket URLs', async () => {
    const apiResult = await fetch(`${base}/w/acme/api/documents?share=${shareA}`);
    const assetResult = await fetch(`${base}/w/acme/assets-store/${docBOnlyAsset}?share=${shareA}`);
    expect(apiResult.status).toBe(401);
    expect(assetResult.status).toBe(401);
    await expect(wsConnect(`ws://127.0.0.1:${port}/w/acme/ws?share=${shareA}`)).rejects.toThrow(
      'ws upgrade rejected: 401',
    );
  });
});

describe('share plan gate (free tier: 2 active links per doc)', () => {
  it('429s the 3rd active link and frees a slot on revoke', async () => {
    const first = await mintShare(bob, globex.id, globex.docId);
    const second = await mintShare(bob, globex.id, globex.docId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const third = await mintShare(bob, globex.id, globex.docId);
    expect(third.status).toBe(429);
    expect(third.error).toContain('share links');

    const revoke = await api(`/api/workspaces/${globex.id}/share-links`, {
      method: 'DELETE',
      cookie: bob,
      body: { token: first.token },
    });
    expect(revoke.status).toBe(200);
    const again = await mintShare(bob, globex.id, globex.docId);
    expect(again.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------

describe('version history', () => {
  const historyPath = (docId: string, tail: 'snapshots' | 'restore') =>
    `/api/workspaces/${acme.id}/docs/${docId}/${tail}`;
  let namedSnapshotId: string;

  it('writes auto snapshots on the patch cadence', async () => {
    const client = await wsConnect(`ws://127.0.0.1:${port}/w/acme/ws`, alice);
    try {
      client.ws.send(JSON.stringify({ t: 'open', docId: acme.docA }));
      await client.next((m) => m.t === 'doc');
      const firstRev = await patchDoc(client, acme.docA, 'h1', 'Draft', 0);
      const rev = await patchDoc(client, acme.docA, 'h2', 'Version One', firstRev);
      expect(rev).toBe(2);
    } finally {
      client.close();
    }

    // snapshotEveryRevs=2, debounce 25ms → an auto snapshot lands shortly.
    await expect
      .poll(
        async () =>
          (
            await pgi.pool.query(
              "SELECT count(*)::int AS n FROM doc_snapshots WHERE doc_id = $1 AND kind = 'auto'",
              [acme.docA],
            )
          ).rows[0].n as number,
        { timeout: 5_000, interval: 50 },
      )
      .toBeGreaterThan(0);
  });

  it('creates a named snapshot of the LIVE state (editor|owner) and lists newest first', async () => {
    const viewerPost = await api(historyPath(acme.docA, 'snapshots'), {
      method: 'POST',
      cookie: carol,
      body: { label: 'sneaky' },
    });
    expect(viewerPost.status).toBe(403);

    const res = await api(historyPath(acme.docA, 'snapshots'), {
      method: 'POST',
      cookie: alice,
      body: { label: 'v1' },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; rev: number; kind: string; label: string };
    expect(created).toMatchObject({ kind: 'named', label: 'v1', rev: 2 });
    namedSnapshotId = created.id;

    // Any member (viewer included) can browse history.
    const list = await api(historyPath(acme.docA, 'snapshots'), { cookie: carol });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { snapshots: Array<Record<string, unknown>> };
    expect(body.snapshots.length).toBeGreaterThanOrEqual(2);
    expect(body.snapshots[0]).toMatchObject({ id: namedSnapshotId, kind: 'named', label: 'v1' });
    for (const s of body.snapshots) {
      expect(Object.keys(s).sort()).toEqual([
        'createdAt',
        'createdBy',
        'id',
        'kind',
        'label',
        'rev',
      ]);
    }
    // Newest first.
    const times = body.snapshots.map((s) => new Date(s.createdAt as string).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('guards history routes: foreign docs 404, non-members 404', async () => {
    const foreignDoc = await api(historyPath(globex.docId, 'snapshots'), { cookie: alice });
    expect(foreignDoc.status).toBe(404);
    const nonMember = await api(historyPath(acme.docA, 'snapshots'), { cookie: bob });
    expect(nonMember.status).toBe(404);
  });

  it('restores a snapshot: live broadcast, pre-restore safety net, content rollback', async () => {
    // A second client watches the doc — the restore must arrive as a live patch.
    const watcher = await wsConnect(`ws://127.0.0.1:${port}/w/acme/ws`, carol);
    try {
      watcher.ws.send(JSON.stringify({ t: 'open', docId: acme.docA }));
      await watcher.next((m) => m.t === 'doc');

      // Move the doc past the snapshot.
      const editorClient = await wsConnect(`ws://127.0.0.1:${port}/w/acme/ws`, alice);
      try {
        editorClient.ws.send(JSON.stringify({ t: 'open', docId: acme.docA }));
        await editorClient.next((m) => m.t === 'doc');
        const revAfterEdit = await patchDoc(editorClient, acme.docA, 'h3', 'Version Two', 2);
        expect(revAfterEdit).toBe(3);
      } finally {
        editorClient.close();
      }

      const res = await api(historyPath(acme.docA, 'restore'), {
        method: 'POST',
        cookie: alice,
        body: { snapshotId: namedSnapshotId },
      });
      expect(res.status).toBe(200);
      const { rev } = (await res.json()) as { rev: number };
      expect(rev).toBe(4);

      // The watcher received the restore live, as a server-originated patch.
      const patch = await watcher.next((m) => m.t === 'patch' && m.origin === 'server');
      expect(patch).toMatchObject({ label: 'Restore version', rev: 4 });

      // Content is back to the snapshot state (name at rev 2), id preserved.
      watcher.ws.send(JSON.stringify({ t: 'open', docId: acme.docA }));
      const reopened = await watcher.next((m) => m.t === 'doc');
      expect((reopened.document as { name: string; id: string }).name).toBe('Version One');
      expect((reopened.document as { id: string }).id).toBe(acme.docA);
      expect(reopened.rev).toBe(4);
    } finally {
      watcher.close();
    }

    // The pre-restore snapshot captured the pre-rollback state ('Version Two').
    const pre = await pgi.pool.query(
      "SELECT rev, doc->>'name' AS name FROM doc_snapshots WHERE doc_id = $1 AND kind = 'pre-restore'",
      [acme.docA],
    );
    expect(pre.rowCount).toBe(1);
    expect(pre.rows[0]).toMatchObject({ rev: 3, name: 'Version Two' });
  });

  it('404s cross-workspace and unknown snapshot ids on restore', async () => {
    // A real snapshot — but of GLOBEX's doc.
    const foreignSnap = await api(`/api/workspaces/${globex.id}/docs/${globex.docId}/snapshots`, {
      method: 'POST',
      cookie: bob,
      body: { label: 'globex-v1' },
    });
    expect(foreignSnap.status).toBe(201);
    const foreignId = ((await foreignSnap.json()) as { id: string }).id;

    for (const snapshotId of [
      foreignId, // exists, belongs to another tenant's doc
      '00000000-0000-4000-8000-000000000000', // valid uuid, no row
      'not-a-uuid', // malformed
    ]) {
      const res = await api(historyPath(acme.docA, 'restore'), {
        method: 'POST',
        cookie: alice,
        body: { snapshotId },
      });
      expect(res.status, snapshotId).toBe(404);
    }
  });

  it('403s viewer restore attempts', async () => {
    const res = await api(historyPath(acme.docA, 'restore'), {
      method: 'POST',
      cookie: carol,
      body: { snapshotId: namedSnapshotId },
    });
    expect(res.status).toBe(403);
  });

  it('422s a snapshot whose document cannot be migrated', async () => {
    const broken = await pgi.pool.query(
      `INSERT INTO doc_snapshots (doc_id, rev, doc, kind, label)
       VALUES ($1, 99, '{"schemaVersion": 99}'::jsonb, 'named', 'from-the-future') RETURNING id`,
      [acme.docA],
    );
    const res = await api(historyPath(acme.docA, 'restore'), {
      method: 'POST',
      cookie: alice,
      body: { snapshotId: broken.rows[0].id as string },
    });
    expect(res.status).toBe(422);
    // No pre-restore snapshot was written for the failed attempt.
    const pre = await pgi.pool.query(
      "SELECT count(*)::int AS n FROM doc_snapshots WHERE doc_id = $1 AND kind = 'pre-restore'",
      [acme.docA],
    );
    expect(pre.rows[0].n).toBe(1); // still just the one from the successful restore
  });
});
