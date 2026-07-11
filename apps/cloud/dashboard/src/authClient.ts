import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * better-auth browser client. The cloud server mounts the auth handler at
 * `/auth/*` (not the better-auth default `/api/auth`), so basePath matches.
 * Same-origin: the SPA is served from the cloud server itself.
 */
export const authClient = createAuthClient({
  basePath: '/auth',
  plugins: [magicLinkClient()],
});
