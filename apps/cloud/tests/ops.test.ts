import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth, ensureAuthSchema, type CloudAuth } from '../src/auth/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { collectMetrics } from '../src/ops/metrics.js';
import { startGaugeLogger } from '../src/ops/gaugeLog.js';
import { createCloudServer, installProcessErrorHandlers, type CloudServer } from '../src/server.js';
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
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
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

describe('liveness and readiness', () => {
  it('reports process liveness without operational details', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reports ready only after a successful database round-trip', async () => {
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
  it('registers fatal uncaughtException + unhandledRejection listeners', async () => {
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

    const exit = vi.fn();
    const { onUncaught, onRejection } = installProcessErrorHandlers(fakeProc, exit);

    expect(listeners.uncaughtException).toContain(onUncaught);
    expect(listeners.unhandledRejection).toContain(onRejection);
    // The callback itself never throws; it flushes tracking and then exits.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => onRejection(new Error('boom'))).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
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

describe('graceful shutdown ordering', () => {
  it('stops ingress and drains an active request before closing workspace storage', async () => {
    const shutdownPort = await freePort();
    const shutdownBase = `http://127.0.0.1:${shutdownPort}`;
    const originalQuery = pgi.pool.query.bind(pgi.pool) as (
      text: string,
      values?: unknown[],
    ) => ReturnType<typeof pgi.pool.query>;
    const delayedPool = Object.create(pgi.pool) as typeof pgi.pool;
    let releaseQuery!: () => void;
    let queryStarted!: () => void;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    let delayReadiness = true;
    delayedPool.query = ((text: string, values?: unknown[]) => {
      if (delayReadiness && text.includes('schema_migrations')) {
        delayReadiness = false;
        queryStarted();
        return queryGate.then(() => originalQuery(text, values));
      }
      return originalQuery(text, values);
    }) as typeof pgi.pool.query;

    const shuttingDownCloud = createCloudServer({
      pool: delayedPool,
      auth,
      dataRoot: join(dataRoot, 'shutdown-order'),
      editorDist: null,
      dashboardDist: null,
      billing: null,
    });
    await new Promise<void>((resolve) =>
      shuttingDownCloud.server.listen(shutdownPort, '127.0.0.1', resolve),
    );
    const shutdownSpy = vi.spyOn(shuttingDownCloud.manager, 'shutdown');

    try {
      const activeResponse = fetch(`${shutdownBase}/readyz`);
      await started;

      const closePromise = shuttingDownCloud.close();
      expect(shuttingDownCloud.server.listening).toBe(false);
      expect(shutdownSpy).not.toHaveBeenCalled();

      releaseQuery();
      const response = await activeResponse;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      await closePromise;
      expect(shutdownSpy).toHaveBeenCalledOnce();
    } finally {
      releaseQuery();
      await shuttingDownCloud.close();
    }
  });
});
