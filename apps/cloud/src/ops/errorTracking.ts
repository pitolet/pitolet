import { createRequire } from 'node:module';

/**
 * Optional, Sentry-compatible error tracking.
 *
 * `@sentry/node` is deliberately NOT a dependency of this package. Self-hosters
 * and ops who want error reporting opt in by installing it themselves
 * (`pnpm add @sentry/node`) and setting `SENTRY_DSN`. Any Sentry-DSN-compatible
 * backend works — e.g. GlitchTip. When the package isn't present, or no DSN is
 * configured, every export is a silent no-op.
 *
 * The dynamic import mirrors the OSS Playwright guard in
 * packages/server/src/mcp/tools.ts: an indirect variable specifier plus
 * `/* @vite-ignore *\/` so bundlers don't try to resolve the optional module at
 * build time, wrapped in try/catch so a missing package degrades gracefully.
 */

interface SentryLike {
  init: (options: { dsn: string; release?: string }) => void;
  captureException: (err: unknown) => void;
  close: (timeout?: number) => Promise<boolean>;
}

let sentry: SentryLike | null = null;

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
 * Initialise error tracking if `SENTRY_DSN` (env or arg) is set AND the
 * optional `@sentry/node` package is installed. Idempotent-ish: safe to call
 * once at boot. Returns true when tracking is live.
 */
export async function initErrorTracking(
  dsn: string | undefined = process.env.SENTRY_DSN,
): Promise<boolean> {
  if (!dsn) return false;
  try {
    // Indirect specifier + @vite-ignore: keep bundlers from resolving an
    // intentionally-absent optional dependency.
    const specifier = '@sentry/node';
    const mod = (await import(/* @vite-ignore */ specifier)) as SentryLike;
    mod.init({ dsn, release: readRelease() });
    sentry = mod;
    console.log('[pitolet-cloud] error tracking enabled (Sentry-compatible DSN)');
    return true;
  } catch (err) {
    console.error(
      '[pitolet-cloud] SENTRY_DSN is set but @sentry/node is not installed — ' +
        'error tracking disabled. Install it to opt in: pnpm add @sentry/node',
      err instanceof Error ? err.message : err,
    );
    return false;
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
