/**
 * Typed thin wrapper over the dashboard JSON API (see apps/cloud/src/router.ts
 * for the authoritative shapes). Every call is same-origin and cookie-authed;
 * a 401 means "signed out". Errors surface as ApiError with the server's
 * `{error}` message so callers can render it inline.
 */

export interface Me {
  user: { id: string; email: string; name: string; image: string | null };
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  plan: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface Member {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  email: string;
  name: string;
}

export interface TokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: Array<'read' | 'write'>;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The one-time raw token minted by POST /tokens — shown ONCE, never again. */
export interface CreatedToken {
  token: string;
  id: string;
  tokenPrefix: string;
  scopes: Array<'read' | 'write'>;
}

/** A document in a workspace, from the runtime's /w/:slug/api/documents list. */
export interface DocumentSummary {
  id: string;
  name: string;
  rev: number;
  frameCount: number;
}

export type SnapshotKind = 'auto' | 'named' | 'pre-restore';

/** A version-history entry (newest-first from the snapshots endpoint). */
export interface Snapshot {
  id: string;
  rev: number;
  kind: SnapshotKind;
  label: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * A public share link. Unlike agent tokens the raw token IS the URL — it is
 * listable verbatim any time, so there is no once-only reveal ceremony.
 */
export interface ShareLink {
  token: string;
  /** Server-relative path, e.g. /s/pshare_… — the caller owns the origin. */
  url: string;
  docId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => request<Me>('/api/me'),

  createWorkspace: (input: { name: string; slug: string }) =>
    request<{ workspace: WorkspaceSummary }>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  members: (workspaceId: string) =>
    request<{ members: Member[] }>(`/api/workspaces/${workspaceId}/members`),

  addMember: (workspaceId: string, input: { email: string; role: string }) =>
    request<{ member: { userId: string; role: string } }>(
      `/api/workspaces/${workspaceId}/members`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  removeMember: (workspaceId: string, userId: string) =>
    request<{ removed: string }>(`/api/workspaces/${workspaceId}/members`, {
      method: 'DELETE',
      body: JSON.stringify({ userId }),
    }),

  tokens: (workspaceId: string) =>
    request<{ tokens: TokenSummary[] }>(`/api/workspaces/${workspaceId}/tokens`),

  createToken: (workspaceId: string, input: { name: string; scopes: Array<'read' | 'write'> }) =>
    request<CreatedToken>(`/api/workspaces/${workspaceId}/tokens`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  revokeToken: (workspaceId: string, tokenId: string) =>
    request<{ revoked: string }>(`/api/workspaces/${workspaceId}/tokens`, {
      method: 'DELETE',
      body: JSON.stringify({ tokenId }),
    }),

  /**
   * List a workspace's documents. Served by the per-workspace runtime under
   * /w/:slug/, not the dashboard API — the session cookie authenticates it.
   */
  documents: (slug: string) =>
    request<{ documents: DocumentSummary[] }>(`/w/${slug}/api/documents`),

  snapshots: (workspaceId: string, docId: string) =>
    request<{ snapshots: Snapshot[] }>(`/api/workspaces/${workspaceId}/docs/${docId}/snapshots`),

  createSnapshot: (workspaceId: string, docId: string, input: { label: string }) =>
    request<{ id: string; rev: number; kind: 'named'; label: string }>(
      `/api/workspaces/${workspaceId}/docs/${docId}/snapshots`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  restoreSnapshot: (workspaceId: string, docId: string, snapshotId: string) =>
    request<{ rev: number }>(`/api/workspaces/${workspaceId}/docs/${docId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ snapshotId }),
    }),

  shareLinks: (workspaceId: string, docId: string) =>
    request<{ shareLinks: ShareLink[] }>(
      `/api/workspaces/${workspaceId}/share-links?docId=${encodeURIComponent(docId)}`,
    ),

  createShareLink: (workspaceId: string, input: { docId: string; expiresInDays?: number }) =>
    request<{ token: string; url: string; docId: string; expiresAt: string | null }>(
      `/api/workspaces/${workspaceId}/share-links`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  revokeShareLink: (workspaceId: string, token: string) =>
    request<{ revoked: string }>(`/api/workspaces/${workspaceId}/share-links`, {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    }),
};
