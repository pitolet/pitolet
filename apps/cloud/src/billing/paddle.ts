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
  productIdPro: string;
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
  'PADDLE_PRODUCT_ID_PRO',
  'PADDLE_ENV',
] as const;

/**
 * Billing config from env. Production requires either a complete config or
 * an explicit PADDLE_BILLING_DISABLED=true. Partial/invalid money-path
 * configuration is a boot error rather than a silent free-plan deployment.
 */
export function loadPaddleConfig(env: NodeJS.ProcessEnv = process.env): PaddleConfig | null {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  const explicitlyDisabled = env.PADDLE_BILLING_DISABLED === 'true';
  if (missing.length === REQUIRED_ENV.length) {
    if (env.NODE_ENV === 'production' && !explicitlyDisabled) {
      throw new Error(
        'Paddle billing is not configured; set all Paddle variables or PADDLE_BILLING_DISABLED=true',
      );
    }
    return null;
  }
  if (explicitlyDisabled) {
    throw new Error('PADDLE_BILLING_DISABLED=true cannot be combined with Paddle credentials');
  }
  if (missing.length > 0) {
    throw new Error(`partial Paddle configuration (missing ${missing.join(', ')})`);
  }
  const paddleEnv = env.PADDLE_ENV;
  if (paddleEnv !== 'sandbox' && paddleEnv !== 'production') {
    throw new Error(`PADDLE_ENV must be 'sandbox' or 'production' (got '${paddleEnv}')`);
  }
  return {
    apiKey: env.PADDLE_API_KEY!,
    webhookSecret: env.PADDLE_WEBHOOK_SECRET!,
    priceIdPro: env.PADDLE_PRICE_ID_PRO!,
    productIdPro: env.PADDLE_PRODUCT_ID_PRO!,
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
  const expected = createHmac('sha256', secret).update(ts).update(':').update(rawBody).digest();
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
  | { status: 'invalid-workspace-binding' }
  | { status: 'invalid-product' }
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
  workspaceSignature: string | null;
  priceIds: string[];
  productIds: string[];
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
  const items = Array.isArray(data.items) ? data.items : [];
  const priceIds: string[] = [];
  const productIds: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const price = (
      typeof (item as Record<string, unknown>).price === 'object' &&
      (item as Record<string, unknown>).price !== null
        ? (item as Record<string, unknown>).price
        : {}
    ) as Record<string, unknown>;
    if (typeof price.id === 'string') priceIds.push(price.id);
    if (typeof price.product_id === 'string') productIds.push(price.product_id);
    const product = (
      typeof price.product === 'object' && price.product !== null ? price.product : {}
    ) as Record<string, unknown>;
    if (typeof product.id === 'string') productIds.push(product.id);
  }
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
    workspaceSignature:
      typeof customData.workspaceSig === 'string' ? customData.workspaceSig : null,
    priceIds,
    productIds,
  };
}

/** Signed checkout metadata binds a paid subscription to one workspace. */
export function workspaceCheckoutSignature(secret: string, workspaceId: string): string {
  return createHmac('sha256', secret).update('pitolet-checkout:').update(workspaceId).digest('hex');
}

