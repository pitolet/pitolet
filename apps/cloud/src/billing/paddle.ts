import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { planOf, type Plan } from '../cloud/plans.js';

/**
 * Paddle Billing (the modern API, not Classic) — deliberately SDK-free:
 * webhook signature verification, idempotent event processing, and a daily
 * reconcile sweep are ~3 endpoints of surface.
 *
 * MONEY-PATH INVARIANTS:
 *   1. A webhook only mutates state after HMAC verification against the RAW
 *      request bytes (router captures them before any JSON parse).
 *   2. webhook_events is the idempotency ledger: an event_id is applied at
 *      most once, ever (INSERT … ON CONFLICT DO NOTHING gates the txn).
 *   3. Out-of-order delivery cannot regress a subscription: an event older
 *      than subscriptions.updated_at is recorded but not applied.
 *   4. A verified webhook is never answered 5xx for data reasons (unknown
 *      workspace, unhandled type) — Paddle would retry forever.
 */

export interface PaddleConfig {
  apiKey: string;
  webhookSecret: string;
  priceIdPro: string;
  env: 'sandbox' | 'production';
  apiBase: string;
}

const API_BASES = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
} as const;

const REQUIRED_ENV = [
  'PADDLE_API_KEY',
  'PADDLE_WEBHOOK_SECRET',
  'PADDLE_PRICE_ID_PRO',
  'PADDLE_ENV',
] as const;

/**
 * Billing config from env; null = billing disabled (dev / self-host): the
 * webhook route 404s, reconcile never runs, all workspaces stay 'free'.
 * Partial env is a deploy mistake — warn loudly, then stay disabled rather
 * than half-run the money path.
 */
export function loadPaddleConfig(env: NodeJS.ProcessEnv = process.env): PaddleConfig | null {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length === REQUIRED_ENV.length) return null;
  if (missing.length > 0) {
    console.warn(
      `[pitolet-cloud] billing DISABLED: partial Paddle env (missing ${missing.join(', ')})`,
    );
    return null;
  }
  const paddleEnv = env.PADDLE_ENV;
  if (paddleEnv !== 'sandbox' && paddleEnv !== 'production') {
    console.warn(
      `[pitolet-cloud] billing DISABLED: PADDLE_ENV must be 'sandbox' or 'production' (got '${paddleEnv}')`,
    );
    return null;
  }
  return {
    apiKey: env.PADDLE_API_KEY!,
    webhookSecret: env.PADDLE_WEBHOOK_SECRET!,
    priceIdPro: env.PADDLE_PRICE_ID_PRO!,
    env: paddleEnv,
    apiBase: API_BASES[paddleEnv],
  };
}

/** All required Paddle env present (and PADDLE_ENV valid)? */
export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    REQUIRED_ENV.every((name) => Boolean(env[name])) &&
    (env.PADDLE_ENV === 'sandbox' || env.PADDLE_ENV === 'production')
  );
}

// ---------------------------------------------------------------------------
// Webhook signature verification (security-critical)
// ---------------------------------------------------------------------------

/** Reject webhooks whose Paddle timestamp is outside ±5 minutes (replays). */
const REPLAY_WINDOW_MS = 5 * 60_000;

/**
 * Verify a Paddle-Signature header (`ts=<unix-seconds>;h1=<hex>`) against the
 * RAW request body bytes. Signed payload is `${ts}:${rawBody}`, MAC is
 * HMAC-SHA256 with the webhook secret, compared via timingSafeEqual. Multiple
 * h1 values (secret rotation) are each tried.
 */
