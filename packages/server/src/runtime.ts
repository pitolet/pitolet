import {
  createDocument,
  structuralProblems,
  validateDocument,
  type PitoletDocument,
} from '@pitolet/schema';
import type http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { handleAssetUpload, serveAsset } from './assets.js';
import {
  ANONYMOUS,
  check,
  type AuthContext,
  type AuthHooks,
  type AuthzResult,
} from './auth/types.js';
import { exportProject } from './export.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { DocumentStore } from './store/DocumentStore.js';
import { ASSET_ID_PATTERN, assetMimeForId, type StorageAdapter } from './storage/StorageAdapter.js';
import { WsHub } from './sync/wsHub.js';

const importLocks = new Map<string, Promise<void>>();

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

  const mcpHandler = createMcpHandler(store, hub, adapter, auth);

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
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          allow: 'GET, HEAD',
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return true;
      }
      const assetId = pathname.slice('/assets-store/'.length);
      const result = check(auth, ctx, 'asset:read', ctx.docId);
      if (!result.ok) {
        deny(res, ctx, result);
        return true;
      }
      // A document-scoped share must not become a workspace-wide asset
      // capability. Content ids are deterministic, so obscurity is not an
      // authorization boundary.
      if (ctx.kind === 'share' && ctx.docId) {
        const sharedDocument = store.get(ctx.docId)?.doc;
        if (!sharedDocument || !documentReferencesAsset(sharedDocument, assetId)) {
          deny(res, ctx, {
            ok: false,
            status: 403,
            reason: 'asset is outside the shared document',
          });
          return true;
        }
      }
      serveAsset(assetId, res, adapter.assets, { head: req.method === 'HEAD' }).catch((err) =>
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

function documentReferencesAsset(document: PitoletDocument, assetId: string): boolean {
  // The manifest is the document-scoped asset capability. It includes
  // resources that are not node sources, such as imported web fonts.
  if (document.assets[assetId]) return true;
  for (const node of Object.values(document.nodes)) {
    if (node.type === 'image' && 'asset' in node.src && node.src.asset === assetId) return true;
    if (node.type !== 'instance') continue;
    for (const override of Object.values(node.overrides)) {
      if (override.src && 'asset' in override.src && override.src.asset === assetId) return true;
    }
  }
  return false;
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
function deny(
  res: http.ServerResponse,
  ctx: AuthContext,
  result: AuthzResult & { ok: false },
): void {
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
    json(200, { ok: true, name: 'pitolet' });
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

  if (pathname === '/api/documents' && req.method === 'POST') {
    const result = check(auth, ctx, 'doc:create');
    if (!result.ok) {
      deny(res, ctx, result);
      return;
    }
    readBody(req, 4096)
      .then(async (body) => {
        let name: string;
        try {
          const parsed = JSON.parse(body || '{}') as { name?: unknown };
          if (typeof parsed.name !== 'string') throw new Error('name is required');
          name = parsed.name.trim();
          if (name.length === 0) throw new Error('name is required');
          if (name.length > 120) throw new Error('name must be 120 characters or fewer');
        } catch (err) {
          json(400, {
            error: err instanceof Error ? err.message : 'invalid document request',
          });
          return;
        }

        const document = createDocument({ name });
        try {
          await adapter.saveNow(document, 0);
          store.load(document, 0);
          json(201, { docId: document.id, name: document.name });
        } catch (err) {
          console.error('[pitolet] document creation failed:', err);
          json(500, { error: 'document creation failed' });
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          json((err as BodyTooLargeError).tooLarge ? 413 : 400, {
            error: err instanceof Error ? err.message : 'invalid document request',
          });
        }
      });
    return;
  }

  if (pathname === '/api/import' && req.method === 'GET') {
    const result = check(auth, ctx, 'doc:create');
    if (!result.ok) {
      deny(res, ctx, result);
      return;
    }
    json(200, {
      ok: true,
      maxDocumentBytes: MAX_IMPORT_BYTES,
      maxNodes: MAX_IMPORT_NODES,
      maxDepth: MAX_IMPORT_DEPTH,
    });
    return;
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    const result = check(auth, ctx, 'doc:create');
    if (!result.ok) {
      deny(res, ctx, result);
      return;
    }
    readBody(req, MAX_IMPORT_BYTES)
      .then(async (body) => {
        let document: PitoletDocument;
        try {
          document = validateImportedDocument(JSON.parse(body || '{}'));
        } catch (err) {
          json(400, { error: err instanceof Error ? err.message.slice(0, 500) : 'invalid import' });
          return;
        }
        await withImportLock(document.id, async () => {
          const existing = store.get(document.id);
          if (existing) {
            if (isDeepStrictEqual(existing.doc, document)) {
              json(200, { docId: document.id, name: document.name, duplicate: true });
            } else {
              json(409, { error: `document ${document.id} already exists` });
            }
            return;
          }
          try {
            await validateImportedAssets(document, adapter);
          } catch (err) {
            json(400, {
              error: err instanceof Error ? err.message.slice(0, 500) : 'invalid import assets',
            });
            return;
          }
          try {
            await adapter.saveNow(document, 0);
            store.load(document, 0);
            json(201, { docId: document.id, name: document.name, duplicate: false });
          } catch (err) {
            console.error('[pitolet] imported document persistence failed:', err);
            json(500, { error: 'import could not be saved' });
          }
        });
      })
      .catch((err) => {
        if (!res.headersSent) {
          json((err as BodyTooLargeError).tooLarge ? 413 : 400, {
            error: err instanceof Error ? err.message : 'invalid import body',
          });
        }
      });
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
      .then(async (body) => {
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
          const { dir } = await exportProject(entry.doc, exportBaseDir, {}, adapter.assets);
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

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_NODES = 10_000;
const MAX_IMPORT_DEPTH = 100;

interface BodyTooLargeError extends Error {
  tooLarge?: true;
}

function readBody(req: http.IncomingMessage, limit = 10_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredSize = Number(req.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > limit) {
      const err = new Error(`body exceeds ${limit} bytes`) as BodyTooLargeError;
      err.tooLarge = true;
      req.resume();
      reject(err);
      return;
    }
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      body += chunk;
      if (bytes > limit) {
        tooLarge = true;
        body = '';
        const err = new Error(`body exceeds ${limit} bytes`) as BodyTooLargeError;
        err.tooLarge = true;
        reject(err);
      }
    });
    req.on('end', () => {
      if (!tooLarge) resolve(body);
    });
    req.on('error', reject);
  });
}

function validateImportedDocument(raw: unknown): PitoletDocument {
  const document = validateDocument(raw);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(document.id)) {
    throw new Error(
      'import document id must contain 1–128 letters, numbers, underscores, or hyphens',
    );
  }
  const name = document.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new Error('import document name must contain 1–120 characters');
  }
  document.name = name;
  const nodeCount = Object.keys(document.nodes).length;
  if (nodeCount > MAX_IMPORT_NODES) {
    throw new Error(`import has ${nodeCount} nodes; maximum is ${MAX_IMPORT_NODES}`);
  }
  const problems = structuralProblems(document);
  if (problems.length > 0) throw new Error(`invalid document structure: ${problems[0]}`);

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string, depth: number): void => {
    if (depth > MAX_IMPORT_DEPTH) {
      throw new Error(`import tree exceeds maximum depth ${MAX_IMPORT_DEPTH}`);
    }
    if (visiting.has(nodeId)) throw new Error(`import tree contains a cycle at ${nodeId}`);
    if (visited.has(nodeId)) return;
    const node = document.nodes[nodeId];
    if (!node) return;
    visiting.add(nodeId);
    for (const childId of node.children) visit(childId, depth + 1);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const rootId of document.rootOrder) visit(rootId, 1);
  for (const component of Object.values(document.components)) visit(component.rootId, 1);
  if (visited.size !== nodeCount) {
    throw new Error(`import contains ${nodeCount - visited.size} unreachable node(s)`);
  }
  return document;
}

