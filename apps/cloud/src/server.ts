import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createAuth, ensureAuthSchema, type CloudAuth } from './auth/auth.js';
import {
  loadPaddleConfig,
  reconcilePaddleSubscriptions,
  type PaddleConfig,
} from './billing/paddle.js';
import type { Plan } from './cloud/plans.js';
import { WorkspaceManager, type WorkspaceManagerOptions } from './cloud/workspaceManager.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import {
  captureException,
  flushErrorTracking,
  initErrorTracking,
} from './ops/errorTracking.js';
import { logGauges, startGaugeLogger } from './ops/gaugeLog.js';
import { handleMetricsRequest } from './ops/metrics.js';
import { createCloudRouter } from './router.js';

/**
 * Pitolet Cloud — one http.Server hosting auth, the dashboard API, and
 * every tenant's workspace under /w/:slug/. See router.ts for the
 * security-boundary rules.
 */

export interface CloudServerOptions {
  pool: Pool;
  auth: CloudAuth;
  dataRoot: string;
  editorDist?: string | null;
  dashboardDist?: string | null;
  manager?: WorkspaceManagerOptions;
  /**
   * Paddle billing config. undefined = read from env (production boot);
   * null = explicitly disabled (tests, self-host).
   */
  billing?: PaddleConfig | null;
  /** Injectable clock for rate limiters / plan buckets (tests). */
  clock?: () => number;
}

export interface CloudServer {
  server: http.Server;
  manager: WorkspaceManager;
  /** Push a committed plan change into live runtimes + router caches. */
  onPlanChanged(workspaceId: string, plan: Plan): void;
  /** Flush workspaces, stop the sweeper, close the listener. */
  close(): Promise<void>;
}

/** Locate the built editor SPA: env override → workspace package → monorepo path. */
export function resolveEditorDist(): string | null {
  if (process.env.PITOLET_EDITOR_DIST) return process.env.PITOLET_EDITOR_DIST;
  try {
    const req = createRequire(import.meta.url);
    const dist = join(dirname(req.resolve('@pitolet/editor/package.json')), 'dist');
    if (existsSync(join(dist, 'index.html'))) return dist;
  } catch {
    // not installed as a package — fall through to the monorepo layout
  }
  const monorepo = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../packages/editor/dist',
  );
  return existsSync(join(monorepo, 'index.html')) ? monorepo : null;
}

