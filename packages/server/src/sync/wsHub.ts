import type { ClientMessage, NodeId, PatchActor, ServerMessage } from '@pitolet/schema';
import { nanoid } from 'nanoid';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { actorFromContext, ANONYMOUS, check, type AuthContext, type AuthHooks } from '../auth/types.js';
import { DocumentStore, PatchRejectedError } from '../store/DocumentStore.js';

interface Client {
  id: string;
  socket: WebSocket;
  openDocs: Set<string>;
  selection: NodeId[];
  ctx: AuthContext;
}

interface PendingScreenshot {
  resolve: (dataUrl: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * WebSocket hub connecting editor clients to the authoritative store.
 * Patches broadcast to every subscribed client except their author (the
 * author gets an ack). MCP-originated patches (applied straight to the
 * store) broadcast to everyone via the store subscription.
 */
export class WsHub {
  private clients = new Map<string, Client>();
  private pendingScreenshots = new Map<string, PendingScreenshot>();
  private wss = new WebSocketServer({ noServer: true });

  constructor(
    private store: DocumentStore,
    private auth?: AuthHooks,
  ) {
    store.subscribe((patch) => {
      // Editor-originated patches are broadcast in handlePatch (so the author
      // can be excluded); store-level subscribers only see non-editor origins.
      if (patch.origin.startsWith('editor:')) return;
      this.broadcast(patch.docId, {
        t: 'patch',
        docId: patch.docId,
        rev: patch.rev,
        origin: patch.origin,
        label: patch.label,
        ops: patch.ops,
        ...(patch.actor ? { actor: patch.actor } : {}),
      });
    });
  }

  /**
   * Convenience wiring for a plain http.Server: upgrade /ws requests into
   * hub connections; reject anything else (same 400-and-drop the ws library
   * applied when it owned the upgrade with `path: '/ws'`).
   */
  attach(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/ws') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      // Authenticate BEFORE the upgrade completes — an unauthenticated
      // socket never becomes a hub client. Browser clients carry the
      // session cookie automatically (same-origin upgrade request).
      void (async () => {
        let ctx: AuthContext = ANONYMOUS;
        if (this.auth?.authenticate) {
          const resolved = await this.auth.authenticate(req).catch(() => null);
          if (resolved === null) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
          }
          ctx = resolved;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws, ctx));
      })();
    });
  }

  /** Wire an accepted WebSocket into the hub (upgrade + auth handled by the caller). */
  handleConnection(socket: WebSocket, ctx: AuthContext = ANONYMOUS): void {
    const client: Client = { id: nanoid(8), socket, openDocs: new Set(), selection: [], ctx };
    this.clients.set(client.id, client);
    socket.on('message', (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        this.send(client, { t: 'error', message: 'malformed message' });
        return;
      }
      this.handle(client, message);
    });
    socket.on('close', () => this.clients.delete(client.id));
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Current selection of any connected editor (first client with one). */
  getSelection(docId: string): NodeId[] {
    for (const client of this.clients.values()) {
      if (client.openDocs.has(docId) && client.selection.length > 0) return client.selection;
    }
    return [];
  }

  /** Push a selection to editors (MCP set_selection). */
  setSelection(docId: string, nodeIds: NodeId[], origin: string): void {
    this.broadcast(docId, { t: 'selection', docId, nodeIds, origin });
  }

  hasEditorFor(docId: string): boolean {
    return [...this.clients.values()].some((c) => c.openDocs.has(docId));
  }

  /** Ask a connected editor to rasterize a frame (used by MCP get_screenshot). */
  requestScreenshot(docId: string, frameId: NodeId, maxSize: number): Promise<string> {
    const target = [...this.clients.values()].find((c) => c.openDocs.has(docId));
    if (!target) {
      return Promise.reject(
        new Error('no editor is currently viewing this document — open it in Pitolet first'),
      );
    }
    const reqId = nanoid(8);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingScreenshots.delete(reqId);
        reject(new Error('screenshot timed out'));
      }, 10_000);
      this.pendingScreenshots.set(reqId, { resolve, reject, timer });
      this.send(target, { t: 'request-screenshot', reqId, frameId, maxSize });
    });
  }

  private handle(client: Client, message: ClientMessage): void {
    switch (message.t) {
      case 'open': {
        // Defense in depth: per-message authorization on top of upgrade auth.
        const authz = check(this.auth, client.ctx, 'doc:read', message.docId);
        if (!authz.ok) {
          this.send(client, {
            t: 'error',
            message: authz.reason ?? `not authorized to open ${message.docId}`,
          });
          return;
        }
        const entry = this.store.get(message.docId);
        if (!entry) {
          this.send(client, { t: 'error', message: `unknown document ${message.docId}` });
          return;
        }
        client.openDocs.add(message.docId);
        this.send(client, {
          t: 'doc',
          docId: message.docId,
          rev: entry.rev,
          document: entry.doc,
        });
        break;
      }
      case 'patch': {
        // Same reject shape as an invalid patch — the editor rolls back on it.
        const authz = check(this.auth, client.ctx, 'doc:write', message.docId);
        if (!authz.ok) {
          this.send(client, {
            t: 'reject',
            patchId: message.patchId,
            reason: authz.reason ?? 'not authorized to edit this document',
          });
          return;
        }
        try {
          const actor = actorFromContext(client.ctx);
          const rev = this.store.applyPatch(
            message.docId,
            message.ops,
            `editor:${client.id}`,
            message.label,
            actor,
          );
          this.send(client, { t: 'ack', patchId: message.patchId, rev });
          this.broadcast(
            message.docId,
            {
              t: 'patch',
              docId: message.docId,
              rev,
              origin: `editor:${client.id}`,
              label: message.label,
              ops: message.ops,
              ...(actor ? { actor } : {}),
            },
            client.id,
          );
        } catch (err) {
          const reason = err instanceof PatchRejectedError ? err.message : 'internal error';
          if (!(err instanceof PatchRejectedError)) console.error('[pitolet] patch error:', err);
          this.send(client, { t: 'reject', patchId: message.patchId, reason });
        }
        break;
      }
      case 'select': {
        client.selection = message.nodeIds;
        break;
      }
      case 'screenshot-result': {
        const pending = this.pendingScreenshots.get(message.reqId);
        if (pending) {
          this.pendingScreenshots.delete(message.reqId);
          clearTimeout(pending.timer);
          if (message.dataUrl) pending.resolve(message.dataUrl);
          else pending.reject(new Error(message.error ?? 'screenshot failed'));
        }
        break;
      }
    }
  }

  /** Broadcast a full document reload (external file change). */
  broadcastDocument(docId: string): void {
    const entry = this.store.get(docId);
    if (!entry) return;
    this.broadcast(docId, { t: 'doc', docId, rev: entry.rev, document: entry.doc });
  }

  private broadcast(docId: string, message: ServerMessage, excludeClientId?: string): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.id === excludeClientId) continue;
      if (!client.openDocs.has(docId)) continue;
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(message));
    }
  }
}