async function validateImportedAssets(
  document: PitoletDocument,
  adapter: StorageAdapter,
): Promise<void> {
  const referenced = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.type === 'image' && 'asset' in node.src) referenced.add(node.src.asset);
    if (node.type === 'instance') {
      for (const override of Object.values(node.overrides)) {
        if (override.src && 'asset' in override.src) referenced.add(override.src.asset);
      }
    }
  }
  for (const assetId of referenced) {
    if (!document.assets[assetId]) throw new Error(`image references undeclared asset ${assetId}`);
  }
  for (const [assetId, metadata] of Object.entries(document.assets)) {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      throw new Error(`document contains invalid asset id ${assetId.slice(0, 100)}`);
    }
    const expectedMime = assetMimeForId(assetId);
    if (metadata.mime !== expectedMime) {
      throw new Error(
        `asset ${assetId} metadata type ${metadata.mime} does not match ${expectedMime}`,
      );
    }
    if (metadata.fontFace && expectedMime !== 'font/woff' && expectedMime !== 'font/woff2') {
      throw new Error(`asset ${assetId} declares a font face but is not a supported web font`);
    }
    const stored = await adapter.assets.get(assetId);
    if (!stored) throw new Error(`declared asset ${assetId} was not uploaded`);
    if (stored.mime !== expectedMime) {
      stored.stream.destroy();
      throw new Error(`stored asset ${assetId} has unexpected type ${stored.mime}`);
    }
    stored.stream.destroy();
  }
}

async function withImportLock<T>(docId: string, action: () => Promise<T>): Promise<T> {
  const previous = importLocks.get(docId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  importLocks.set(docId, current);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (importLocks.get(docId) === current) importLocks.delete(docId);
  }
}