function validWorkspaceBinding(
  config: PaddleConfig,
  workspaceId: string | null,
  signature: string | null,
): workspaceId is string {
  if (!workspaceId || !UUID_PATTERN.test(workspaceId) || !signature) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(
    workspaceCheckoutSignature(config.webhookSecret, workspaceId),
    'hex',
  );
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Apply one verified webhook payload. Ledger insert, out-of-order guard,
 * subscriptions upsert and workspaces.plan flip all commit in ONE
 * transaction; the live-runtime listener fires only after commit.
 */
export async function processPaddleWebhook(
  pool: Pool,
  payload: unknown,
  config: PaddleConfig,
  listener?: PlanChangeListener,
): Promise<WebhookOutcome> {
  const event = parseEvent(payload);
  if (!event) return { status: 'invalid' };
  // Lifecycle events without a subscription id or status cannot be ordered
  // or reconciled safely. Reject them before the idempotency ledger so a
  // corrected Paddle retry can still be processed under the same event id.
  if (
    SUBSCRIPTION_EVENTS.has(event.eventType) &&
    (!event.subscriptionId || !event.status || event.status === 'unknown')
  ) {
    return { status: 'invalid' };
  }

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

    if (
      !event.priceIds.includes(config.priceIdPro) ||
      !event.productIds.includes(config.productIdPro)
    ) {
      console.warn(
        `[pitolet-cloud] paddle event ${event.eventId}: subscription does not contain the configured Pro product and price — ignored`,
      );
      return await commitNoop({ status: 'invalid-product' });
    }

    // An existing subscription id is the strongest binding and is never
    // reassigned. A new subscription must carry server-signed custom data.
    const existingBinding = event.subscriptionId
      ? await client.query(
          `SELECT workspace_id FROM subscriptions
           WHERE paddle_subscription_id = $1 FOR UPDATE`,
          [event.subscriptionId],
        )
      : null;
    let workspaceId = existingBinding?.rows[0]?.workspace_id as string | undefined;
    if (workspaceId) {
      if (event.workspaceId && event.workspaceId !== workspaceId) {
        console.warn(
          `[pitolet-cloud] paddle event ${event.eventId}: subscription workspace binding changed — ignored`,
        );
        return await commitNoop({ status: 'invalid-workspace-binding' });
      }
    } else if (validWorkspaceBinding(config, event.workspaceId, event.workspaceSignature)) {
      workspaceId = event.workspaceId;
    } else {
      console.warn(
        `[pitolet-cloud] paddle event ${event.eventId}: invalid signed workspace binding — ignored`,
      );
      return await commitNoop({ status: 'invalid-workspace-binding' });
    }

    const ws = await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
      workspaceId,
    ]);
    if (ws.rowCount === 0) {
      console.warn(
        `[pitolet-cloud] paddle event ${event.eventId}: workspace ${workspaceId} does not exist — ignored`,
      );
      return await commitNoop({ status: 'unknown-workspace' });
    }

    // Out-of-order guard: only apply when occurred_at >= the row's watermark
    // (updated_at stores the occurred_at of the last APPLIED event).
    const sub = await client.query(
      'SELECT updated_at FROM subscriptions WHERE workspace_id = $1 FOR UPDATE',
      [workspaceId],
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
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id) DO UPDATE SET
         paddle_subscription_id = EXCLUDED.paddle_subscription_id,
         paddle_customer_id = EXCLUDED.paddle_customer_id,
         plan = EXCLUDED.plan,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = EXCLUDED.updated_at`,
      [
        workspaceId,
        event.subscriptionId,
        event.customerId,
        plan,
        event.status,
        event.currentPeriodEnd,
        event.occurredAt,
      ],
    );
    await client.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [workspaceId, plan]);
    await markProcessed();
    await client.query('COMMIT');

    // Push into live runtimes AFTER commit — a rollback must never leave a
    // runtime believing in a plan the database rejected.
    listener?.onPlanChanged(workspaceId, plan);
    console.log(
      `[pitolet-cloud] paddle ${event.eventType} applied: workspace ${workspaceId} → plan ${plan} (status ${event.status})`,
    );
    return { status: 'processed', workspaceId, plan };
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
        data?: {
          status?: string;
          current_billing_period?: { ends_at?: string };
          items?: Array<{
            price?: { id?: string; product_id?: string; product?: { id?: string } };
          }>;
        };
      };
      const liveStatus = body.data?.status;
      if (!liveStatus) continue;
      const hasConfiguredProduct = (body.data?.items ?? []).some(
        (item) =>
          item.price?.id === config.priceIdPro &&
          (item.price.product_id === config.productIdPro ||
            item.price.product?.id === config.productIdPro),
      );
      const livePlan: Plan =
        ACTIVE_STATUSES.has(liveStatus) && hasConfiguredProduct ? 'pro' : 'free';
      if (ACTIVE_STATUSES.has(liveStatus) && !hasConfiguredProduct) {
        console.error(
          `[pitolet-cloud] paddle reconcile: subscription ${subId} has an active status but not the configured Pro product`,
        );
      }
      const statusDrift = liveStatus !== (row.status as string);
      const planDrift = livePlan !== planOf(row.plan);
      if (!statusDrift && !planDrift) continue;
      console.warn(
        `[pitolet-cloud] paddle reconcile: correcting workspace ${workspaceId} ` +
          `(status ${row.status} → ${liveStatus}, plan ${row.plan} → ${livePlan})`,
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
        await client.query(
          `UPDATE subscriptions
           SET status = $2, plan = $3, current_period_end = $4, updated_at = now()
           WHERE workspace_id = $1`,
          [workspaceId, liveStatus, livePlan, body.data?.current_billing_period?.ends_at ?? null],
        );
        await client.query('UPDATE workspaces SET plan = $2 WHERE id = $1', [
          workspaceId,
          livePlan,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      listener?.onPlanChanged(workspaceId, livePlan);
    } catch (err) {
      console.error(`[pitolet-cloud] paddle reconcile failed for subscription ${subId}:`, err);
    }
  }
}
