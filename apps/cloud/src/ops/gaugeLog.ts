import type { Pool } from 'pg';
import type { WorkspaceManager } from '../cloud/workspaceManager.js';
import { collectMetrics } from './metrics.js';

/**
 * Structured gauge logging. Emits one line —
 *   `[pitolet-cloud] gauges {json}`
 * — that a log pipeline (or `docker compose logs app | grep gauges`) can
 * scrape without a metrics backend. Called on a timer and once on SIGTERM so
 * the last line captures the final resident state before flush.
 */

/** Emit a single gauge line to stdout. */
export function logGauges(manager: WorkspaceManager, pool: Pool): void {
  console.log(`[pitolet-cloud] gauges ${JSON.stringify(collectMetrics(manager, pool))}`);
}

export interface GaugeLoggerOptions {
  /** Emit cadence (default 5 min). Tests inject a short value. */
  intervalMs?: number;
  /** Injectable emitter (tests capture instead of hitting the timer/console). */
  emit?: () => void;
}

/**
 * Start the periodic gauge logger. The interval is `unref`'d so it never
 * keeps the process alive on its own. Returns a stop() that clears it.
 */
export function startGaugeLogger(
  manager: WorkspaceManager,
  pool: Pool,
  options: GaugeLoggerOptions = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  const emit = options.emit ?? (() => logGauges(manager, pool));
  const timer = setInterval(emit, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
