/**
 * Base-path awareness for a future hosted deployment at `/w/:workspaceSlug/`.
 *
 * Today the editor is served from the site root, so `serverBase` is `''` and
 * every helper here is a no-op pass-through — the no-auth, root-mounted path is
 * byte-identical to before. When hosted under `/w/acme/`, all server URLs
 * (fetches + the WebSocket + `/assets-store` image srcs) transparently gain
 * that prefix.
 *
 * Share sessions: a `?share=<token>` query on the page URL marks a read-only
 * guest session opened through a public share link. The token is the ONLY
 * credential the guest has, so every server URL built here carries it back as
 * a query parameter (fetches, the WebSocket upgrade, asset image srcs alike).
 *
 * Kept in its own tiny module (no store/connection imports) to avoid cycles —
 * canvas renderers import `assetUrl` from here freely.
 */

/** Extract the `/w/:slug` prefix from a pathname, or `''` when root-mounted. */
export function computeBase(pathname: string): string {
  return pathname.match(/^\/w\/[^/]+/)?.[0] ?? '';
}

/** Extract the share token from a location search string, or null. */
export function computeShareToken(search: string): string | null {
  const token = new URLSearchParams(search).get('share');
  return token ? token : null;
}

/**
 * Append the share credential to a server URL. Robust to URLs that already
 * carry their own query string (`?` vs `&`); a null token is a pass-through.
 */
export function appendShareToken(url: string, token: string | null): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}share=${encodeURIComponent(token)}`;
}

/** The server base path, computed once from the current location. */
export const serverBase = computeBase(location.pathname);

/** The share token for this session (`?share=<token>`), read once at boot. */
export const shareToken = computeShareToken(location.search);

/** True when this editor session was opened through a share link (read-only). */
export const isShareSession = shareToken !== null;

/** Prefix a root-absolute server path (e.g. `/api/documents`) with the base. */
export function apiUrl(path: string): string {
  return appendShareToken(`${serverBase}${path}`, shareToken);
}

/** Build an asset-store URL for an `<img>` src, base-aware. */
export function assetUrl(assetId: string): string {
  return appendShareToken(`${serverBase}/assets-store/${assetId}`, shareToken);
}

/** The base-aware WebSocket URL for the sync channel. */
export function wsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return appendShareToken(`${protocol}://${location.host}${serverBase}/ws`, shareToken);
}
