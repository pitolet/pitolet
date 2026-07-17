import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { createBrotliCompress, createGzip } from 'node:zlib';
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
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
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
    setSecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && !sameOriginRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-origin mutation rejected' }));
      return;
    }

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
      serveStatic(options.editorDist, pathname, req, res);
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
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxConnections = 1_000;

  runtime.hub.attach(server);

  return { server, store: runtime.store, hub: runtime.hub, adapter: storage };
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; " +
      "connect-src 'self' ws: wss: https://fonts.googleapis.com; " +
      "object-src 'none'; base-uri 'self'; " +
      "frame-ancestors 'none'; form-action 'self'",
  );
}

function sameOriginRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function serveStatic(
  root: string,
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const resolvedRoot = resolve(root);
  let filePath = resolve(resolvedRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${sep}`)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(resolvedRoot, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404).end('editor build not found — run `pnpm build` first');
      return;
    }
  }
  const extension = extname(filePath);
  const headers: Record<string, string> = {
    'content-type': MIME[extension] ?? 'application/octet-stream',
    'cache-control':
      extension === '.html'
        ? 'no-cache'
        : /[-.][a-f0-9]{8,}\./i.test(filePath)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
  };
  const compressible = ['.html', '.js', '.css', '.json', '.svg'].includes(extension);
  const accepted = String(req.headers['accept-encoding'] ?? '');
  const encoding = compressible
    ? accepted.includes('br')
      ? 'br'
      : accepted.includes('gzip')
        ? 'gzip'
        : undefined
    : undefined;
  if (encoding) {
    headers['content-encoding'] = encoding;
    headers.vary = 'Accept-Encoding';
  } else {
    headers['content-length'] = String(statSync(filePath).size);
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error('[pitolet] static file read failed:', error);
    res.destroy();
  });
  if (encoding) {
    const compressor = encoding === 'br' ? createBrotliCompress() : createGzip();
    compressor.on('error', (error) => {
      console.error('[pitolet] static compression failed:', error);
      res.destroy();
    });
    stream.pipe(compressor).pipe(res);
  } else {
    stream.pipe(res);
  }
}
