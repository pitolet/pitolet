import type { ClientMessage, ServerMessage } from '@pitolet/schema';
import { setPatchSender, useEditor, type OutgoingPatch } from '../store/index.js';
import { apiUrl, isShareSession, wsUrl } from './serverBase.js';

/**
 * WebSocket client to the authoritative server. Handles document open,
 * optimistic-patch acking, remote patches (other editors / MCP), selection
 * sharing, and reconnection with resync.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private docId: string | null = null;
  private rev = 0;
  private reconnectDelay = 500;
  private closed = false;
  private starting = false;
  private booted = false;

  async start(): Promise<void> {
    // Re-entrancy guard: start() may be called by the boot effect AND the
    // login-success handler (and twice under React StrictMode). Don't run two
    // boot sequences / open two sockets concurrently, and don't re-subscribe /
    // re-open the socket once a boot has already succeeded.
    if (this.starting || this.booted) return;
    this.starting = true;
    // Reset the closed flag: start() is re-entrant — the login screen calls it
    // again after auth, and React StrictMode can stop()/start() in dev.
    this.closed = false;
    useEditor.getState().setConnectionError(null);
    try {
      await this.boot();
    } finally {
      this.starting = false;
    }
  }

  private async boot(): Promise<void> {
    // Share-link sessions are read-only from the first frame: the server
    // rejects patches anyway (defense in depth), but the editor must not
    // offer editing affordances — TopBar shows the 'View only' pill.
    if (isShareSession) useEditor.getState().setReadOnly(true);
    // Retry the initial fetch: on reload the Vite dev proxy can briefly race
    // the backend and return an empty body.
    let documents: Array<{ id: string; name: string }> = [];
    let receivedDocumentList = false;
    for (let attempt = 0; attempt < 10 && !this.closed; attempt++) {
      try {
        const res = await fetch(apiUrl('/api/documents'));
        // Auth required: surface it and stop — do NOT retry-loop or attempt the
        // WS. The login screen re-invokes start() after a successful login.
        if (res.status === 401) {
          useEditor.getState().setConnectionError(null);
          useEditor.getState().setAuthRequired(true);
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as { documents?: typeof documents };
          if (body.documents) {
            receivedDocumentList = true;
            if (body.documents.length > 0) {
              documents = body.documents;
              break;
            }
          }
        }
      } catch {
        // transient — fall through to backoff
      }
      await new Promise((r) => setTimeout(r, Math.min(200 * (attempt + 1), 1000)));
    }
    if (this.closed) return;
    // We got here with documents → auth is satisfied. Clear any prior flag
    // (e.g. after a successful login retry).
    useEditor.getState().setAuthRequired(false);
    const first = documents[0];
    if (!first) {
      useEditor
        .getState()
        .setConnectionError(
          receivedDocumentList
            ? 'This workspace has no documents. Reload the page; if the problem continues, return to the dashboard and create a document.'
            : 'Pitolet could not reach this workspace. Check your connection and reload the page.',
        );
      return;
    }
    this.docId = first.id;
    this.booted = true;
    this.connect();

    // Share selection changes so MCP get_selection sees them.
    let lastSelection = useEditor.getState().selection;
    useEditor.subscribe((state) => {
      if (state.selection !== lastSelection) {
        lastSelection = state.selection;
        if (this.docId) this.send({ t: 'select', docId: this.docId, nodeIds: state.selection });
      }
    });
  }

  stop(): void {
    this.closed = true;
    this.booted = false;
    setPatchSender(null);
    this.ws?.close();
  }

  /** Switch the open document. The 'doc' reply flows through setDocument. */
  openDocument(docId: string): void {
    if (docId === this.docId) return;
    this.docId = docId;
    this.send({ t: 'open', docId });
  }

  get currentDocId(): string | null {
    return this.docId;
  }

  private connect(): void {
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      useEditor.getState().setConnected(true);
      if (this.docId) this.send({ t: 'open', docId: this.docId });
      setPatchSender((patch: OutgoingPatch) => {
        if (this.docId) {
          this.send({
            t: 'patch',
            docId: this.docId,
            patchId: patch.patchId,
            baseRev: this.rev,
            label: patch.label,
            ops: patch.ops,
          });
        }
      });
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      this.handle(message);
    };

    ws.onclose = () => {
      useEditor.getState().setConnected(false);
      setPatchSender(null);
      if (!this.closed) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
      }
    };
  }

  private handle(message: ServerMessage): void {
    const store = useEditor.getState();
    // Ignore messages for a document we've since switched away from — the
    // server keeps the old subscription alive, so stray patches must not land
    // on the current doc.
    if ('docId' in message && message.docId !== this.docId) return;
    switch (message.t) {
      case 'doc':
        this.rev = message.rev;
        store.setDocument(message.document, message.rev);
        break;
      case 'ack':
        this.rev = message.rev;
        break;
      case 'reject':
        store.handleReject(message.patchId, message.reason);
        break;
      case 'patch':
        this.rev = message.rev;
        store.applyRemotePatch(message.ops, message.rev, message.label, message.origin, message.actor);
        break;
      case 'selection':
        store.select(message.nodeIds);
        break;
      case 'request-screenshot':
        // Answered by screenshotResponder (M4).
        void import('./screenshotResponder.js').then((m) =>
          m.respondToScreenshotRequest(message, (reply) => this.send(reply)),
        );
        break;
      case 'error':
        console.error('[pitolet] server error:', message.message);
        break;
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

export const connection = new Connection();
