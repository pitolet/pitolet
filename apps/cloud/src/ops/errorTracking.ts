import { createRequire } from 'node:module';

/**
 * Optional, Sentry-compatible error tracking.
 *
 * The client ships in the production image, but is loaded only when a DSN is
 * configured. A configured tracker that cannot initialise is a boot error:
 * silently dropping production exceptions would make the setting misleading.
 */

export interface ErrorTrackingClient {
  init: (options: {
    dsn: string;
    release?: string;
    environment?: string;
    sendDefaultPii: boolean;
  }) => void;
  captureException: (err: unknown) => void;
  close: (timeout?: number) => Promise<boolean>;
}

let sentry: ErrorTrackingClient | null = null;

/** Read this package's version for the Sentry release tag. */
function readRelease(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ? `pitolet-cloud@${pkg.version}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Initialise error tracking when `SENTRY_DSN` (env or arg) is set. Safe to call
 * once at boot. Returns true when tracking is live.
 */
export async function initErrorTracking(
  dsn: string | undefined = process.env.SENTRY_DSN,
  loadClient: () => Promise<ErrorTrackingClient> = async () => import('@sentry/node'),
): Promise<boolean> {
  if (!dsn?.trim()) return false;
  try {
    const client = await loadClient();
    client.init({
      dsn: dsn.trim(),
      release: readRelease(),
      environment: process.env.NODE_ENV,
      sendDefaultPii: false,
    });
    sentry = client;
    console.log('[pitolet-cloud] error tracking enabled (Sentry-compatible DSN)');
    return true;
  } catch (err) {
    sentry = null;
    throw new Error('SENTRY_DSN is set but error tracking failed to initialise', {
      cause: err,
    });
  }
}

/** Report an exception to the tracker. No-op when tracking is not configured. */
export function captureException(err: unknown): void {
  sentry?.captureException(err);
}

/**
 * Give the tracker a window to flush buffered events before the process
 * exits. Resolves immediately (no wait) when tracking is off.
 */
export async function flushErrorTracking(timeoutMs = 2000): Promise<void> {
  if (!sentry) return;
  try {
    await sentry.close(timeoutMs);
  } catch {
    // best-effort on the exit path
  }
}

/** Test-only: reset module state between cases. */
export function __resetErrorTrackingForTests(): void {
  sentry = null;
}
