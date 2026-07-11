import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { WorkspaceManager } from '../cloud/workspaceManager.js';

/**
 * In-process operational gauges. A cheap point-in-time snapshot of the
 * things that page you at 3am: how many workspaces are resident, how many
 * live editor sockets, process memory, and the Postgres pool's saturation.
 *
 * No histograms, no Prometheus exposition format — this is a single JSON
 * object polled by `GET /internal/metrics` and logged periodically. Keep it
 * allocation-light: it runs on a timer and on the shutdown path.
 */
export interface MetricsSnapshot {
  loadedWorkspaces: number;
  wsClients: number;
  rssBytes: number;
  heapUsedBytes: number;
  uptimeSeconds: number;
  pgPoolTotal: number;
  pgPoolIdle: number;
  pgPoolWaiting: number;
}

/** Read a gauge snapshot. Pure read — never mutates manager/pool state. */
export function collectMetrics(manager: WorkspaceManager, pool: Pool): MetricsSnapshot {
  const mem = process.memoryUsage();
  return {
    loadedWorkspaces: manager.loadedCount(),
    wsClients: manager.totalClientCount(),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    uptimeSeconds: Math.round(process.uptime()),
    // pg exposes these as public counters on the Pool.
    pgPoolTotal: pool.totalCount,
    pgPoolIdle: pool.idleCount,
    pgPoolWaiting: pool.waitingCount,
  };
}

/**
 * Handle `GET /internal/metrics`. Infrastructure, not tenant surface — wired
 * in server.ts ahead of the router. Auth model: Caddy proxies everything, so
 * loopback binding is meaningless; instead we gate on a shared secret.
 *
 *   - token unset  → 404 (dev default: the endpoint doesn't exist)
 *   - token set    → require `Authorization: Bearer <token>`, else 401
 *
 * Returns true if it handled the request (route matched), false to let the
 * caller fall through to the normal dispatch.
 */
export function handleMetricsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: WorkspaceManager,
  pool: Pool,
  token: string | undefined = process.env.PITOLET_METRICS_TOKEN,
): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/internal/metrics') return false;

  // Endpoint is invisible unless an operator opted in with a token.
  if (!token) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }

  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return true;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(collectMetrics(manager, pool)));
  return true;
}