/** Locate the built dashboard SPA (apps/cloud/dashboard/dist). */
export function resolveDashboardDist(): string | null {
  if (process.env.PITOLET_DASHBOARD_DIST) return process.env.PITOLET_DASHBOARD_DIST;
  // src/ → ../dashboard/dist. When compiled to dist/ the layout is dist/ →
  // ../dashboard/dist, so both source (tsx) and built (node) runs resolve it.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '../dashboard/dist'),
    join(here, '../../dashboard/dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function createCloudServer(options: CloudServerOptions): CloudServer {
  const manager = new WorkspaceManager(options.pool, options.dataRoot, {
    clock: options.clock,
    ...options.manager,
  });
  const router = createCloudRouter({
    pool: options.pool,
    auth: options.auth,
    manager,
    editorDist: options.editorDist === undefined ? resolveEditorDist() : options.editorDist,
    dashboardDist:
      options.dashboardDist === undefined ? resolveDashboardDist() : options.dashboardDist,
    billing: options.billing === undefined ? loadPaddleConfig() : options.billing,
    clock: options.clock,
  });

  const server = http.createServer((req, res) => {
    // Ops metrics is infrastructure, not tenant surface — it owns this route
    // ahead of the router. Returns true when it has answered the request.
    if (handleMetricsRequest(req, res, manager, options.pool)) return;
    router.handleRequest(req, res).catch((err) => {
      console.error('[pitolet-cloud] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    });
  });
  server.on('upgrade', (req, socket, head) => router.handleUpgrade(req, socket, head));

  return {
    server,
    manager,
    onPlanChanged: router.onPlanChanged,
    async close() {
      await manager.shutdown();
      await new Promise<void>((res, rej) =>
        server.close((err) => (err ? rej(err) : res())),
      );
    },
  };
}

/**
 * Wire process-level error capture. Process-level ONLY — request paths keep
 * their own try/catch; wrapping them would be too invasive. A caught
 * 'uncaughtException' leaves the process in an untrustworthy state, so we
 * capture, flush the tracker for up to 2s, then exit 1. An
 * 'unhandledRejection' is captured and logged but left running.
 *
 * Exported so tests can assert the handlers are registered without crashing
 * the test process. `exit` is injectable for the same reason.
 */
export function installProcessErrorHandlers(
  proc: NodeJS.Process = process,
  exit: (code: number) => void = (code) => process.exit(code),
): { onUncaught: NodeJS.UncaughtExceptionListener; onRejection: (reason: unknown) => void } {
  const onRejection = (reason: unknown): void => {
    console.error('[pitolet-cloud] unhandledRejection:', reason);
    captureException(reason);
  };
  const onUncaught: NodeJS.UncaughtExceptionListener = (err) => {
    console.error('[pitolet-cloud] uncaughtException:', err);
    captureException(err);
    // Give the tracker a 2s flush window, then exit — process state is no
    // longer trustworthy.
    void flushErrorTracking(2000).finally(() => exit(1));
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onUncaught);
  return { onUncaught, onRejection };
}

function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[pitolet-cloud] ${name} is required.${hint ? ` ${hint}` : ''}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL', 'e.g. postgresql://user@host:5432/pitolet');
  const secret = requireEnv(
    'BETTER_AUTH_SECRET',
    'Generate one: openssl rand -base64 32',
  );
  const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:8080';
  const port = Number(process.env.PITOLET_CLOUD_PORT ?? 8080);
  const dataRoot = resolve(process.env.PITOLET_CLOUD_DATA ?? './cloud-data');

  const pool = createPool(databaseUrl);
  const auth = createAuth({ pool, baseURL, secret });

  // App schema first (001 drops the legacy users table in 002), then
  // better-auth's own tables. Both are idempotent.
  await runMigrations(pool);
  await ensureAuthSchema({ pool, baseURL, secret });

  // Error tracking first so process-level handlers below can report. No-op
  // unless SENTRY_DSN is set and @sentry/node is installed.
  await initErrorTracking();

  const billing = loadPaddleConfig();
  const cloud = createCloudServer({ pool, auth, dataRoot, billing });
  await new Promise<void>((res) => cloud.server.listen(port, res));
  console.log(`[pitolet-cloud] listening on :${port} (data root ${dataRoot})`);

  // Periodic operational gauge line (unref'd) + a final one on shutdown.
  const gaugeLogger = startGaugeLogger(cloud.manager, pool);

  if (billing) {
    console.log(`[pitolet-cloud] billing enabled (paddle ${billing.env})`);
    // Reconcile against the Paddle API on boot and daily thereafter —
    // webhooks get lost; the API is the truth. Never crashes the server.
    const runReconcile = () =>
      reconcilePaddleSubscriptions(pool, billing, {
        onPlanChanged: (id, plan) => cloud.onPlanChanged(id, plan),
      }).catch((err) => console.error('[pitolet-cloud] paddle reconcile failed:', err));
    void runReconcile();
    setInterval(runReconcile, 24 * 60 * 60 * 1000).unref();
  } else {
    console.log('[pitolet-cloud] billing disabled (no Paddle env) — all workspaces stay free');
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Final gauge snapshot before we tear down — the last line in the log
    // shows what was resident at shutdown.
    logGauges(cloud.manager, pool);
    gaugeLogger.stop();
    console.log(`[pitolet-cloud] ${signal} — flushing workspaces…`);
    void cloud
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[pitolet-cloud] shutdown failed:', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  installProcessErrorHandlers();
}

// CLI entry: `tsx src/server.ts` (later `node dist/server.js`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[pitolet-cloud] boot failed:', err);
    process.exit(1);
  });
}
