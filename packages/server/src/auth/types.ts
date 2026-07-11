import type http from 'node:http';

/**
 * Who is making a request. Produced by AuthHooks.authenticate and threaded
 * through every enforcement surface (HTTP dispatch, WS hub, MCP tools).
 */
export interface AuthContext {
  kind: 'anonymous' | 'user' | 'agent' | 'share';
  userId?: string;
  displayName?: string;
  /** e.g. ['read'] or ['read','write']; absent = unrestricted. */
  scopes?: readonly string[];
  /** Share contexts: restricted to one document — all others are invisible. */
  docId?: string;
}

export type AuthAction =
  | 'doc:list'
  | 'doc:read'
  | 'doc:write'
  | 'doc:create'
  | 'asset:read'
  | 'asset:write'
  | 'export'
  | 'mcp:connect';

export type AuthzResult = { ok: true } | { ok: false; status?: 401 | 403 | 429; reason?: string };

export interface AuthHooks {
  /**
   * Resolve a request to an identity; null = unauthenticated. When this hook
   * is configured, every non-allowlisted route requires a non-null result.
   * (Allowlist: GET /api/health, POST /api/login, static editor assets.)
   */
  authenticate?(req: http.IncomingMessage): Promise<AuthContext | null>;
  /** Per-action policy. Absent = every authenticated context may do everything. */
  authorize?(ctx: AuthContext, action: AuthAction, docId?: string): AuthzResult;
  /**
   * Optional POST /api/login handler (credential check + session cookie).
   * createApp routes POST /api/login here when present.
   */
  handleLogin?(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

export const ANONYMOUS: AuthContext = { kind: 'anonymous' };

/**
 * Derive per-user patch attribution from an auth context. Returns undefined
 * when the context has no user identity (anonymous / single-user — today's
 * behavior), so patches ride actor-free unless a real user is present.
 */
export function actorFromContext(
  ctx: AuthContext | undefined,
): { id: string; name: string } | undefined {
  return ctx?.userId ? { id: ctx.userId, name: ctx.displayName ?? 'User' } : undefined;
}

/** Run the authorize hook, defaulting to allow when none is configured. */
export function check(
  hooks: AuthHooks | undefined,
  ctx: AuthContext,
  action: AuthAction,
  docId?: string,
): AuthzResult {
  return hooks?.authorize?.(ctx, action, docId) ?? { ok: true };
}
