import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { ANONYMOUS, type AuthContext, type AuthHooks } from './auth/types.js';
import { createRuntime } from './runtime.js';
import { FileStorageAdapter } from './storage/FileStorageAdapter.js';
import type { StorageAdapter } from './storage/StorageAdapter.js';
import type { DocumentStore } from './store/DocumentStore.js';
import type { WsHub } from './sync/wsHub.js';

export interface PitoletServerOptions {
  port: number;
  /** Directory holding *.pitolet.json documents (used when no storage adapter is given). */
  dataDir?: string;
  /** Built editor SPA to serve statically (production mode). */
  editorDist?: string;
  /** Storage backend — defaults to FileStorageAdapter(dataDir). */
  storage?: StorageAdapter;
  /** Auth hooks (e.g. sharedPasswordAuth). Absent = open server. */
  auth?: AuthHooks;
}

export interface PitoletApp {
  server: http.Server;
  store: DocumentStore;
  hub: WsHub;
  adapter: StorageAdapter;
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

/**
 * Public allowlist when auth is enabled: exactly what an unauthenticated
 * browser needs to reach the login screen. Everything runtime-owned
 * (/api/*, /assets-store/*, /mcp) is protected; static editor assets are
 * public (the SPA must load to show the login form).
 */
function isProtected(method: string | undefined, pathname: string): boolean {
  if (pathname === '/api/health' && method === 'GET') return false;
  if (pathname === '/api/login' && method === 'POST') return false;
  return (
    pathname === '/mcp' || pathname.startsWith('/api/') || pathname.startsWith('/assets-store')
  );
}

export async function createApp(options: PitoletServerOptions): Promise<PitoletApp> {
  let storage = options.storage;
  if (!storage) {
    if (!options.dataDir) throw new Error('createApp requires either `storage` or `dataDir`');
    storage = new FileStorageAdapter(options.dataDir);
  }

  const auth = options.auth;
  const runtime = await createRuntime({ storage, auth });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // Login is owned by the auth hooks (they know the credential + cookie).
    if (pathname === '/api/login' && req.method === 'POST' && auth?.handleLogin) {
      await auth.handleLogin(req, res);
      return;
    }

    // Authentication gate: when a hook is configured, every protected route
    // requires a resolved context BEFORE any dispatch.
    let ctx: AuthContext = ANONYMOUS;
    if (auth?.authenticate) {
      const resolved = await auth.authenticate(req);
      if (resolved === null && isProtected(req.method, pathname)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      ctx = resolved ?? ANONYMOUS;
    }

    if (runtime.handleRequest(req, res, pathname, ctx)) return;

    if (options.editorDist) {
      serveStatic(options.editorDist, pathname, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found (editor dev server runs separately in dev mode)');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[pitolet] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    });
  });

  runtime.hub.attach(server);

  return { server, store: runtime.store, hub: runtime.hub, adapter: storage };
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse): void {
  let filePath = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(normalize(root))) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404).end('editor build not found — run `pnpm build` first');
      return;
    }
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}
