/**
 * Plan definitions and limit policy for Pitolet Cloud. This file is the ONE
 * place limits and their user-facing denial strings live; enforcement points
 * (router, auth hooks, storage adapter) call the helpers below.
 *
 * Workspace-ownership rule (workspaces are the billable unit):
 *   - A user may OWN at most 1 workspace while every workspace they own is
 *     on the free plan.
 *   - Owners of >= 1 pro workspace may own up to 10 workspaces total.
 *   Memberships in other people's workspaces are never limited by this rule.
 *
 * Every denial is a 429 whose reason names the limit AND the upgrade path.
 */

export type Plan = 'free' | 'pro';

/** Raised by transactional quota gates and mapped to HTTP 429 by the router. */
export class PlanLimitError extends Error {}

export interface PlanLimits {
  /** Max workspaces a user may OWN (see the ownership rule above). */
  workspacesPerUser: number;
  docsPerWorkspace: number;
  membersPerWorkspace: number;
  /** Active (non-revoked) agent tokens. */
  tokensPerWorkspace: number;
  /** Active (non-revoked, non-expired) share links per document. */
  shareLinksPerDoc: number;
  assetBytesPerWorkspace: number;
  /** Auto-snapshots older than this are pruned; named snapshots live forever. */
  historyDays: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    workspacesPerUser: 1,
    docsPerWorkspace: 3,
    membersPerWorkspace: 2,
    tokensPerWorkspace: 1,
    shareLinksPerDoc: 2,
    assetBytesPerWorkspace: 100 * 1024 * 1024, // 100 MB
    historyDays: 7,
  },
  pro: {
    workspacesPerUser: 10,
    docsPerWorkspace: Number.POSITIVE_INFINITY,
    membersPerWorkspace: 25,
    tokensPerWorkspace: Number.POSITIVE_INFINITY,
    shareLinksPerDoc: 25,
    assetBytesPerWorkspace: 5 * 1024 * 1024 * 1024, // 5 GB
    historyDays: 30,
  },
};

/** Coerce a workspaces.plan column value to a Plan — unknown values are free. */
export function planOf(value: unknown): Plan {
  return value === 'pro' ? 'pro' : 'free';
}

/** Denial reason for creating one more document, or null when allowed. */
export function docCreateDenial(plan: Plan, docCount: number): string | null {
  const limit = PLAN_LIMITS[plan].docsPerWorkspace;
  if (docCount < limit) return null;
  return plan === 'free'
    ? `Free workspaces are limited to ${limit} documents — upgrade to Pro for unlimited`
    : `This workspace has reached its ${limit}-document limit`;
}

/** Denial reason for adding one more member, or null when allowed. */
export function memberLimitDenial(plan: Plan, memberCount: number): string | null {
  const limit = PLAN_LIMITS[plan].membersPerWorkspace;
  if (memberCount < limit) return null;
  return plan === 'free'
    ? `Free workspaces are limited to ${limit} members — upgrade to Pro for up to ${PLAN_LIMITS.pro.membersPerWorkspace}`
    : `Pro workspaces are limited to ${limit} members`;
}

/** Denial reason for minting one more active agent token, or null when allowed. */
export function tokenLimitDenial(plan: Plan, activeTokenCount: number): string | null {
  const limit = PLAN_LIMITS[plan].tokensPerWorkspace;
  if (activeTokenCount < limit) return null;
  return `Free workspaces are limited to ${limit} agent token — upgrade to Pro for unlimited tokens`;
}

/** Denial reason for minting one more ACTIVE share link on a doc, or null when allowed. */
export function shareLinkLimitDenial(plan: Plan, activeLinkCount: number): string | null {
  const limit = PLAN_LIMITS[plan].shareLinksPerDoc;
  if (activeLinkCount < limit) return null;
  return plan === 'free'
    ? `Free workspaces are limited to ${limit} active share links per document — upgrade to Pro for up to ${PLAN_LIMITS.pro.shareLinksPerDoc}`
    : `Documents are limited to ${limit} active share links — revoke one first`;
}

/**
 * Denial reason for creating one more OWNED workspace, or null when allowed.
 * `ownedPlans` = plan column of every workspace the user owns (role='owner').
 */
export function workspaceCreateDenial(ownedPlans: readonly string[]): string | null {
  const ownsPro = ownedPlans.some((p) => planOf(p) === 'pro');
  const maxOwned = ownsPro ? PLAN_LIMITS.pro.workspacesPerUser : PLAN_LIMITS.free.workspacesPerUser;
  if (ownedPlans.length < maxOwned) return null;
  return ownsPro
    ? `You may own at most ${maxOwned} workspaces`
    : `Free accounts are limited to ${maxOwned} owned workspace — upgrade it to Pro to own up to ${PLAN_LIMITS.pro.workspacesPerUser}`;
}

/** Human-readable byte size for denial messages (100 MB, 5 GB, …). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unlimited';
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb) return `${Math.round((bytes / gb) * 10) / 10} GB`;
  return `${Math.round(bytes / mb)} MB`;
}

/** Message thrown when an asset upload would exceed the workspace quota. */
export function assetLimitMessage(plan: Plan): string {
  const limit = formatBytes(PLAN_LIMITS[plan].assetBytesPerWorkspace);
  return plan === 'free'
    ? `Workspace asset storage is full (${limit} on Free) — upgrade to Pro for ${formatBytes(PLAN_LIMITS.pro.assetBytesPerWorkspace)}`
    : `Workspace asset storage is full (${limit} limit)`;
}
