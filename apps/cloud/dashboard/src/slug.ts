/**
 * Client-side slug validation — MIRRORS apps/cloud/src/cloud/workspaces.ts
 * (SLUG_PATTERN + RESERVED_SLUGS). The server is authoritative; this only
 * gives fast inline feedback and a live suggestion from the workspace name.
 * Keep in sync if the server rules change.
 */

export const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9]){1,38}$/;

const RESERVED_SLUGS = new Set([
  'api',
  'auth',
  'www',
  'app',
  'admin',
  's',
  'w',
  'assets',
  'mcp',
  'ws',
  'docs',
  'billing',
]);

/** null = valid; otherwise a human-readable reason. */
export function slugError(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) {
    return '2–40 chars, lowercase letters/digits, single dashes between';
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved`;
  return null;
}

/** Derive a candidate slug from a display name (best-effort, may be invalid). */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
