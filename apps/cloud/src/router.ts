import { createReadStream, existsSync, statSync } from 'node:fs';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { extname, join, normalize } from 'node:path';
import { migrateDocument, type PitoletDocument } from '@pitolet/schema';
import type { Pool } from 'pg';
import { PatchRejectedError, type AuthContext } from 'pitolet';
import { WebSocketServer } from 'ws';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { CloudAuth } from './auth/auth.js';
import {
  processPaddleWebhook,
  verifyPaddleSignature,
  type PaddleConfig,
} from './billing/paddle.js';
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  verifyAgentToken,
  type TokenScope,
} from './cloud/agentTokens.js';
import {
  memberLimitDenial,
  planOf,
  shareLinkLimitDenial,
  tokenLimitDenial,
  workspaceCreateDenial,
  type Plan,
} from './cloud/plans.js';
import { TokenBucketLimiter } from './cloud/rateLimit.js';
import {
  countActiveShareLinks,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  verifyShareLink,
} from './cloud/shareLinks.js';
import type { WorkspaceManager } from './cloud/workspaceManager.js';
import {
  createWorkspace,
  findWorkspaceBySlug,
  listWorkspacesFor,
  roleFor,
  SlugError,
  type Role,
  type Workspace,
} from './cloud/workspaces.js';

/**
 * Multi-tenant router for Pitolet Cloud. THE security boundary:
 *   1. /auth/*            → better-auth (sessions, magic links, OAuth)
 *   2. /api/*             → dashboard API (session-cookie auth)
 *   3. /w/:slug/*         → per-workspace runtime; EVERY request (HTTP and
 *                           WS upgrade) is authenticated and workspace-
 *                           checked here BEFORE any dispatch. Non-members
 *                           get 404 for the whole subtree — a workspace
 *                           they can't access does not exist for them.
 *
 * Identity → AuthContext mapping (exact shapes):
 *   session member  → { kind:'user',  userId, displayName: name||email,
 *                       scopes: viewer ? ['read'] : ['read','write'] }
 *   agent token     → { kind:'agent', userId:`token:<id>`,
 *                       displayName: token name, scopes: stored scopes }
 *   share link      → { kind:'share', userId:`share:<token-prefix8>`,
 *                       displayName:'Guest', scopes:['read'], docId } —
 *                       read-only, pinned to ONE document by the authorize
 *                       hook and by ctx.docId filtering in the OSS layer.
 *   anything else   → rejected before dispatch (401/404); the runtime's
 *                     authorize hook independently denies unknown contexts
 *                     as defense in depth.
 */

export interface CloudRouterOptions {
  pool: Pool;
  auth: CloudAuth;
  manager: WorkspaceManager;
  /** Built editor SPA root; null = SPA serving disabled (API still works). */
  editorDist: string | null;
  /** Built dashboard SPA root; null = serve the placeholder text at `/`. */
  dashboardDist: string | null;
  /** Paddle billing config; null/undefined = billing disabled (webhook 404s). */
  billing?: PaddleConfig | null;
  /** Injectable clock for rate limiters (tests). */
  clock?: () => number;
}

