import {
  MAX_SELECTION_IDS,
  MAX_WS_MESSAGE_BYTES,
  zClientMessage,
  type ClientMessage,
  type NodeId,
  type PatchRejectCode,
  type ServerMessage,
} from '@pitolet/schema';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  actorFromContext,
  ANONYMOUS,
  check,
  type AuthContext,
  type AuthHooks,
} from '../auth/types.js';
import { DocumentStore, PatchRejectedError } from '../store/DocumentStore.js';

interface Client {
  id: string;
  socket: WebSocket;
  subscribedDocs: Set<string>;
  selectionByDoc: Map<string, NodeId[]>;
  ctx: AuthContext;
  isAlive: boolean;
  protocolViolations: number;
}

interface PendingScreenshot {
  clientId: string;
  docId: string;
  resolve: (dataUrl: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppliedEditorPatch {
  fingerprint: string;
  principal: string;
  rev: number;
}

const MAX_CLIENTS = 250;
const MAX_PROTOCOL_VIOLATIONS = 3;
const MAX_RECENT_PATCH_IDS = 1_000;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket hub connecting editor clients to the authoritative store.
 * Patches broadcast to every subscribed client except their author (the
 * author gets an ack). MCP-originated patches (applied straight to the
 * store) broadcast to everyone via the store subscription.
 */
export class WsHub {
  private clients = new Map<string, Client>();
  private pendingScreenshots = new Map<string, PendingScreenshot>();
  private appliedEditorPatches = new Map<string, Map<string, AppliedEditorPatch>>();
  private heartbeatTimer?: NodeJS.Timeout;
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

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
    server.once('close', () => this.close());
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/ws') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!sameOriginUpgrade(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      if (this.clients.size >= MAX_CLIENTS) {
        socket.write(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
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
            socket.write(
              'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            );
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
    if (this.clients.size >= MAX_CLIENTS) {
      socket.close(1013, 'server has too many editor connections');
      return;
    }
    const client: Client = {
      id: nanoid(8),
      socket,
      subscribedDocs: new Set(),
      selectionByDoc: new Map(),
      ctx,
      isAlive: true,
      protocolViolations: 0,
    };
    this.clients.set(client.id, client);
    this.startHeartbeat();
    socket.on('pong', () => {
      client.isAlive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.protocolViolation(client, 'binary messages are not supported');
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        this.protocolViolation(client, 'malformed JSON message');
        return;
      }
      const parsed = zClientMessage.safeParse(raw);
      if (!parsed.success) {
        this.protocolViolation(client, 'invalid message');
        return;
      }
      try {
        this.handle(client, parsed.data as ClientMessage);
      } catch (error) {
        console.error('[pitolet] WebSocket message handler failed:', error);
        this.send(client, { t: 'error', message: 'internal error while handling message' });
        client.socket.close(1011, 'internal message handler error');
      }
    });
    socket.on('error', () => {
      // The close handler owns cleanup. A protocol/max-payload error on an
      // individual socket must never become an unhandled process error.
    });
    socket.on('close', () => this.removeClient(client));
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const client of this.clients.values()) client.socket.terminate();
    for (const pending of this.pendingScreenshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('editor service is shutting down'));
    }
    this.pendingScreenshots.clear();
    this.clients.clear();
  }

  /** Current selection of any connected editor (first client with one). */
  getSelection(docId: string): NodeId[] {
    for (const client of this.clients.values()) {
      const selection = client.selectionByDoc.get(docId);
      if (client.subscribedDocs.has(docId) && selection && selection.length > 0) return selection;
    }
    return [];
  }

  /** Push a selection to editors (MCP set_selection). */
  setSelection(docId: string, nodeIds: NodeId[], origin: string): void {
    this.broadcast(docId, {
      t: 'selection',
      docId,
      nodeIds: nodeIds.slice(0, MAX_SELECTION_IDS),
      origin,
    });
  }

  hasEditorFor(docId: string): boolean {
    return [...this.clients.values()].some((c) => c.subscribedDocs.has(docId));
  }