export function verifyPaddleSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!header) return false;
  let ts: string | undefined;
  const macs: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return false;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'h1') macs.push(value);
    // Unknown keys (future scheme versions) are ignored, not fatal.
  }
  if (!ts || !/^\d{1,12}$/.test(ts) || macs.length === 0) return false;

  // Replay window: |now - ts| > 5 min ⇒ reject even with a valid MAC.
  const tsMs = Number(ts) * 1000;
  if (Math.abs(nowMs - tsMs) > REPLAY_WINDOW_MS) return false;

  // HMAC-SHA256(secret, `${ts}:${rawBody}`) over the raw BYTES — computing
  // from a re-serialized JSON parse would silently accept forgeries.
  const expected = createHmac('sha256', secret)
    .update(ts)
    .update(':')
    .update(rawBody)
    .digest();
  for (const mac of macs) {
    if (!/^[0-9a-f]{64}$/i.test(mac)) continue;
    const provided = Buffer.from(mac, 'hex');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

/** Callback surface for pushing a plan change into live runtimes. */
export interface PlanChangeListener {
  onPlanChanged(workspaceId: string, plan: Plan): void;
}

export type WebhookOutcome =
  | { status: 'processed'; workspaceId: string; plan: Plan }
  | { status: 'duplicate' }
  | { status: 'stale' } // out-of-order: older than the subscription row
  | { status: 'unknown-workspace' }
  | { status: 'ignored-event-type' }
  | { status: 'invalid' }; // structurally malformed (router answers 400)

/** Subscription lifecycle events we apply. Everything else is ledger-only. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.trialing',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
]);

/** Paddle statuses that grant the pro plan. */
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  subscriptionId: string | null;
  customerId: string | null;
  status: string;
  currentPeriodEnd: string | null;
  workspaceId: string | null;
}

function parseEvent(payload: unknown): ParsedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const eventId = p.event_id;
  const eventType = p.event_type;
  const occurredAt = p.occurred_at;
  if (typeof eventId !== 'string' || !eventId) return null;
  if (typeof eventType !== 'string' || !eventType) return null;
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) return null;
  const data = (typeof p.data === 'object' && p.data !== null ? p.data : {}) as Record<
    string,
    unknown
  >;
  const customData = (
    typeof data.custom_data === 'object' && data.custom_data !== null ? data.custom_data : {}
  ) as Record<string, unknown>;
  const period = (
    typeof data.current_billing_period === 'object' && data.current_billing_period !== null
      ? data.current_billing_period
      : {}
  ) as Record<string, unknown>;
  const periodEnd = period.ends_at;
  return {
    eventId,
    eventType,
    occurredAt,
    subscriptionId: typeof data.id === 'string' ? data.id : null,
    customerId: typeof data.customer_id === 'string' ? data.customer_id : null,
    status: typeof data.status === 'string' ? data.status : 'unknown',
    currentPeriodEnd:
      typeof periodEnd === 'string' && !Number.isNaN(Date.parse(periodEnd)) ? periodEnd : null,
    workspaceId: typeof customData.workspaceId === 'string' ? customData.workspaceId : null,
  };
}

/**
 * Apply one verified webhook payload. Ledger insert, out-of-order guard,
 * subscriptions upsert and workspaces.plan flip all commit in ONE
 * transaction; the live-runtime listener fires only after commit.
 */