export interface CloudRouter {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Propagate a plan change into live runtimes + router caches. */
  onPlanChanged(workspaceId: string, plan: Plan): void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const WORKSPACE_PATH = /^\/w\/([^/]+)(\/.*)?$/;
const WORKSPACE_SUBRESOURCE =
  /^\/api\/workspaces\/([0-9a-f-]{36})\/(members|tokens|billing|share-links)$/;
/** Per-document subresources: version history (snapshots) and restore. */
const DOC_SUBRESOURCE =
  /^\/api\/workspaces\/([0-9a-f-]{36})\/docs\/([A-Za-z0-9_-]+)\/(snapshots|restore)$/;
/** Public share-link entry: /s/:token → 302 into the workspace editor. */
const SHARE_ENTRY_PATH = /^\/s\/([^/]+)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The ONE page every failed /s/:token request gets — invalid, revoked, and
 * expired are byte-identical on purpose: a probing client must not be able
 * to distinguish "never existed" from "existed and was revoked".
 */
const SHARE_NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link not found — Pitolet</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #101014; color: #e4e4e9; font: 15px/1.6 system-ui, sans-serif; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: 40px; margin: 0 0 8px; font-weight: 650; }
  p { margin: 0; color: #9a9aa5; }
</style>
</head>
<body>
<main>
<h1>404</h1>
<p>This share link doesn&rsquo;t exist or is no longer active.</p>
<p>Ask the person who sent it for a new link.</p>
</main>
</body>
</html>
`;

/** Per-agent-token MCP request budget (abuse ceiling, not fairness). */
const MCP_REQUESTS_PER_MINUTE = 60;
/** Per-IP webhook budget — blunts garbage floods before HMAC work. */
const WEBHOOK_REQUESTS_PER_MINUTE = 60;
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

type SessionUser = { id: string; email: string; name: string; image?: string | null };

type WorkspacePrincipal =
  | { ok: true; ctx: AuthContext; role: Role | null }
  | { ok: false; status: 401 | 404 };

export function createCloudRouter(options: CloudRouterOptions): CloudRouter {
  const { pool, auth, manager, editorDist, dashboardDist } = options;
  const billing = options.billing ?? null;
  const clock = options.clock ?? Date.now;
  const authHandler = toNodeHandler(auth);
  // One shared noServer WSS purely for the upgrade handshake; accepted
  // sockets are handed to the (per-workspace) hub.
  const wss = new WebSocketServer({ noServer: true });
  // slug → workspace row. No rename/delete in I5, so entries only go stale
  // on plan changes — onPlanChanged patches them; wire invalidation into
  // rename/delete mutations when they land.
  const slugCache = new Map<string, Workspace>();

  const mcpLimiter = new TokenBucketLimiter({ capacity: MCP_REQUESTS_PER_MINUTE, clock });
  const webhookLimiter = new TokenBucketLimiter({ capacity: WEBHOOK_REQUESTS_PER_MINUTE, clock });

  /** Fan a committed plan change out to live runtimes and the slug cache. */
  function onPlanChanged(workspaceId: string, plan: Plan): void {
    manager.onPlanChanged(workspaceId, plan);
    for (const ws of slugCache.values()) {
      if (ws.id === workspaceId) ws.plan = plan;
    }
  }

  async function resolveWorkspace(slug: string): Promise<Workspace | null> {
    const cached = slugCache.get(slug);
    if (cached) return cached;
    const ws = await findWorkspaceBySlug(pool, slug);
    if (ws) slugCache.set(ws.slug, ws);
    return ws;
  }

  async function getSessionUser(req: http.IncomingMessage): Promise<SessionUser | null> {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user ?? null;
  }

  /**
   * Resolve a request against a workspace slug. Response-code policy (the
   * tenancy boundary — treat as spec):
   *   - Bearer token: invalid, revoked, or SCOPED TO ANOTHER WORKSPACE →
   *     401, byte-identical responses. A foreign token must not learn that
   *     the workspace exists.
   *   - Share token (?share= or X-Pitolet-Share; checked AFTER Bearer,
   *     BEFORE session): invalid, revoked, expired, or scoped to another
   *     workspace → the same byte-identical 401. Valid → read-only context
   *     pinned to the link's single document.
   *   - Session but not a member (or workspace doesn't exist) → 404.
   *   - No credentials → 401 (regardless of workspace existence).
   */
  async function authenticateWorkspace(
    req: http.IncomingMessage,
    workspace: Workspace | null,
  ): Promise<WorkspacePrincipal> {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (bearer) {
      const token = await verifyAgentToken(pool, bearer[1]!);
      if (!token || !workspace || token.workspaceId !== workspace.id) {
        return { ok: false, status: 401 };
      }
      return {
        ok: true,
        role: null,
        ctx: {
          kind: 'agent',
          userId: `token:${token.tokenId}`,
          displayName: token.name,
          scopes: token.scopes,
        },
      };
    }

    // Share token: query param (browser + WS upgrade both carry the URL) or
    // X-Pitolet-Share header (MCP/agents, where the URL is fixed). A present
    // share credential is authoritative — it never falls through to the
    // session branch, so a member using a share URL gets share-scoped access.
    const shareHeader = req.headers['x-pitolet-share'];
    const shareToken =
      (typeof shareHeader === 'string' ? shareHeader : undefined) ??
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('share') ??
      undefined;
    if (shareToken) {
      const link = await verifyShareLink(pool, shareToken);
      // Invalid/revoked/expired token, unknown workspace, or a token scoped
      // to ANOTHER workspace → the same 401 the Bearer branch produces.
      if (!link || !workspace || link.workspaceId !== workspace.id) {
        return { ok: false, status: 401 };
      }
      return {
        ok: true,
        role: null,
        ctx: {
          kind: 'share',
          userId: `share:${shareToken.slice('pshare_'.length, 'pshare_'.length + 8)}`,
          displayName: 'Guest',
          scopes: ['read'],
          docId: link.docId,
        },
      };
    }

    const user = await getSessionUser(req);
    if (!user) return { ok: false, status: 401 };
    if (!workspace) return { ok: false, status: 404 };
    const role = await roleFor(pool, user.id, workspace.id);
    if (!role) return { ok: false, status: 404 };
    return {
      ok: true,
      role,
      ctx: {
        kind: 'user',
        userId: user.id,
        displayName: user.name || user.email,
        scopes: role === 'viewer' ? ['read'] : ['read', 'write'],
      },
    };
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const notFound = (res: http.ServerResponse) => json(res, 404, { error: 'not found' });
  const unauthorized = (res: http.ServerResponse) => json(res, 401, { error: 'unauthorized' });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/auth' || pathname.startsWith('/auth/')) {
      await authHandler(req, res);
      return;
    }

    // Paddle webhook: NO session/token auth (Paddle calls it) — the HMAC
    // signature over the raw body IS the authentication.
    if (pathname === '/api/billing/webhook' && req.method === 'POST') {
      return handleBillingWebhook(req, res);
    }

    // Public share-link entry (humans click these — never JSON). Valid →
    // bounce into the workspace editor with the token as a query credential;
    // anything else → ONE byte-identical 404 page (invalid == revoked ==
    // expired, indistinguishable by construction).
    const share = SHARE_ENTRY_PATH.exec(pathname);
    if (share && (req.method === 'GET' || req.method === 'HEAD')) {
      const link = await verifyShareLink(pool, share[1]!);
      const slugRow = link
        ? await pool.query('SELECT slug FROM workspaces WHERE id = $1', [link.workspaceId])
        : null;
      const slug = slugRow?.rows[0]?.slug as string | undefined;
      if (!link || !slug) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(SHARE_NOT_FOUND_HTML);
        return;
      }
      res.writeHead(302, { location: `/w/${slug}/?share=${share[1]!}` });
      res.end();
      return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const user = await getSessionUser(req);
      if (!user) return unauthorized(res);
      const workspaces = await listWorkspacesFor(pool, user.id);
      return json(res, 200, {
        user: { id: user.id, email: user.email, name: user.name, image: user.image ?? null },
        workspaces,
      });
    }

    if (pathname === '/api/workspaces') {
      const user = await getSessionUser(req);
      if (!user) return unauthorized(res);
      if (req.method === 'GET') {
        return json(res, 200, { workspaces: await listWorkspacesFor(pool, user.id) });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const slug = typeof body?.slug === 'string' ? body.slug : '';
        if (!name) return json(res, 400, { error: 'name is required' });
        // Plan gate — see the ownership rule in plans.ts: 1 owned workspace
        // on free, up to 10 once the user owns a pro workspace.
        const owned = await pool.query(
          `SELECT w.plan FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = $1 AND m.role = 'owner'`,
          [user.id],
        );
        const denial = workspaceCreateDenial(owned.rows.map((r) => r.plan as string));
        if (denial) return json(res, 429, { error: denial });
        try {
          const workspace = await createWorkspace(pool, { name, slug, ownerUserId: user.id });
          return json(res, 201, { workspace: { ...workspace, role: 'owner' } });
        } catch (err) {
          if (err instanceof SlugError) return json(res, 400, { error: err.message });
          if ((err as { code?: string }).code === '23505') {
            return json(res, 409, { error: 'slug is taken' });
          }
          throw err;
        }
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    const sub = WORKSPACE_SUBRESOURCE.exec(pathname);
    if (sub) {
      const user = await getSessionUser(req);
      if (!user) return unauthorized(res);
      const workspaceId = sub[1]!;
      const role = await roleFor(pool, user.id, workspaceId);
      // Non-members must not learn the workspace id is real.
      if (!role) return notFound(res);
      if (sub[2] === 'members') return handleMembers(req, res, workspaceId, user, role);
      if (sub[2] === 'billing') return handleBilling(req, res, workspaceId, role);
      if (sub[2] === 'share-links') return handleShareLinks(req, res, url, workspaceId, user, role);
      return handleTokens(req, res, workspaceId, user, role);
    }

    const docSub = DOC_SUBRESOURCE.exec(pathname);
    if (docSub) {
      const user = await getSessionUser(req);
      if (!user) return unauthorized(res);
      const workspaceId = docSub[1]!;
      const docId = docSub[2]!;
      const role = await roleFor(pool, user.id, workspaceId);
      // Non-members must not learn the workspace id is real.
      if (!role) return notFound(res);
      // Doc∈workspace guard on EVERY history route: a foreign or unknown
      // docId is a 404 before any snapshot query runs.
      const owned = await pool.query(
        'SELECT 1 FROM documents WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [docId, workspaceId],
      );
      if (owned.rowCount === 0) return notFound(res);
      if (docSub[3] === 'snapshots') return handleSnapshots(req, res, workspaceId, docId, user, role);
      return handleRestore(req, res, workspaceId, docId, user, role);
    }

    const w = WORKSPACE_PATH.exec(pathname);
    if (w) {
      await handleWorkspaceRequest(req, res, w[1]!, w[2] ?? '');
      return;
    }

    // Everything else falls through to the dashboard SPA. /auth, /api and /w
    // were matched above, so they always take priority over this fallback.
    // Only GET/HEAD serve HTML; other methods are genuine 404s.
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (dashboardDist) {
        // index.html fallback covers client routes like /settings/:id.
        serveStatic(dashboardDist, pathname, res);
        return;
      }
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Pitolet cloud — dashboard build not found (run `pnpm --filter @pitolet/cloud build`)');
        return;
      }
    }

    notFound(res);
  }

  /**
   * POST /api/billing/webhook — the money path. Order is load-bearing:
   * rate limit → RAW body capture → HMAC verify (401) → JSON parse →
   * idempotent apply. Nothing here trusts the payload before the HMAC.
   */
  async function handleBillingWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Billing disabled (dev / self-host): the route does not exist.
    if (!billing) return notFound(res);
    if (!webhookLimiter.allow(clientIp(req))) {
      return json(res, 429, { error: 'rate limited' });
    }
    // Capture the raw bytes BEFORE any JSON parse — the signature covers
    // exactly these bytes, not a re-serialization.
    let raw: Buffer;
    try {
      raw = await readRawBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch {
      return json(res, 413, { error: 'body too large' });
    }
    const header = req.headers['paddle-signature'];
    const verified = verifyPaddleSignature(
      typeof header === 'string' ? header : undefined,
      raw,
      billing.webhookSecret,
      clock(),
    );
    if (!verified) return json(res, 401, { error: 'invalid signature' });

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const outcome = await processPaddleWebhook(pool, payload, { onPlanChanged });
    if (outcome.status === 'invalid') return json(res, 400, { error: 'malformed event' });
    // Everything else (processed, duplicate, stale, unknown workspace,
    // unhandled type) is a 200 — a verified webhook is never retried-forever.
    return json(res, 200, { ok: true });
  }

  /**
   * GET /api/workspaces/:id/billing (owner only) — everything the dashboard
   * needs to render plan state and open Paddle.js checkout (priceId +
   * customData {workspaceId}) or a "manage" view.
   */
  async function handleBilling(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workspaceId: string,
    role: Role,
  ): Promise<void> {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (role !== 'owner') return json(res, 403, { error: 'owner role required' });
    const row = await pool.query(
      `SELECT w.plan, s.status, s.current_period_end AS period_end
       FROM workspaces w LEFT JOIN subscriptions s ON s.workspace_id = w.id
       WHERE w.id = $1`,
      [workspaceId],
    );
    const r = row.rows[0] as
      | { plan: string; status: string | null; period_end: Date | null }
      | undefined;
    return json(res, 200, {
      plan: planOf(r?.plan),
      status: r?.status ?? null,
      currentPeriodEnd: r?.period_end ? new Date(r.period_end).toISOString() : null,
      priceId: billing?.priceIdPro ?? null,
      billingEnabled: billing !== null,
    });
  }

  async function handleMembers(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workspaceId: string,
    user: SessionUser,
    role: Role,
  ): Promise<void> {
    if (req.method === 'GET') {
      const rows = await pool.query(
        `SELECT m.user_id AS "userId", m.role, u.email, u.name
         FROM memberships m JOIN "user" u ON u.id = m.user_id
         WHERE m.workspace_id = $1 ORDER BY m.created_at ASC`,
        [workspaceId],
      );
      return json(res, 200, { members: rows.rows });
    }
    // Writes are owner-only.
    if (role !== 'owner') return json(res, 403, { error: 'owner role required' });

    if (req.method === 'POST') {
      const body = await readJson(req);
      const email = typeof body?.email === 'string' ? body.email.trim() : '';
      const newRole = body?.role as Role;
      if (!email || !['owner', 'editor', 'viewer'].includes(newRole)) {
        return json(res, 400, { error: 'body must be {email, role: owner|editor|viewer}' });
      }
      // I5: the invitee must already have an account (real invites in I6).
      const target = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
      const targetId = target.rows[0]?.id as string | undefined;
      if (!targetId) return json(res, 404, { error: 'no account with that email' });
      const existingRole = await roleFor(pool, targetId, workspaceId);
      // Same invariant as DELETE: the upsert path must not orphan the
      // workspace by demoting its only owner.
      if (existingRole === 'owner' && newRole !== 'owner') {
        const owners = await pool.query(
          "SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'",
          [workspaceId],
        );
        if ((owners.rows[0].n as number) <= 1) {
          return json(res, 400, { error: 'cannot demote the last owner' });
        }
      }
      // Plan gate for NEW members only — role changes are always allowed.
      if (!existingRole) {
        const info = await pool.query(
          `SELECT w.plan,
                  (SELECT count(*)::int FROM memberships m WHERE m.workspace_id = w.id) AS members
           FROM workspaces w WHERE w.id = $1`,
          [workspaceId],
        );
        const denial = memberLimitDenial(
          planOf(info.rows[0]?.plan),
          (info.rows[0]?.members as number) ?? 0,
        );
        if (denial) return json(res, 429, { error: denial });
      }
      await pool.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [workspaceId, targetId, newRole],
      );
      return json(res, 200, { member: { userId: targetId, role: newRole } });
    }

    if (req.method === 'DELETE') {
      const body = await readJson(req);
      const targetId = typeof body?.userId === 'string' ? body.userId : '';
      if (!targetId) return json(res, 400, { error: 'body must be {userId}' });
      const owners = await pool.query(
        "SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'owner'",
        [workspaceId],
      );
      const targetRole = await roleFor(pool, targetId, workspaceId);
      if (targetRole === 'owner' && (owners.rows[0].n as number) <= 1) {
        return json(res, 400, { error: 'cannot remove the last owner' });
      }
      await pool.query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [
        workspaceId,
        targetId,
      ]);
      return json(res, 200, { removed: targetId });
    }

    json(res, 405, { error: 'method not allowed' });
  }

  async function handleTokens(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workspaceId: string,
    user: SessionUser,
    role: Role,
  ): Promise<void> {
    // Tokens grant write access to designs — viewer roles manage none.
    if (role !== 'owner' && role !== 'editor') {
      return json(res, 403, { error: 'owner or editor role required' });
    }
    if (req.method === 'GET') {
      return json(res, 200, { tokens: await listAgentTokens(pool, workspaceId) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) return json(res, 400, { error: 'name is required' });
      // Plan gate: active (non-revoked) tokens count against the limit.
      const info = await pool.query(
        `SELECT w.plan,
                (SELECT count(*)::int FROM agent_tokens t
                 WHERE t.workspace_id = w.id AND t.revoked_at IS NULL) AS tokens
         FROM workspaces w WHERE w.id = $1`,
        [workspaceId],
      );
      const denial = tokenLimitDenial(
        planOf(info.rows[0]?.plan),
        (info.rows[0]?.tokens as number) ?? 0,
      );
      if (denial) return json(res, 429, { error: denial });
      const scopes = body?.scopes as TokenScope[] | undefined;
      if (
        scopes !== undefined &&
        !(Array.isArray(scopes) && scopes.length > 0 && scopes.every((s) => s === 'read' || s === 'write'))
      ) {
        return json(res, 400, { error: "scopes must be ['read'] or ['read','write']" });
      }
      const created = await createAgentToken(pool, {
        workspaceId,
        name,
        scopes,
        createdBy: user.id,
      });
      // The raw token appears in this response and NOWHERE else, ever.
      return json(res, 201, created);
    }
    if (req.method === 'DELETE') {
      const body = await readJson(req);
      const tokenId = typeof body?.tokenId === 'string' ? body.tokenId : '';
      if (!tokenId) return json(res, 400, { error: 'body must be {tokenId}' });
      const revoked = await revokeAgentToken(pool, workspaceId, tokenId);
      return revoked ? json(res, 200, { revoked: tokenId }) : notFound(res);
    }
    json(res, 405, { error: 'method not allowed' });
  }

  /**
   * /api/workspaces/:id/share-links — mint / list / revoke public read-only
   * links. Owner|editor only (a share link exposes the design to anyone
   * holding the URL — viewers must not be able to mint one).
   */
  async function handleShareLinks(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    workspaceId: string,
    user: SessionUser,
    role: Role,
  ): Promise<void> {
    if (role !== 'owner' && role !== 'editor') {
      return json(res, 403, { error: 'owner or editor role required' });
    }
    if (req.method === 'GET') {
      const docId = url.searchParams.get('docId') ?? '';
      if (!docId) return json(res, 400, { error: 'docId query parameter is required' });
      // listShareLinks is workspace-scoped — a foreign docId lists nothing.
      return json(res, 200, { shareLinks: await listShareLinks(pool, workspaceId, docId) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const docId = typeof body?.docId === 'string' ? body.docId : '';
      if (!docId) return json(res, 400, { error: 'body must be {docId, expiresInDays?}' });
      const expiresInDays = body?.expiresInDays;
      if (
        expiresInDays !== undefined &&
        !(typeof expiresInDays === 'number' && Number.isInteger(expiresInDays) && expiresInDays > 0)
      ) {
        return json(res, 400, { error: 'expiresInDays must be a positive integer' });
      }
      // THE scope guard: the doc must belong to THIS workspace. A
      // cross-workspace docId 404s — minting here must never leak (or link)
      // another tenant's document.
      const owned = await pool.query(
        'SELECT 1 FROM documents WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [docId, workspaceId],
      );
      if (owned.rowCount === 0) return notFound(res);
      // Plan gate: ACTIVE (non-revoked, non-expired) links per doc.
      const info = await pool.query('SELECT plan FROM workspaces WHERE id = $1', [workspaceId]);
      const denial = shareLinkLimitDenial(
        planOf(info.rows[0]?.plan),
        await countActiveShareLinks(pool, workspaceId, docId),
      );
      if (denial) return json(res, 429, { error: denial });
      const created = await createShareLink(pool, {
        docId,
        workspaceId,
        createdBy: user.id,
        expiresInDays: expiresInDays as number | undefined,
      });
      return json(res, 201, created);
    }
    if (req.method === 'DELETE') {
      const body = await readJson(req);
      const token = typeof body?.token === 'string' ? body.token : '';
      if (!token) return json(res, 400, { error: 'body must be {token}' });
      const revoked = await revokeShareLink(pool, workspaceId, token);
      return revoked ? json(res, 200, { revoked: token }) : notFound(res);
    }
    json(res, 405, { error: 'method not allowed' });
  }

  /**
   * /api/workspaces/:id/docs/:docId/snapshots — version history. GET for any
   * member (viewers browse history); POST (named snapshot) for owner|editor.
   * The doc∈workspace guard already ran in the dispatcher.
   */
  async function handleSnapshots(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workspaceId: string,
    docId: string,
    user: SessionUser,
    role: Role,
  ): Promise<void> {
    if (req.method === 'GET') {
      const rows = await pool.query(
        `SELECT s.id, s.rev, s.kind, s.label, s.created_at, s.created_by
         FROM doc_snapshots s
         JOIN documents d ON d.id = s.doc_id
         WHERE s.doc_id = $1 AND d.workspace_id = $2
         ORDER BY s.created_at DESC, s.rev DESC
         LIMIT 100`,
        [docId, workspaceId],
      );
      return json(res, 200, {
        snapshots: rows.rows.map((r) => ({
          id: r.id as string,
          rev: Number(r.rev),
          kind: r.kind as string,
          label: (r.label as string | null) ?? null,
          createdAt: new Date(r.created_at as string).toISOString(),
          createdBy: (r.created_by as string | null) ?? null,
        })),
      });
    }
    if (req.method === 'POST') {
      if (role !== 'owner' && role !== 'editor') {
        return json(res, 403, { error: 'owner or editor role required' });
      }
      const body = await readJson(req);
      const label = typeof body?.label === 'string' ? body.label.trim() : '';
      if (!label) return json(res, 400, { error: 'body must be {label}' });
      // Snapshot the LIVE runtime state (the debounced doc row can lag it).
      const runtime = await manager.getRuntime(workspaceId);
      const entry = runtime.store.get(docId);
      if (!entry) return notFound(res);
      const inserted = await pool.query(
        `INSERT INTO doc_snapshots (doc_id, rev, doc, kind, label, created_by)
         SELECT d.id, $2, $3::jsonb, 'named', $4, $5
         FROM documents d
         WHERE d.id = $1 AND d.workspace_id = $6
         RETURNING id`,
        [docId, entry.rev, JSON.stringify(entry.doc), label, user.id, workspaceId],
      );
      const id = inserted.rows[0]?.id as string | undefined;
      if (!id) return notFound(res);
      return json(res, 201, { id, rev: entry.rev, kind: 'named', label });
    }
    json(res, 405, { error: 'method not allowed' });
  }

  /**
   * POST /api/workspaces/:id/docs/:docId/restore {snapshotId} — owner|editor.
   * Order is load-bearing:
   *   1. load the snapshot (SQL-guarded: snapshot∈doc∈workspace → else 404),
   *   2. migrate + validate it (old schemaVersion upgraded; broken → 422),
   *   3. write a 'pre-restore' snapshot of the CURRENT live state,
   *   4. replace the doc through the runtime store's applyRecipe — the
   *      restore is validated like any edit, broadcast live to open editors,
   *      and persisted through the normal patch pipeline. Only the content
   *      fields move; id/schemaVersion are never touched (the store rejects
   *      patches on those paths anyway).
   */
  async function handleRestore(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workspaceId: string,
    docId: string,
    user: SessionUser,
    role: Role,
  ): Promise<void> {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (role !== 'owner' && role !== 'editor') {
      return json(res, 403, { error: 'owner or editor role required' });
    }
    const body = await readJson(req);
    const snapshotId = typeof body?.snapshotId === 'string' ? body.snapshotId : '';
    if (!snapshotId) return json(res, 400, { error: 'body must be {snapshotId}' });
    // Non-UUID ids can't exist — same 404 as a foreign snapshot (and no
    // pg cast error to distinguish them by).
    if (!UUID_PATTERN.test(snapshotId)) return notFound(res);
    const snap = await pool.query(
      `SELECT s.doc
       FROM doc_snapshots s
       JOIN documents d ON d.id = s.doc_id
       WHERE s.id = $1 AND s.doc_id = $2 AND d.workspace_id = $3`,
      [snapshotId, docId, workspaceId],
    );
    if (snap.rowCount === 0) return notFound(res);

    // Migrate first (old schemaVersion upgraded, full validation) — a broken
    // snapshot must fail BEFORE the pre-restore snapshot is written.
    let snapshotDoc: PitoletDocument;
    try {
      snapshotDoc = migrateDocument(snap.rows[0]!.doc);
    } catch (err) {
      return json(res, 422, {
        error: `snapshot cannot be restored: ${err instanceof Error ? err.message : 'invalid document'}`,
      });
    }

    const runtime = await manager.getRuntime(workspaceId);
    const current = runtime.store.get(docId);
    if (!current) return notFound(res);

    // Safety net: snapshot the CURRENT live state so a restore is always
    // reversible (pre-restore snapshots are never pruned).
    await pool.query(
      `INSERT INTO doc_snapshots (doc_id, rev, doc, kind, label, created_by)
       SELECT d.id, $2, $3::jsonb, 'pre-restore', $4, $5
       FROM documents d
       WHERE d.id = $1 AND d.workspace_id = $6`,
      [docId, current.rev, JSON.stringify(current.doc), 'Before restore', user.id, workspaceId],
    );

    try {
      const rev = runtime.store.applyRecipe(
        docId,
        'server',
        'Restore version',
        (draft) => {
          // Replace every content field; id and schemaVersion stay. comments
          // is optional — delete it when the snapshot predates comments so no
          // stale thread survives the restore.
          draft.name = snapshotDoc.name;
          draft.rootOrder = snapshotDoc.rootOrder;
          draft.nodes = snapshotDoc.nodes;
          draft.components = snapshotDoc.components;
          draft.tokens = snapshotDoc.tokens;
          draft.breakpoints = snapshotDoc.breakpoints;
          draft.assets = snapshotDoc.assets;
          if (snapshotDoc.comments === undefined) delete draft.comments;
          else draft.comments = snapshotDoc.comments;
        },
        { id: user.id, name: user.name || user.email },
      );
      return json(res, 200, { rev });
    } catch (err) {
      if (err instanceof PatchRejectedError) {
        return json(res, 422, { error: `restore rejected: ${err.message}` });
      }
      throw err;
    }
  }

  async function handleWorkspaceRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    slug: string,
    rest: string,
  ): Promise<void> {
    // /w/acme → /w/acme/ so the SPA's relative asset URLs resolve.
    if (rest === '') {
      res.writeHead(301, { location: `/w/${slug}/` });
      res.end();
      return;
    }

    // PUBLIC static app assets (.js/.css/.woff2…): the SPA bundle is the same
    // code for every visitor, so serving it without auth leaks nothing — and
    // share-link guests NEED it (their subresource requests can't carry the
    // ?share= credential). Deliberately BEFORE workspace resolution: every
    // slug serves identical bytes, so this path is no existence oracle. The
    // app shell (index.html / extensionless SPA routes) and every data
    // surface (/api, /assets-store, /mcp, /ws) stay authenticated below.
    // No index fallback here — a missing asset is a plain 404.
    if (
      editorDist &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      extname(rest) !== '' &&
      !rest.startsWith('/api/') &&
      !rest.startsWith('/assets-store/') &&
      rest !== '/mcp' &&
      rest !== '/ws'
    ) {
      serveStatic(editorDist, rest, res, { indexFallback: false });
      return;
    }

    const workspace = await resolveWorkspace(slug);
    const principal = await authenticateWorkspace(req, workspace);
    if (!principal.ok) {
      // Anonymous BROWSER navigation (GET, Accept: text/html, no Bearer
      // credentials) → bounce to the dashboard sign-in with a return path.
      // Agents/fetch with JSON accepts keep the machine-readable 401.
      if (
        principal.status === 401 &&
        req.method === 'GET' &&
        !req.headers.authorization &&
        (req.headers.accept ?? '').includes('text/html')
      ) {
        const query = req.url && req.url.includes('?')
          ? req.url.slice(req.url.indexOf('?'))
          : '';
        const next = encodeURIComponent(`/w/${slug}${rest}${query}`);
        res.writeHead(302, { location: `/?next=${next}` });
        res.end();
        return;
      }
      return principal.status === 401 ? unauthorized(res) : notFound(res);
    }
    const ws = workspace!; // non-null: authenticateWorkspace rejected null above
    const { ctx, role } = principal;

    // Per-credential MCP budget, enforced BEFORE the runtime sees the
    // request. Keyed by ctx.userId (`token:<id>` for agents, `share:<prefix>`
    // for share links); interactive sessions don't speak MCP.
    if (
      rest === '/mcp' &&
      (ctx.kind === 'agent' || ctx.kind === 'share') &&
      !mcpLimiter.allow(ctx.userId ?? '')
    ) {
      return json(res, 429, {
        error: `Rate limit exceeded: ${MCP_REQUESTS_PER_MINUTE} MCP requests/min per token`,
      });
    }

    if (rest === '/api/session' && req.method === 'GET') {
      return json(res, 200, {
        user: { id: ctx.userId, name: ctx.displayName },
        workspace: { id: ws.id, slug: ws.slug, name: ws.name },
        role: role ?? 'agent',
        plan: ws.plan,
      });
    }

    // WS endpoint reached over plain HTTP (upgrades never get here).
    if (rest === '/ws') {
      return json(res, 426, { error: 'websocket upgrade required' });
    }

    const runtime = await manager.getRuntime(ws.id);

    // Runtime-owned routes (/mcp, /api/*, /assets-store/*): the runtime
    // re-runs authorize per action with the workspace hooks — a second,
    // independent enforcement layer on top of this router's gate.
    if (runtime.handleRequest(req, res, rest, ctx)) return;

    // Not runtime-owned → editor SPA (workspace-scoped, base /w/:slug/).
    if (editorDist) {
      serveStatic(editorDist, rest, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('editor build not found — run `pnpm build` first');
  }

  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const match = /^\/w\/([^/]+)\/ws$/.exec(pathname);
    if (!match) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    void (async () => {
      // Same resolution + credential checks as HTTP — cookies ride the
      // upgrade request headers; Bearer tokens work identically.
      const workspace = await resolveWorkspace(match[1]!);
      const principal = await authenticateWorkspace(req, workspace);
      if (!principal.ok) {
        rejectUpgrade(socket, principal.status, principal.status === 401 ? 'Unauthorized' : 'Not Found');
        return;
      }
      const runtime = await manager.getRuntime(workspace!.id);
      wss.handleUpgrade(req, socket, head, (ws) => runtime.hub.handleConnection(ws, principal.ctx));
    })().catch(() => {
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  }

  return { handleRequest, handleUpgrade, onPlanChanged };
}

/** First X-Forwarded-For hop, else the socket address (webhook rate-limit key). */
function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/** Buffer a request body verbatim (no decoding) up to `limit` bytes. */
async function readRawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  // The socket never reached the WS layer — answer in raw HTTP and drop it.
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function serveStatic(
  root: string,
  pathname: string,
  res: http.ServerResponse,
  options: { indexFallback?: boolean } = {},
): void {
  const { indexFallback = true } = options;
  let filePath = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(normalize(root))) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // Public asset serving must NOT fall back to the (auth-gated) app shell.
    if (!indexFallback) {
      res.writeHead(404).end();
      return;
    }
    filePath = join(root, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404).end('editor build not found — run `pnpm build` first');
      return;
    }
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
