import { useSyncExternalStore } from 'react';

/**
 * Minimal history-based router. Three routes matter to the SPA:
 *   /                       → sign-in (signed out) or workspace list (signed in)
 *   /workspace/:workspaceId → workspace home
 *   /workspace/:workspaceId/documents[/docId] → documents and document details
 *   /workspace/:workspaceId/people → members
 *   /workspace/:workspaceId/settings → agent connections and plan
 * Legacy /docs/:id and /settings/:id routes remain parseable.
 * The cloud server serves index.html for any non-API/-auth/-/w path, so a deep
 * link to /settings/:id or /docs/:id hydrates here. react-router is deliberately
 * not used.
 */

export type Route =
  | { name: 'home' }
  | { name: 'admin-overview' }
  | { name: 'admin-users' }
  | { name: 'admin-user'; userId: string }
  | { name: 'admin-feedback' }
  | { name: 'admin-feedback-detail'; feedbackId: string }
  | { name: 'admin-problems' }
  | { name: 'workspace'; workspaceId: string }
  | { name: 'workspace-documents'; workspaceId: string }
  | { name: 'workspace-document'; workspaceId: string; docId: string }
  | { name: 'workspace-people'; workspaceId: string }
  | { name: 'workspace-settings'; workspaceId: string };

export function parse(pathname: string): Route {
  const adminUser = /^\/admin\/users\/([^/]+)\/?$/.exec(pathname);
  if (adminUser) return { name: 'admin-user', userId: decodeURIComponent(adminUser[1]!) };
  const adminFeedbackDetail = /^\/admin\/feedback\/([0-9a-f-]{36})\/?$/.exec(pathname);
  if (adminFeedbackDetail)
    return { name: 'admin-feedback-detail', feedbackId: adminFeedbackDetail[1]! };
  if (/^\/admin\/users\/?$/.test(pathname)) return { name: 'admin-users' };
  if (/^\/admin\/feedback\/?$/.test(pathname)) return { name: 'admin-feedback' };
  if (/^\/admin\/problems\/?$/.test(pathname)) return { name: 'admin-problems' };
  if (/^\/admin\/?$/.test(pathname)) return { name: 'admin-overview' };
  const detail = /^\/workspace\/([^/]+)\/documents\/([^/]+)\/?$/.exec(pathname);
  if (detail) {
    return {
      name: 'workspace-document',
      workspaceId: decodeURIComponent(detail[1]!),
      docId: decodeURIComponent(detail[2]!),
    };
  }
  const documents = /^\/workspace\/([^/]+)\/documents\/?$/.exec(pathname);
  if (documents) {
    return { name: 'workspace-documents', workspaceId: decodeURIComponent(documents[1]!) };
  }
  const people = /^\/workspace\/([^/]+)\/people\/?$/.exec(pathname);
  if (people) {
    return { name: 'workspace-people', workspaceId: decodeURIComponent(people[1]!) };
  }
  const workspaceSettings = /^\/workspace\/([^/]+)\/settings\/?$/.exec(pathname);
  if (workspaceSettings) {
    return {
      name: 'workspace-settings',
      workspaceId: decodeURIComponent(workspaceSettings[1]!),
    };
  }
  const workspace = /^\/workspace\/([^/]+)\/?$/.exec(pathname);
  if (workspace) {
    return { name: 'workspace', workspaceId: decodeURIComponent(workspace[1]!) };
  }

  // Backward-compatible aliases for bookmarks from the first dashboard.
  const settings = /^\/settings\/([^/]+)\/?$/.exec(pathname);
  if (settings) {
    return { name: 'workspace-settings', workspaceId: decodeURIComponent(settings[1]!) };
  }
  const docs = /^\/docs\/([^/]+)\/?$/.exec(pathname);
  if (docs) {
    return { name: 'workspace-documents', workspaceId: decodeURIComponent(docs[1]!) };
  }
  return { name: 'home' };
}

export function workspacePath(
  workspaceId: string,
  page: 'home' | 'documents' | 'people' | 'settings' = 'home',
): string {
  const base = `/workspace/${encodeURIComponent(workspaceId)}`;
  return page === 'home' ? base : `${base}/${page}`;
}

export function workspaceIdFromRoute(route: Route): string | null {
  return 'workspaceId' in route ? route.workspaceId : null;
}

export function adminPath(
  page: 'overview' | 'users' | 'feedback' | 'problems' = 'overview',
): string {
  return page === 'overview' ? '/admin' : `/admin/${page}`;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  );
  return parse(pathname);
}
