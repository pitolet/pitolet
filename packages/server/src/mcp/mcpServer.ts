import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type http from 'node:http';
import type { AuthContext, AuthHooks } from '../auth/types.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { DocumentStore } from '../store/DocumentStore.js';
import type { WsHub } from '../sync/wsHub.js';
import { registerTools } from './tools.js';

/**
 * Streamable-HTTP MCP endpoint at /mcp — stateless mode (each request gets
 * a fresh server+transport pair; the document store is the shared state).
 *
 * Client config:
 *   claude mcp add --transport http pitolet http://localhost:4517/mcp
 */
export const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;

export function createMcpHandler(
  store: DocumentStore,
  hub: WsHub,
  adapter: StorageAdapter,
  auth?: AuthHooks,
) {
  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx?: AuthContext,
  ): Promise<void> => {
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405).end();
      return;
    }
    // Stateless: GET (SSE resumption) and DELETE (session teardown) are no-ops.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'stateless server: POST only' },
          id: null,
        }),
      );
      return;
    }

    const server = new McpServer({ name: 'pitolet', version: '0.1.0' });
    registerTools(server, store, hub, adapter, { ctx, auth });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport
        .close()
        .catch((error) => console.error('[pitolet] MCP transport cleanup failed:', error));
      void server
        .close()
        .catch((error) => console.error('[pitolet] MCP server cleanup failed:', error));
    });

    try {
      const body = await readJsonBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const status =
        err instanceof McpBodyError ? err.status : err instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error('[pitolet] mcp request failed:', err);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: status === 413 ? -32001 : status === 400 ? -32700 : -32603,
              message:
                status === 413
                  ? `request body exceeds ${MAX_MCP_BODY_BYTES} bytes`
                  : status === 400
                    ? 'invalid JSON request'
                    : 'internal error',
            },
            id: null,
          }),
        );
      }
    }
  };
}

class McpBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = 'McpBodyError';
  }
}

export async function readJsonBody(
  req: http.IncomingMessage,
  limit = MAX_MCP_BODY_BYTES,
): Promise<unknown> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new McpBodyError(`request body exceeds ${limit} bytes`, 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new McpBodyError(`request body exceeds ${limit} bytes`, 413);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new McpBodyError('invalid JSON request', 400);
  }
}
