import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type http from 'node:http';
import type { AuthContext } from '../auth/types.js';
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
export function createMcpHandler(store: DocumentStore, hub: WsHub, adapter: StorageAdapter) {
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
    registerTools(server, store, hub, adapter, { ctx });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      const body = await readJsonBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[pitolet] mcp request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        );
      }
    }
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}
