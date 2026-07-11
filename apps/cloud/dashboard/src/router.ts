import { useSyncExternalStore } from 'react';

/**
 * Minimal history-based router. Three routes matter to the SPA:
 *   /                       → sign-in (signed out) or workspace list (signed in)
 *   /settings/:workspaceId  → members / tokens tabs
 *   /docs/:workspaceId      → per-document version history + share links
 * The cloud server serves index.html for any non-API/-auth/-/w path, so a deep
 * link to /settings/:id or /docs/:id hydrates here. react-router is deliberately
 * not used.
 */

export type Route =
  | { name: 'home' }
  | { name: 'settings'; workspaceId: string }
  | { name: 'docs'; workspaceId: string };

export function parse(pathname: string): Route {
  const settings = /^\/settings\/([^/]+)\/?$/.exec(pathname);
  if (settings) return { name: 'settings', workspaceId: decodeURIComponent(settings[1]!) };
  const docs = /^\/docs\/([^/]+)\/?$/.exec(pathname);
  if (docs) return { name: 'docs', workspaceId: decodeURIComponent(docs[1]!) };
  return { name: 'home' };
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
