import type { AuthAction, AuthContext, AuthHooks, AuthzResult } from 'pitolet';
import { docCreateDenial, type Plan } from './plans.js';
import { TokenBucketLimiter } from './rateLimit.js';

/**
 * Per-workspace authorization for the OSS runtime (defense in depth — the
 * cloud router authenticates BEFORE dispatch; the runtime re-checks every
 * action with these hooks, so a routing mistake alone cannot authorize).
 *
 * Scope model: the router encodes capabilities into AuthContext.scopes for
 * every credential type, so one scope check covers users and agents:
 *   - agent tokens carry their stored scopes (['read'] or ['read','write'])
 *   - users get role-derived scopes: viewer → ['read'],
 *     editor/owner → ['read','write']
 *   - share links get {kind:'share', scopes:['read'], docId} and are handled
 *     by a dedicated branch below (read-only + single-document pinning)
 *
 * Plan enforcement (I5-3), both SYNC per the OSS AuthHooks contract:
 *   - 'doc:create' is denied (429) once the workspace's plan doc limit is
 *     reached — plan and doc count come from live closures so a Paddle
 *     webhook flips behavior without a runtime reload.
 *   - 'doc:write' is token-bucketed at 240 patches/min per ctx.userId — an
 *     abuse ceiling for WS patch storms, not a fairness scheduler.
 *
 * The OSS AuthContext type is untouched; roles never reach the runtime.
 */

const READ_ACTIONS: ReadonlySet<AuthAction> = new Set([
  'doc:list',
  'doc:read',
  'asset:read',
  'mcp:connect',
]);

const WRITE_ACTIONS: ReadonlySet<AuthAction> = new Set([
  'doc:write',
  'doc:create',
  'asset:write',
]);

/**
 * The COMPLETE share-link surface: read-only, ever. 'doc:list' is safe
 * because the OSS layer filters listings to ctx.docId; 'mcp:connect' is safe
 * because MCP tool registration hides write tools from read scopes and
 * requireDoc pins reads to ctx.docId. Anything not in this set — every
 * write, export, future actions — is denied for share contexts.
 */
const SHARE_ACTIONS: ReadonlySet<AuthAction> = new Set([
  'doc:read',
  'doc:list',
  'asset:read',
  'mcp:connect',
]);

/** WS patch budget per user per minute (see rateLimit.ts for semantics). */
export const WS_PATCHES_PER_MINUTE = 240;

export interface WorkspaceAuthHookOptions {
  /** Live plan for the workspace (updated by WorkspaceManager.onPlanChanged). */
  getPlan?: () => Plan;
  /** Live document count (runtime.store.list().length once the runtime exists). */
  getDocCount?: () => number;
  /** Injectable clock for the write-rate bucket (tests). */
  clock?: () => number;
}

export function makeWorkspaceAuthHooks(
  workspaceId: string,
  options: WorkspaceAuthHookOptions = {},
): AuthHooks {
  const denied = (reason: string, status: 401 | 403 | 429): AuthzResult => ({
    ok: false,
    status,
    reason,
  });

  // One bucket map per workspace runtime — evicting the runtime resets it,
  // which only ever errs in the caller's favor by a partial window.
  const writeBuckets = new TokenBucketLimiter({
    capacity: WS_PATCHES_PER_MINUTE,
    clock: options.clock,
  });

  return {
    // NO authenticate hook: identity is resolved by the cloud router before
    // dispatch (session cookie or agent token, workspace-checked). The
    // runtime never sees an unauthenticated context except via a router bug
    // — which authorize() below turns into a 401.
    authorize(ctx: AuthContext, action: AuthAction, docId?: string): AuthzResult {
      // Share links: read-only, pinned to ONE document. The router already
      // verified the token against this workspace; here we enforce that the
      // grant never widens — no writes, and any action that names a document
      // (WS 'open' passes docId) must name THE shared document.
      if (ctx.kind === 'share') {
        if (!SHARE_ACTIONS.has(action)) {
          return denied('share links are read-only', 403);
        }
        if (docId !== undefined && docId !== ctx.docId) {
          return denied('share links grant access to a single document', 403);
        }
        return { ok: true };
      }
      if (ctx.kind !== 'user' && ctx.kind !== 'agent') {
        return denied(`unauthorized (workspace ${workspaceId})`, 401);
      }
      const scopes = ctx.scopes ?? [];
      if (READ_ACTIONS.has(action)) {
        return scopes.includes('read') ? { ok: true } : denied('read scope required', 403);
      }
      if (WRITE_ACTIONS.has(action)) {
        if (!scopes.includes('write')) return denied('write scope required', 403);
        if (action === 'doc:create' && options.getPlan && options.getDocCount) {
          const denial = docCreateDenial(options.getPlan(), options.getDocCount());
          if (denial) return denied(denial, 429);
        }
        if (action === 'doc:write' && !writeBuckets.allow(ctx.userId ?? 'anonymous')) {
          return denied(
            `Rate limit exceeded: ${WS_PATCHES_PER_MINUTE} edits/min — slow down and retry`,
            429,
          );
        }
        return { ok: true };
      }
      // 'export' (and anything future/unknown): denied in cloud. Export
      // writes to the server's local disk; the PG adapter exposes no
      // exportBaseDir so the route/tool is unregistered anyway — this is
      // the explicit second layer.
      return denied(`action ${action} is not available in Pitolet Cloud`, 403);
    },
  };
}
