import type http from 'node:http';
import { handleAssetUpload, serveAsset } from './assets.js';
import { ANONYMOUS, check, type AuthContext, type AuthHooks, type AuthzResult } from './auth/types.js';
import { exportProject } from './export.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { DocumentStore } from './store/DocumentStore.js';
import type { StorageAdapter } from './storage/StorageAdapter.js';
import { WsHub } from './sync/wsHub.js';

export interface PitoletRuntimeOptions {
  storage: StorageAdapter;
  /** Authentication/authorization hooks — absent = open server. */
  auth?: AuthHooks;
}

export interface PitoletRuntime {
  store: DocumentStore;
  hub: WsHub;
  adapter: StorageAdapter;
  mcpHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx?: AuthContext,
  ) => Promise<void>;
  /**
   * Dispatch /mcp, /api/assets, /assets-store/* and /api/* requests.
   * Returns false when the pathname is not runtime-owned (static assets,
   * editor SPA — the caller's concern). `ctx` is the authenticated request
   * context (defaults to ANONYMOUS); authorize checks run per-route here
   * regardless of how the caller gated authentication.
   */
  handleRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    ctx?: AuthContext,
  ) => boolean;
}

/**
 * Everything that makes a Pitolet server except the HTTP listener itself:
 * the authoritative store, WS hub, storage wiring and request dispatch.
 * createApp wraps this in http.createServer + static editor serving.
 */
export async function createRuntime(options: PitoletRuntimeOptions): Promise<PitoletRuntime> {
  const adapter = options.storage;
  const auth = options.auth;
  const store = new DocumentStore();

  for (const { doc, rev } of await adapter.loadAll()) store.load(doc, rev);

  // Persist every applied patch (the adapter owns debouncing).
  store.subscribe((patch) => {
    const entry = store.get(patch.docId);
    if (entry) adapter.handlePatch(patch, entry.doc);
  });

  const hub = new WsHub(store, auth);

  // External storage edits (git, agents editing JSON directly) reload + rebroadcast.
  adapter.onExternalChange?.((doc) => {
    store.replace(doc);
    hub.broadcastDocument(doc.id);
    console.log(`[pitolet] reloaded ${doc.name} from disk (external change)`);
  });

  const mcpHandler = createMcpHandler(store, hub, adapter);

  const handleRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    ctx: AuthContext = ANONYMOUS,
  ): boolean => {
    if (pathname === '/mcp') {
      const result = check(auth, ctx, 'mcp:connect');
      if (!result.ok) {
        deny(res, ctx, result);
        return true;
      }
      mcpHandler(req, res, ctx).catch((err) => fail(res, 'mcp request failed', err));
      return true;
    }

    if (pathname === '/api/assets' && req.method === 'POST') {
      const result = check(auth, ctx, 'asset:write');
      if (!result.ok) {
        deny(res, ctx, result);
        return true;
      }
      // A client aborting mid-upload rejects the body iteration — that must
      // never become an unhandled rejection (process crash), just a dead request.
      handleAssetUpload(req, res, adapter.assets).catch((err) =>
        fail(res, 'asset upload failed', err),
      );
      return true;
    }

    if (pathname.startsWith('/assets-store/')) {
      const result = check(auth, ctx, 'asset:read');
      if (!result.ok) {
        deny(res, ctx, result);
        return true;
      }
      serveAsset(pathname.slice('/assets-store/'.length), res, adapter.assets).catch((err) =>
        fail(res, 'asset serve failed', err),
      );
      return true;
    }

    if (pathname.startsWith('/api/')) {
      handleApi(pathname, req, res, store, adapter, auth, ctx);
      return true;
    }

    return false;
  };

  return { store, hub, adapter, mcpHandler, handleRequest };
}

/** Terminal error handler for fire-and-forget request handlers. */
function fail(res: http.ServerResponse, label: string, err: unknown): void {
  // Aborted requests (client went away) are routine — don't log a stack.
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code !== 'ECONNRESET' && code !== 'ERR_STREAM_PREMATURE_CLOSE') {
    console.error(`[pitolet] ${label}:`, err);
  }
  if (!res.headersSent) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  } else {
    res.end();
  }
}

/** 401 for anonymous/unauthenticated denials, 403 (or the hook's status) otherwise. */
function deny(res: http.ServerResponse, ctx: AuthContext, result: AuthzResult & { ok: false }): void {
  const status = result.status ?? (ctx.kind === 'anonymous' ? 401 : 403);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({ error: result.reason ?? (status === 401 ? 'unauthorized' : 'forbidden') }),
  );
}

function handleApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: DocumentStore,
  adapter: StorageAdapter,
  auth: AuthHooks | undefined,
  ctx: AuthContext,
): void {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (pathname === '/api/health') {
    json(200, { ok: true, name: 'pitolet', dataDir: adapter.exportBaseDir });
    return;
  }

  if (pathname === '/api/documents' && req.method === 'GET') {
    const result = check(auth, ctx, 'doc:list');
    if (!result.ok) {
      deny(res, ctx, result);
      return;
    }
    // Share contexts see only their document.
    const documents = store.list().filter((d) => ctx.docId === undefined || d.id === ctx.docId);
    json(200, { documents });
    return;
  }

  // Export requires a local directory to write into — a capability only
  // some storage adapters provide.
  const exportBaseDir = adapter.exportBaseDir;
  if (pathname === '/api/export' && req.method === 'POST' && exportBaseDir !== undefined) {
    const pre = check(auth, ctx, 'export');
    if (!pre.ok) {
      deny(res, ctx, pre);
      return;
    }
    readBody(req)
      .then((body) => {
        try {
          const { docId } = JSON.parse(body || '{}') as { docId?: string };
          const entry = docId ? store.get(docId) : store.get(store.list()[0]?.id ?? '');
          if (!entry) {
            json(404, { error: 'document not found' });
            return;
          }
          // Re-check with the resolved doc so per-document policies apply.
          const result = check(auth, ctx, 'export', entry.doc.id);
          if (!result.ok) {
            deny(res, ctx, result);
            return;
          }
          const { dir } = exportProject(entry.doc, exportBaseDir);
          json(200, { dir });
        } catch (err) {
          json(500, { error: err instanceof Error ? err.message : 'export failed' });
        }
      })
      // Rejected body read (too large, client abort) must not crash the process.
      .catch((err) => fail(res, 'export request failed', err));
    return;
  }

  json(404, { error: 'not found' });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error('body too large'));
        req.destroy(); // stop buffering — the promise is already settled
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
