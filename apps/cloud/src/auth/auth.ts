import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { magicLink } from 'better-auth/plugins/magic-link';
import type { Pool } from 'pg';

/**
 * better-auth wiring for Pitolet Cloud.
 *
 * Identity decision: better-auth's `user` table is CANONICAL. The app-level
 * `users` table from migration 001 was dropped in 002; memberships.user_id
 * is text and stores better-auth user ids directly.
 *
 * Schema: better-auth manages its own tables (user/session/account/
 * verification) via its programmatic migrator — see ensureAuthSchema().
 * Application tables stay in src/db/migrations/*.sql.
 */

export interface CloudAuthConfig {
  pool: Pool;
  /** Public origin, e.g. https://pitolet.com (env BETTER_AUTH_URL). */
  baseURL: string;
  /** Signing secret (env BETTER_AUTH_SECRET). */
  secret: string;
}

export type CloudAuth = ReturnType<typeof createAuth>;

/**
 * Magic-link delivery. Production (RESEND_API_KEY set): POST to Resend —
 * I6 fills in the template/domain; the transport is already correct.
 * Otherwise: log the URL (local dev / tests).
 */
async function sendMagicLinkEmail(data: { email: string; url: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[pitolet-cloud] magic link for ${data.email}: ${data.url}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? 'Pitolet <login@pitolet.com>',
      to: [data.email],
      subject: 'Sign in to Pitolet',
      text: `Click to sign in: ${data.url}\n\nThis link expires in 5 minutes. If you didn't request it, ignore this email.`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend rejected magic-link email: ${res.status} ${await res.text()}`);
  }
}

/** Social providers register ONLY when their env credentials exist. */
function socialProviders(): BetterAuthOptions['socialProviders'] {
  const providers: NonNullable<BetterAuthOptions['socialProviders']> = {};
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  return providers;
}

function buildOptions(config: CloudAuthConfig) {
  return {
    // Kysely wraps the shared pg Pool — one pool for auth + app queries.
    database: config.pool,
    baseURL: config.baseURL,
    // The auth handler mounts at /auth/* on the cloud server (not the
    // better-auth default /api/auth).
    basePath: '/auth',
    secret: config.secret,
    emailAndPassword: { enabled: true },
    // Login/auth endpoint rate limiting is better-auth's built-in limiter
    // (per-IP windows + stricter per-path rules for sign-in). Its default is
    // enabled-only-when-NODE_ENV=production; pin it to the deployment shape
    // instead (public https origin ⇒ production) so a missing NODE_ENV can't
    // silently disable brute-force protection. Local dev / tests (http
    // baseURL) keep it off.
    rateLimit: { enabled: config.baseURL.startsWith('https://') },
    plugins: [magicLink({ sendMagicLink: sendMagicLinkEmail })],
    socialProviders: socialProviders(),
    // Session cookies: better-auth defaults are httpOnly + SameSite=Lax;
    // the Secure flag follows the baseURL protocol (https → secure), which
    // is correct behind a TLS-terminating proxy as long as BETTER_AUTH_URL
    // is the public https origin.
    trustedOrigins: [config.baseURL],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: CloudAuthConfig) {
  return betterAuth(buildOptions(config));
}

/**
 * Create/upgrade better-auth's own tables (user, session, account,
 * verification) via its programmatic migration API. Idempotent — call at
 * boot (after our SQL migrations) and from tests.
 */
export async function ensureAuthSchema(config: CloudAuthConfig): Promise<void> {
  const { runMigrations } = await getMigrations(buildOptions(config));
  await runMigrations();
}