export async function processPaddleWebhook(
  pool: Pool,
  payload: unknown,
  listener?: PlanChangeListener,
): Promise<WebhookOutcome> {
  const event = parseEvent(payload);
  if (!event) return { status: 'invalid' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency ledger: rowCount 0 ⇒ this event_id was already recorded.
    const inserted = await client.query(
      `INSERT INTO webhook_events (event_id, event_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.eventType, event.occurredAt, JSON.stringify(payload)],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return { status: 'duplicate' };
    }

    const markProcessed = () =>
      client.query('UPDATE webhook_events SET processed_at = now() WHERE event_id = $1', [
        event.eventId,
      ]);
    const commitNoop = async <T extends WebhookOutcome>(outcome: T): Promise<T> => {
      await markProcessed();
      await client.query('COMMIT');
      return outcome;
    };

    if (!SUBSCRIPTION_EVENTS.has(event.eventType)) {
      return await commitNoop({ status: 'ignored-event-type' });
    }

    // workspaceId comes from checkout custom_data — validate it names a real
    // workspace. Unknown ⇒ log + processed (200), never 5xx a valid webhook.
    if (!event.workspaceId || !UUID_PATTERN.test(event.workspaceId)) {
      console.warn(
        `[pitolet-cloud] paddle event ${event.eventId}: missing/malformed custom_data.workspaceId — ignored`,
      );
      return await commitNoop({ status: 'unknown-workspace' });
    }
    const ws = await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
      event.workspaceId,
    ]);
    if (ws.rowCount === 0) {
      console.warn(
        `[pitolet-cloud] paddle event ${event.eventId}: workspace ${event.workspaceId} does not exist — ignored`,
      );
      return await commitNoop({ status: 'unknown-workspace' });
    }

    // Out-of-order guard: only apply when occurred_at >= the row's watermark
    // (updated_at stores the occurred_at of the last APPLIED event).
    const sub = await client.query(
      'SELECT updated_at FROM subscriptions WHERE workspace_id = $1 FOR UPDATE',
      [event.workspaceId],
    );
    const watermark = sub.rows[0]?.updated_at as Date | undefined;
    if (watermark && Date.parse(event.occurredAt) < new Date(watermark).getTime()) {
      console.warn(
        `[pitolet-cloud] paddle event ${event.eventId} (${event.occurredAt}) is older than subscription state — recorded, not applied`,
      );
      return await commitNoop({ status: 'stale' });
    }

    const plan: Plan = ACTIVE_STATUSES.has(event.status) ? 'pro' : 'free';
    await client.query(
      `INSERT INTO subscriptions
         (workspace_id, paddle_subscription_id, paddle_customer_id, plan, status, current_period_end, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $5, $6)
       ON CONFLICT (workspace_id) DO UPDATE SET
         paddle_subscription_id = EXCLUDED.paddle_subscription_id,
         paddle_customer_id = EXCLUDED.paddle_customer_id,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = EXCLUDED.updated_at`,
      [
        event.workspaceId,
        event.subscriptionId,
        event.customerId,
        event.status,
        event.currentPeriodEnd,
        event.occurredAt,
      ],
    );
    await client.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [
      event.workspaceId,
      plan,
    ]);
    await markProcessed();
    await client.query('COMMIT');

    // Push into live runtimes AFTER commit — a rollback must never leave a
    // runtime believing in a plan the database rejected.
    listener?.onPlanChanged(event.workspaceId, plan);
    console.log(
      `[pitolet-cloud] paddle ${event.eventType} applied: workspace ${event.workspaceId} → plan ${plan} (status ${event.status})`,
    );
    return { status: 'processed', workspaceId: event.workspaceId, plan };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reconcile (webhooks get lost; the API is the truth)
// ---------------------------------------------------------------------------

/**
 * For every known Paddle subscription, GET its live state and correct drift
 * in subscriptions.status / workspaces.plan. Corrections are logged; any
 * failure is logged and skipped — reconcile must never crash the server.
 */
export async function reconcilePaddleSubscriptions(
  pool: Pool,
  config: PaddleConfig,
  listener?: PlanChangeListener,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const rows = await pool.query(
    `SELECT s.workspace_id, s.paddle_subscription_id, s.status, w.plan
     FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.paddle_subscription_id IS NOT NULL`,
  );
  for (const row of rows.rows) {
    const subId = row.paddle_subscription_id as string;
    const workspaceId = row.workspace_id as string;
    try {
      const res = await fetchImpl(`${config.apiBase}/subscriptions/${encodeURIComponent(subId)}`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) {
        console.error(
          `[pitolet-cloud] paddle reconcile: GET /subscriptions/${subId} → ${res.status}`,
        );
        continue;
      }
      const body = (await res.json()) as {
        data?: { status?: string; current_billing_period?: { ends_at?: string } };
      };
      const liveStatus = body.data?.status;
      if (!liveStatus) continue;
      const livePlan: Plan = ACTIVE_STATUSES.has(liveStatus) ? 'pro' : 'free';
      const statusDrift = liveStatus !== (row.status as string);
      const planDrift = livePlan !== planOf(row.plan);
      if (!statusDrift && !planDrift) continue;
      console.warn(
        `[pitolet-cloud] paddle reconcile: correcting workspace ${workspaceId} ` +
          `(status ${row.status} → ${liveStatus}, plan ${row.plan} → ${livePlan})`,
      );
      await pool.query(
        `UPDATE subscriptions SET status = $2, current_period_end = $3, updated_at = now()
         WHERE workspace_id = $1`,
        [workspaceId, liveStatus, body.data?.current_billing_period?.ends_at ?? null],
      );
      await pool.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [workspaceId, livePlan]);
      listener?.onPlanChanged(workspaceId, livePlan);
    } catch (err) {
      console.error(`[pitolet-cloud] paddle reconcile failed for subscription ${subId}:`, err);
    }
  }
}
