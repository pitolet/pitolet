import { createDocument } from '@pitolet/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApp,
  sharedPasswordAuth,
  type AuthHooks,
  type PitoletApp,
} from '../src/index.js';

const PASSWORD = 'correct horse battery staple';

async function startApp(auth?: AuthHooks, editorDist?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pitolet-auth-'));
  const app = await createApp({ port: 0, dataDir, auth, editorDist });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, dataDir, port, base: `http://127.0.0.1:${port}` };
}

async function stopApp(app: PitoletApp, dataDir: string) {
  await app.adapter.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}

/** Open a WS, optionally with headers; resolve on open, reject on error. */
function wsConnect(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

function mcpClient(base: string, headers?: Record<string, string>) {
  const client = new Client({ name: 'auth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  return { client, transport };
}

// ---------------------------------------------------------------------------

describe('no-auth mode (regression): everything works without credentials', () => {
  let app: PitoletApp;
  let dataDir: string;
  let port: number;
  let base: string;

  beforeAll(async () => {
    ({ app, dataDir, port, base } = await startApp());
  });
  afterAll(async () => stopApp(app, dataDir));

  it('serves /api/documents, /api/health and /mcp without credentials', async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);

    const docs = await fetch(`${base}/api/documents`);
    expect(docs.status).toBe(200);
    const body = (await docs.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.length).toBeGreaterThan(0);

    const { client, transport } = mcpClient(base);
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('insert_nodes');
    await client.close();
  });

  it('accepts bare WS connections and opens documents', async () => {
    const docId = app.store.list()[0]!.id;
    const ws = await wsConnect(port);
    ws.send(JSON.stringify({ t: 'open', docId }));
    const msg = await nextMessage(ws);
    expect(msg.t).toBe('doc');
    ws.close();
  });
});

// ---------------------------------------------------------------------------

describe('shared password mode', () => {
  let app: PitoletApp;
  let dataDir: string;
  let port: number;
  let base: string;
  let editorDist: string;
  let docId: string;

  beforeAll(async () => {
    editorDist = mkdtempSync(join(tmpdir(), 'pitolet-editor-'));
    writeFileSync(join(editorDist, 'index.html'), '<!doctype html><title>pitolet</title>');
    ({ app, dataDir, port, base } = await startApp(sharedPasswordAuth(PASSWORD), editorDist));
    docId = app.store.list()[0]!.id;
  });
  afterAll(async () => {
    await stopApp(app, dataDir);
    rmSync(editorDist, { recursive: true, force: true });
  });

  async function login(password: string) {
    return fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }

  async function sessionCookie(): Promise<string> {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    return setCookie.split(';')[0]!; // "pitolet_session=<value>"
  }

  it('rejects /api/*, /assets-store/* and /mcp without credentials (401)', async () => {
    for (const path of ['/api/documents', '/api/export', '/assets-store/anything', '/api/assets']) {
      const res = await fetch(`${base}${path}`, { method: path === '/api/documents' ? 'GET' : 'POST' });
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
    }
    const mcp = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(mcp.status).toBe(401);
  });

  it('keeps the public allowlist reachable: health + static SPA', async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('pitolet');
  });

  it('rejects a wrong password on login (401)', async () => {
    const res = await login('wrong');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('logs in with the right password and sets an HttpOnly session cookie', async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('pitolet_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).not.toContain('Secure'); // plain http, no proxy header
  });

  it('accepts the session cookie on /api/*', async () => {
    const cookie = await sessionCookie();
    const res = await fetch(`${base}/api/documents`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('rejects a forged/expired session cookie', async () => {
    const forged = `pitolet_session=${Date.now() + 999999}.deadbeef`;
    const res = await fetch(`${base}/api/documents`, { headers: { cookie: forged } });
    expect(res.status).toBe(401);
  });

  it('accepts Authorization: Bearer <password> and rejects a wrong bearer', async () => {
    const ok = await fetch(`${base}/api/documents`, {
      headers: { authorization: `Bearer ${PASSWORD}` },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${base}/api/documents`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.status).toBe(401);
  });

  it('refuses WS upgrades without credentials', async () => {
    await expect(wsConnect(port)).rejects.toThrow(/401/);
  });

  it('accepts WS upgrades carrying the session cookie and opens a doc', async () => {
    const cookie = await sessionCookie();
    const ws = await wsConnect(port, { cookie });
    ws.send(JSON.stringify({ t: 'open', docId }));
    const msg = await nextMessage(ws);
    expect(msg.t).toBe('doc');
    expect(msg.docId).toBe(docId);
    ws.close();
  });

  it('MCP: bearer connects and lists tools; no header is rejected', async () => {
    const authed = mcpClient(base, { authorization: `Bearer ${PASSWORD}` });
    await authed.client.connect(authed.transport);
    const { tools } = await authed.client.listTools();
    expect(tools.map((t) => t.name)).toContain('list_documents');
    expect(tools.map((t) => t.name)).toContain('insert_nodes'); // full access
    await authed.client.close();

    const anon = mcpClient(base);
    await expect(anon.client.connect(anon.transport)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('login rate limiting', () => {
  let app: PitoletApp;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    ({ app, dataDir, base } = await startApp(sharedPasswordAuth(PASSWORD)));
  });
  afterAll(async () => stopApp(app, dataDir));

  it('returns 429 after 10 attempts per minute per IP', async () => {
    const attempt = () =>
      fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status, `attempt ${i + 1}`).toBe(401);
    }
    expect((await attempt()).status).toBe(429);
    // Even the RIGHT password is throttled once the window is exhausted.
    const throttledRight = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(throttledRight.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------

describe('scoped contexts (custom hooks)', () => {
  let app: PitoletApp;
  let dataDir: string;
  let port: number;
  let base: string;
  let mainDocId: string;
  let shareDocId: string;

  const hooks: AuthHooks = {
    authenticate: async (req) => {
      const kind = req.headers['x-test-ctx'];
      if (kind === 'read-agent') return { kind: 'agent', scopes: ['read'] };
      if (kind === 'share') return { kind: 'share', scopes: ['read'], docId: shareDocId };
      if (kind === 'full') return { kind: 'user', displayName: 'tester' };
      return null;
    },
    authorize: (ctx, action, docId) => {
      if (ctx.docId !== undefined && docId !== undefined && docId !== ctx.docId) {
        return { ok: false, status: 403, reason: 'document out of scope' };
      }
      const writeActions = ['doc:write', 'doc:create', 'asset:write', 'export'];
      if (ctx.scopes && !ctx.scopes.includes('write') && writeActions.includes(action)) {
        return { ok: false, status: 403, reason: 'read-only context' };
      }
      return { ok: true };
    },
  };

  beforeAll(async () => {
    ({ app, dataDir, port, base } = await startApp(hooks));
    mainDocId = app.store.list()[0]!.id;
    const shareDoc = createDocument({ name: 'Shared Only' });
    app.store.load(shareDoc);
    shareDocId = shareDoc.id;
  });
  afterAll(async () => stopApp(app, dataDir));

  it('read-scoped MCP context sees read tools but no write tools', async () => {
    const { client, transport } = mcpClient(base, { 'x-test-ctx': 'read-agent' });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const readTool of [
      'list_documents',
      'list_frames',
      'get_node',
      'get_selection',
      'get_design_as_code',
      'get_tokens',
      'get_screenshot',
      'get_comments',
      'check_drift',
    ]) {
      expect(names, readTool).toContain(readTool);
    }
    for (const writeTool of [
      'create_frame',
      'insert_nodes',
      'update_node',
      'delete_nodes',
      'set_tokens',
      'set_selection',
      'create_document',
      'add_comment',
      'resolve_comment',
      'import_design_system',
      'export_project',
    ]) {
      expect(names, writeTool).not.toContain(writeTool);
    }
    await client.close();
  });

  it('docId-restricted context sees only its document', async () => {
    const { client, transport } = mcpClient(base, { 'x-test-ctx': 'share' });
    await client.connect(transport);

    const list = await client.callTool({ name: 'list_documents', arguments: {} });
    const content = list.content as Array<{ type: string; text?: string }>;
    const parsed = JSON.parse(content[0]!.text!) as { documents: Array<{ id: string }> };
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0]!.id).toBe(shareDocId);

    // Other docs are invisible, both explicitly and as the implicit default.
    const other = await client.callTool({ name: 'list_frames', arguments: { docId: mainDocId } });
    expect(other.isError).toBe(true);
    const implicit = await client.callTool({ name: 'list_frames', arguments: {} });
    expect(implicit.isError).toBeFalsy(); // defaults to the shared doc, not the first doc
    await client.close();

    // HTTP list is filtered the same way.
    const res = await fetch(`${base}/api/documents`, { headers: { 'x-test-ctx': 'share' } });
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).toEqual([shareDocId]);
  });

  it('WS defense in depth: read-only ctx can open but patches are rejected', async () => {
    const ws = await wsConnect(port, { 'x-test-ctx': 'read-agent' });
    ws.send(JSON.stringify({ t: 'open', docId: mainDocId }));
    const doc = await nextMessage(ws);
    expect(doc.t).toBe('doc');

    ws.send(
      JSON.stringify({
        t: 'patch',
        docId: mainDocId,
        patchId: 'px',
        baseRev: doc.rev,
        label: 'Denied',
        ops: [{ op: 'replace', path: ['name'], value: 'nope' }],
      }),
    );
    const reject = await nextMessage(ws);
    expect(reject.t).toBe('reject');
    expect(reject.patchId).toBe('px');
    expect(reject.reason).toContain('read-only');
    expect(app.store.get(mainDocId)!.doc.name).not.toBe('nope');
    ws.close();
  });

  it('WS: share ctx cannot open a document outside its scope', async () => {
    const ws = await wsConnect(port, { 'x-test-ctx': 'share' });
    ws.send(JSON.stringify({ t: 'open', docId: mainDocId }));
    const err = await nextMessage(ws);
    expect(err.t).toBe('error');
    expect(String(err.message)).toContain('out of scope');
    ws.close();
  });
});