  /** Ask a connected editor to rasterize a frame (used by MCP get_screenshot). */
  requestScreenshot(docId: string, frameId: NodeId, maxSize: number): Promise<string> {
    const target = [...this.clients.values()].find((c) => c.subscribedDocs.has(docId));
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
      this.pendingScreenshots.set(reqId, {
        clientId: target.id,
        docId,
        resolve,
        reject,
        timer,
      });
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
        // One editor connection displays one current document. Reopening is
        // also the explicit full-document resync path.
        client.subscribedDocs.clear();
        client.selectionByDoc.clear();
        client.subscribedDocs.add(message.docId);
        this.send(client, {
          t: 'doc',
          docId: message.docId,
          rev: entry.rev,
          document: entry.doc,
          appliedPatchIds: [...(this.appliedEditorPatches.get(message.docId)?.keys() ?? [])],
        });
        break;
      }
      case 'patch': {
        const entry = this.store.get(message.docId);
        if (!entry || !client.subscribedDocs.has(message.docId)) {
          this.rejectPatch(
            client,
            message.docId,
            message.patchId,
            entry?.rev ?? 0,
            'document_not_open',
            entry ? 'open this document before editing it' : `unknown document ${message.docId}`,
          );
          return;
        }
        // Same reject shape as an invalid patch — the editor rolls back on it.
        const authz = check(this.auth, client.ctx, 'doc:write', message.docId);
        if (!authz.ok) {
          this.rejectPatch(
            client,
            message.docId,
            message.patchId,
            entry.rev,
            'forbidden',
            authz.reason ?? 'not authorized to edit this document',
          );
          return;
        }

        const fingerprint = createHash('sha256')
          .update(JSON.stringify({ label: message.label, ops: message.ops }))
          .digest('hex');
        const principal = `${client.ctx.kind}:${client.ctx.userId ?? client.ctx.docId ?? ''}`;
        const previous = this.appliedEditorPatches.get(message.docId)?.get(message.patchId);
        if (previous) {
          if (previous.fingerprint === fingerprint && previous.principal === principal) {
            this.send(client, {
              t: 'ack',
              docId: message.docId,
              patchId: message.patchId,
              rev: previous.rev,
              duplicate: true,
            });
          } else {
            this.rejectPatch(
              client,
              message.docId,
              message.patchId,
              entry.rev,
              'invalid_patch',
              'patch id was already used for different content',
            );
          }
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
            message.baseRev,
          );
          this.rememberAppliedPatch(message.docId, message.patchId, {
            fingerprint,
            principal,
            rev,
          });
          this.send(client, { t: 'ack', docId: message.docId, patchId: message.patchId, rev });
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
          this.rejectPatch(
            client,
            message.docId,
            message.patchId,
            err instanceof PatchRejectedError ? (err.rev ?? entry.rev) : entry.rev,
            err instanceof PatchRejectedError ? err.code : 'invalid_patch',
            reason,
          );
        }
        break;
      }
      case 'select': {
        if (!client.subscribedDocs.has(message.docId)) {
          this.protocolViolation(client, 'selection document is not open');
          return;
        }
        const authz = check(this.auth, client.ctx, 'doc:read', message.docId);
        if (!authz.ok) {
          this.protocolViolation(client, authz.reason ?? 'selection document is unavailable');
          return;
        }
        const entry = this.store.get(message.docId);
        if (!entry) {
          this.protocolViolation(client, 'selection document is unavailable');
          return;
        }
        client.selectionByDoc.set(
          message.docId,
          message.nodeIds.filter((nodeId) => entry.doc.nodes[nodeId]),
        );
        break;
      }
      case 'screenshot-result': {
        const pending = this.pendingScreenshots.get(message.reqId);
        if (pending?.clientId === client.id && client.subscribedDocs.has(pending.docId)) {
          this.pendingScreenshots.delete(message.reqId);
          clearTimeout(pending.timer);
          if (message.dataUrl) pending.resolve(message.dataUrl);
          else pending.reject(new Error(message.error ?? 'screenshot failed'));
        }
        break;
      }
      case 'ping': {
        this.send(client, { t: 'pong', nonce: message.nonce });
        break;
      }
    }
  }

  /** Broadcast a full document reload (external file change). */
  broadcastDocument(docId: string): void {
    const entry = this.store.get(docId);
    if (!entry) return;
    this.appliedEditorPatches.delete(docId);
    this.broadcast(docId, {
      t: 'doc',
      docId,
      rev: entry.rev,
      document: entry.doc,
      appliedPatchIds: [],
    });
  }

  private broadcast(docId: string, message: ServerMessage, excludeClientId?: string): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.id === excludeClientId) continue;
      if (!client.subscribedDocs.has(docId)) continue;
      this.sendPayload(client, payload);
    }
  }

  private send(client: Client, message: ServerMessage): void {
    this.sendPayload(client, JSON.stringify(message));
  }

  private sendPayload(client: Client, payload: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.socket.close(1009, 'client is not consuming messages');
      return;
    }
    client.socket.send(payload);
  }

  private rejectPatch(
    client: Client,
    docId: string,
    patchId: string,
    rev: number,
    code: PatchRejectCode,
    reason: string,
  ): void {
    this.send(client, { t: 'reject', docId, patchId, rev, code, reason });
  }

  private rememberAppliedPatch(docId: string, patchId: string, applied: AppliedEditorPatch): void {
    let recent = this.appliedEditorPatches.get(docId);
    if (!recent) {
      recent = new Map();
      this.appliedEditorPatches.set(docId, recent);
    }
    recent.set(patchId, applied);
    if (recent.size > MAX_RECENT_PATCH_IDS) {
      recent.delete(recent.keys().next().value as string);
    }
  }

  private protocolViolation(client: Client, message: string): void {
    client.protocolViolations += 1;
    this.send(client, { t: 'error', message });
    if (client.protocolViolations >= MAX_PROTOCOL_VIOLATIONS) {
      client.socket.close(1008, 'too many protocol violations');
    }
  }

  private removeClient(client: Client): void {
    this.clients.delete(client.id);
    if (this.clients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const [reqId, pending] of this.pendingScreenshots) {
      if (pending.clientId !== client.id) continue;
      this.pendingScreenshots.delete(reqId);
      clearTimeout(pending.timer);
      pending.reject(new Error('editor disconnected before producing screenshot'));
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          client.socket.terminate();
          continue;
        }
        client.isAlive = false;
        if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }
}

function sameOriginUpgrade(req: http.IncomingMessage): boolean {
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
