import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth, ensureAuthSchema, type CloudAuth } from '../src/auth/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { collectMetrics } from '../src/ops/metrics.js';
import { startGaugeLogger } from '../src/ops/gaugeLog.js';
import {
  createCloudServer,
  installProcessErrorHandlers,
  type CloudServer,
} from '../src/server.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

/**
 * Operational monitoring. Boots a real cloud server against an ephemeral
 * Postgres and exercises:
 *   - GET /internal/metrics auth model (404 off / 401 wrong bearer / 200 ok)
 *   - the gauge snapshot shape
 *   - the periodic gauge logger (injectable short interval + captured emit)
 *   - process-level uncaughtException handler is wired at boot
 *
 * The metrics token is read from env in server.ts, so we set/unset
 * PITOLET_METRICS_TOKEN around the cases rather than passing it in.
 */

let pgi: EphemeralPg;
let cloud: CloudServer;
let auth: CloudAuth;
let dataRoot: string;
let base: string;
let port: number;

const TOKEN = 'test-metrics-token-abc123';

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
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-ops-'));
  pgi = await startEphemeralPg('pitolet_ops');
  await runMigrations(pgi.pool);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const authConfig = { pool: pgi.pool, baseURL: base, secret: 'ops-test-secret' };
  await ensureAuthSchema(authConfig);
  auth = createAuth(authConfig);

  // editorDist/dashboardDist null so no build is needed in this test path.
  cloud = createCloudServer({
    pool: pgi.pool,
    auth,
    dataRoot,
    editorDist: null,
    dashboardDist: null,
    billing: null,
  });
  await new Promise<void>((resolve) => cloud.server.listen(port, '127.0.0.1', resolve));
}, 180_000);

afterAll(async () => {
  delete process.env.PITOLET_METRICS_TOKEN;
  await cloud?.close();
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('GET /internal/metrics auth', () => {
  it('404s when PITOLET_METRICS_TOKEN is unset (endpoint off)', async () => {
    delete process.env.PITOLET_METRICS_TOKEN;
    const res = await fetch(`${base}/internal/metrics`);
    expect(res.status).toBe(404);
  });

  it('401s with a wrong bearer token when the token is set', async () => {
    process.env.PITOLET_METRICS_TOKEN = TOKEN;
    const res = await fetch(`${base}/internal/metrics`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
    delete process.env.PITOLET_METRICS_TOKEN;
  });

  it('401s with no Authorization header when the token is set', async () => {
    process.env.PITOLET_METRICS_TOKEN = TOKEN;
    const res = await fetch(`${base}/internal/metrics`);
    expect(res.status).toBe(401);
    delete process.env.PITOLET_METRICS_TOKEN;
  });

  it('200s with a sane gauge shape given the correct token', async () => {
    process.env.PITOLET_METRICS_TOKEN = TOKEN;
    const res = await fetch(`${base}/internal/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, number>;
    expect(typeof body.loadedWorkspaces).toBe('number');
    expect(typeof body.wsClients).toBe('number');
    expect(body.rssBytes).toBeGreaterThan(0);
    expect(body.heapUsedBytes).toBeGreaterThan(0);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.pgPoolTotal).toBe('number');
    expect(typeof body.pgPoolIdle).toBe('number');
    expect(typeof body.pgPoolWaiting).toBe('number');
    delete process.env.PITOLET_METRICS_TOKEN;
  });
});

describe('collectMetrics snapshot', () => {
  it('reports loadedWorkspaces as a number and rssBytes > 0', () => {
    const snap = collectMetrics(cloud.manager, pgi.pool);
    expect(typeof snap.loadedWorkspaces).toBe('number');
    expect(snap.loadedWorkspaces).toBeGreaterThanOrEqual(0);
    expect(snap.rssBytes).toBeGreaterThan(0);
    expect(snap.wsClients).toBeGreaterThanOrEqual(0);
  });
});

describe('periodic gauge logger', () => {
  it('fires on the injected interval', async () => {
    const emit = vi.fn();
    const logger = startGaugeLogger(cloud.manager, pgi.pool, { intervalMs: 5, emit });
    // Wait a few intervals then assert it fired at least once.
    await new Promise((r) => setTimeout(r, 40));
    logger.stop();
    expect(emit.mock.calls.length).toBeGreaterThan(0);
  });

  it('default emit writes a `[pitolet-cloud] gauges` line via console.log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = startGaugeLogger(cloud.manager, pgi.pool, { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    logger.stop();
    // Capture the recorded calls BEFORE restoring the spy (restore clears them).
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('gauges'));
    spy.mockRestore();
    expect(line).toBeTruthy();
    expect(line).toContain('[pitolet-cloud] gauges');
    expect(line).toContain('loadedWorkspaces');
  });
});

describe('process-level error handlers', () => {
  it('registers uncaughtException + unhandledRejection listeners (server.ts wiring)', () => {
    // Use the real server.ts wiring, but against a fake process object so the
    // test process is never actually crashed. installProcessErrorHandlers is
    // what main() calls at boot.
    const listeners: Record<string, unknown[]> = {};
    const fakeProc = {
      on(event: string, fn: unknown) {
        (listeners[event] ??= []).push(fn);
        return fakeProc;
      },
    } as unknown as NodeJS.Process;

    const { onUncaught, onRejection } = installProcessErrorHandlers(fakeProc, () => {});

    expect(listeners.uncaughtException).toContain(onUncaught);
    expect(listeners.unhandledRejection).toContain(onRejection);
    // Calling the rejection handler must not throw or exit (silence its log).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => onRejection(new Error('boom'))).not.toThrow();
    errSpy.mockRestore();
  });

  it('applies to the real process at boot (main wires it on the live process)', () => {
    // Sanity: registering on the real process adds a listener and can be
    // cleanly removed — we do NOT throw to trigger it.
    const before = process.listeners('uncaughtException').length;
    const { onUncaught, onRejection } = installProcessErrorHandlers(process, () => {});
    expect(process.listeners('uncaughtException')).toContain(onUncaught);
    expect(process.listeners('uncaughtException').length).toBe(before + 1);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  });
});
