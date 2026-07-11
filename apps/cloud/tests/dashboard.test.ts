import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, ensureAuthSchema, type CloudAuth } from '../src/auth/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { createCloudServer, type CloudServer } from '../src/server.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

/**
 * Dashboard SPA serving. A fixture dashboardDist (stub index.html) keeps this
 * deterministic and fast — no vite build in the test path. Asserts:
 *   1. GET / serves the dashboard index.html when dashboardDist exists.
 *   2. Client routes (/settings/:id) fall back to index.html.
 *   3. /api/* and /w/* keep priority over the SPA fallback (a signed-out
 *      /api/me is 401 JSON, not the SPA; /w/x/ is 401, not the SPA).
 */

const DASHBOARD_SENTINEL =
  '<!doctype html><title>pitolet-dashboard-sentinel</title><div id="root"></div>';
const EDITOR_SENTINEL = '<!doctype html><title>pitolet-editor-sentinel</title>';

let pgi: EphemeralPg;
let cloud: CloudServer;
let auth: CloudAuth;
let dataRoot: string;
let dashboardDist: string;
let editorDist: string;
let base: string;
let port: number;

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

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-dash-'));
  dashboardDist = mkdtempSync(join(tmpdir(), 'pitolet-cloud-dashdist-'));
  editorDist = mkdtempSync(join(tmpdir(), 'pitolet-cloud-dash-editor-'));
  writeFileSync(join(dashboardDist, 'index.html'), DASHBOARD_SENTINEL);
  writeFileSync(join(dashboardDist, 'app.js'), 'console.log("dash")');
  writeFileSync(join(editorDist, 'index.html'), EDITOR_SENTINEL);

  pgi = await startEphemeralPg('pitolet_dashboard');
  await runMigrations(pgi.pool);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const authConfig = { pool: pgi.pool, baseURL: base, secret: 'dashboard-test-secret' };
  await ensureAuthSchema(authConfig);
  auth = createAuth(authConfig);

  cloud = createCloudServer({ pool: pgi.pool, auth, dataRoot, editorDist, dashboardDist });
  await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));
}, 180_000);

afterAll(async () => {
  await cloud?.close();
  await pgi?.stop();
  for (const dir of [dataRoot, dashboardDist, editorDist]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dashboard SPA serving', () => {
  it('serves the dashboard index.html at /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(DASHBOARD_SENTINEL);
  });

  it('serves real assets from the dashboard dist', async () => {
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('dash');
  });

  it('falls back to index.html for client routes like /settings/:id', async () => {
    const res = await fetch(`${base}/settings/some-workspace-id`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DASHBOARD_SENTINEL);
  });

  it('falls back to index.html for the /docs/:id client route', async () => {
    const res = await fetch(`${base}/docs/some-workspace-id`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DASHBOARD_SENTINEL);
  });

  it('keeps /api/* priority over the SPA fallback (401 JSON, not HTML)', async () => {
    const res = await fetch(`${base}/api/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()) as { error: string }).toEqual({ error: 'unauthorized' });
  });

  it('keeps /w/* priority over the SPA fallback (401, not the dashboard HTML)', async () => {
    const res = await fetch(`${base}/w/anything/`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('pitolet-dashboard-sentinel');
  });

  it('does not serve the SPA for non-GET methods on unknown paths', async () => {
    const res = await fetch(`${base}/settings/x`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('public editor assets (share-guest subresources)', () => {
  beforeAll(() => {
    // A real asset file in the editorDist fixture.
    mkdirSync(join(editorDist, 'assets'), { recursive: true });
    writeFileSync(join(editorDist, 'assets', 'app.js'), 'console.log("editor")');
  });

  it('serves app bundle assets WITHOUT auth (guest subresource loads)', async () => {
    const res = await fetch(`${base}/w/any-slug/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('editor');
  });

  it('serves identical bytes for nonexistent workspaces — no existence oracle', async () => {
    const real = await fetch(`${base}/w/real-or-not/assets/app.js`);
    const fake = await fetch(`${base}/w/definitely-not-a-workspace/assets/app.js`);
    expect(real.status).toBe(200);
    expect(fake.status).toBe(200);
    expect(await real.text()).toBe(await fake.text());
  });

  it('missing assets 404 without falling back to the auth-gated shell', async () => {
    const res = await fetch(`${base}/w/any-slug/assets/nope.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('sentinel');
  });

  it('keeps every data surface gated: shell, assets-store, api', async () => {
    const shell = await fetch(`${base}/w/any-slug/`, { redirect: 'manual' });
    expect([301, 302, 401, 404]).toContain(shell.status);
    expect(shell.status).not.toBe(200);
    // Dotted filename under a runtime-owned prefix must NOT hit the public path.
    const stored = await fetch(`${base}/w/any-slug/assets-store/abc123.png`);
    expect(stored.status).toBe(401);
    const api = await fetch(`${base}/w/any-slug/api/documents`);
    expect(api.status).toBe(401);
  });
});
