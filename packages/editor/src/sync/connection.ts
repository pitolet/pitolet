import {
  MAX_SERVER_MESSAGE_BYTES,
  zServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@pitolet/schema';
import { nanoid } from 'nanoid';
import {
  markPendingPatchUncertain,
  pendingOutgoingPatches,
  setPatchSender,
  useEditor,
  type OutgoingPatch,
} from '../store/index.js';
import { apiUrl, isShareSession, wsUrl } from './serverBase.js';

const ACK_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

interface InFlightPatch {
  patch: OutgoingPatch;
  baseRev: number;
}

/**
 * WebSocket client for one authoritative document stream.
 *
 * Only one local patch is in flight. Remaining optimistic patches stay in an
 * ordered outbox and are sent after the prior acknowledgement advances the
 * confirmed revision. Reconnects request a full document, reconcile it with
 * the store's pending ledger, then replay the same patch ids.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private docId: string | null = null;
  private loadedDocId: string | null = null;
  private pendingDocumentId: string | null = null;
  private rev = 0;
  private reconnectDelay = 500;
  private closed = false;
  private starting = false;
  private booted = false;
  private synced = false;
  private outbox: OutgoingPatch[] = [];
  private inFlight: InFlightPatch | null = null;
  /** Patch sent without a definitive ack/reject before a reload or reconnect. */
  private uncertainPatchId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong: string | null = null;
  private selectionUnsubscribe: (() => void) | null = null;
  private beforeUnloadInstalled = false;

  async start(): Promise<void> {
    // start() is called by the boot effect and again after login. React
    // StrictMode may also run a stop/start pair in development.
    if (this.starting || this.booted) return;
    this.starting = true;
    this.closed = false;
    useEditor.getState().setConnectionError(null);
    try {
      await this.boot();
    } catch (error) {
      console.error('[pitolet] workspace boot failed', error);
      useEditor
        .getState()
        .setConnectionError('Pitolet could not load this workspace. Check the server and reload.');
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async boot(): Promise<void> {
    if (isShareSession) useEditor.getState().setReadOnly(true);
    let documents: Array<{ id: string; name: string }> = [];
    let receivedDocumentList = false;
    for (let attempt = 0; attempt < 10 && !this.closed; attempt++) {
      try {
        const res = await fetch(apiUrl('/api/documents'));
        if (res.status === 401) {
          useEditor.getState().setConnectionError(null);
          useEditor.getState().setAuthRequired(true);
          return;
        }
        if (res.ok) {
          useEditor
            .getState()
            .setReadOnly(isShareSession || res.headers.get('x-pitolet-read-only') === 'true');
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
        // Transient boot failure; retry with a short capped delay.
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200 * (attempt + 1), 1000)));
    }
    if (this.closed) return;

    useEditor.getState().setAuthRequired(false);
    const first = initialDocument(documents, window.location.search);
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
    this.loadedDocId =
      useEditor.getState().doc?.id === first.id ? useEditor.getState().doc!.id : null;
    this.booted = true;
    this.installSessionListeners();
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.booted = false;
    this.synced = false;
    if (this.inFlight) markPendingPatchUncertain(this.inFlight.patch.patchId);
    this.inFlight = null;
    this.uncertainPatchId = null;
    this.outbox = [];
    this.pendingDocumentId = null;
    setPatchSender(null);
    this.clearReconnectTimer();
    this.clearTransportTimers();
    this.selectionUnsubscribe?.();
    this.selectionUnsubscribe = null;
    if (this.beforeUnloadInstalled) {
      window.removeEventListener('beforeunload', this.onBeforeUnload);
      this.beforeUnloadInstalled = false;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    useEditor.getState().setConnected(false);
    useEditor.getState().setSwitchingDocument(false);
  }

  /**
   * Switch documents only after every local patch has a definitive server
   * outcome. While waiting, local mutations are gated so the queue can drain.
   */
  openDocument(docId: string): void {
    if (!docId) return;
    if (docId === this.loadedDocId && this.pendingDocumentId) {
      this.pendingDocumentId = null;
      useEditor.getState().setSwitchingDocument(false);
      return;
    }
    if (docId === this.docId && docId === this.loadedDocId) return;
    if (
      useEditor.getState().pendingPatchIds.length > 0 ||
      this.inFlight !== null ||
      this.outbox.length > 0
    ) {
      this.pendingDocumentId = docId;
      useEditor.getState().setSwitchingDocument(true);
      return;
    }
    this.beginDocumentSwitch(docId);
  }

  get currentDocId(): string | null {
    return this.docId;
  }

  private beginDocumentSwitch(docId: string): void {
    this.pendingDocumentId = null;
    this.docId = docId;
    this.synced = false;
    useEditor.getState().setSwitchingDocument(true);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ t: 'open', docId });
    }
  }

  private connect(): void {
    if (this.closed) return;
    const existing = this.ws;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.closed) return;
      this.reconnectDelay = 500;
      this.synced = false;
      this.inFlight = null;
      this.outbox = [];
      setPatchSender((patch) => this.enqueuePatch(patch));
      useEditor.getState().setConnected(false);
      this.startHeartbeat();
      if (this.docId) this.send({ t: 'open', docId: this.docId });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.closed) return;
      if (
        typeof event.data !== 'string' ||
        new TextEncoder().encode(event.data).byteLength > MAX_SERVER_MESSAGE_BYTES
      ) {
        this.forceReconnect('Pitolet received an invalid server response. Reconnecting…');
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        this.forceReconnect('Pitolet received an invalid server response. Reconnecting…');
        return;
      }
      const parsed = zServerMessage.safeParse(raw);
      if (!parsed.success) {
        console.error('[pitolet] rejected invalid server message', parsed.error.issues);
        this.forceReconnect('Pitolet received an invalid server response. Reconnecting…');
        return;
      }
      this.handle(parsed.data);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.synced = false;
      if (this.inFlight) {
        this.uncertainPatchId = this.inFlight.patch.patchId;
        markPendingPatchUncertain(this.inFlight.patch.patchId);
      }
      this.inFlight = null;
      this.outbox = [];
      this.clearTransportTimers();
      useEditor.getState().setConnected(false);
      setPatchSender(null);
      if (!this.closed) this.scheduleReconnect();
    };
  }

  private handle(message: ServerMessage): void {
    const store = useEditor.getState();
    // Ack/reject now carry docId as well, so a late response from a document
    // we switched away from can never alter the new session.
    if ('docId' in message && message.docId !== this.docId) return;

    switch (message.t) {
      case 'doc': {
        this.clearAckTimer();
        if (this.inFlight) {
          this.uncertainPatchId = this.inFlight.patch.patchId;
          markPendingPatchUncertain(this.inFlight.patch.patchId);
        }
        this.inFlight = null;
        this.outbox = [];
        this.rev = message.rev;
        const sameDocument = this.loadedDocId === message.docId;
        const reconciled = sameDocument
          ? store.reconcileDocument(
              message.document,
              message.rev,
              message.appliedPatchIds,
              this.uncertainPatchId,
            )
          : (store.setDocument(message.document, message.rev), true);
        if (!reconciled) {
          this.synced = false;
          store.setConnected(false);
          return;
        }
        this.loadedDocId = message.docId;
        this.uncertainPatchId = null;
        this.synced = true;
        store.setConnected(true);
        replaceDocumentUrl(message.docId);

        if (this.maybeBeginPendingSwitch()) return;
        store.setSwitchingDocument(this.pendingDocumentId !== null);
        this.outbox = pendingOutgoingPatches();
        this.flushNextPatch();
        break;
      }
      case 'ack': {
        if (!this.inFlight || this.inFlight.patch.patchId !== message.patchId) return;
        this.clearAckTimer();
        const handled = store.handleAck(message.patchId, message.rev);
        this.inFlight = null;
        this.rev = message.rev;
        if (!handled) {
          this.uncertainPatchId = message.patchId;
          markPendingPatchUncertain(message.patchId);
          this.requestFullDocument('Pitolet is checking the latest saved version…');
          return;
        }
        this.uncertainPatchId = null;
        if (this.maybeBeginPendingSwitch()) return;
        this.flushNextPatch();
        break;
      }
      case 'reject': {
        if (!this.inFlight || this.inFlight.patch.patchId !== message.patchId) return;
        this.clearAckTimer();
        this.inFlight = null;
        this.uncertainPatchId = null;
        this.rev = message.rev;
        if (message.code === 'revision_conflict' || message.code === 'document_not_open') {
          this.requestFullDocument('Another change landed first. Pitolet is syncing and retrying…');
          return;
        }
        const handled = store.handleReject(message.patchId, message.reason);
        if (message.code === 'forbidden') store.setReadOnly(true);
        if (!handled) {
          this.requestFullDocument('Pitolet is checking the latest saved version…');
          return;
        }
        if (this.maybeBeginPendingSwitch()) return;
        this.flushNextPatch();
        break;
      }
      case 'patch': {
        if (!this.synced) return;
        const applied = store.applyRemotePatch(
          message.ops,
          message.rev,
          message.label,
          message.origin,
          message.actor,
        );
        if (!applied) {
          this.requestFullDocument('A change was missed. Pitolet is loading the latest version…');
          return;
        }
        this.rev = Math.max(this.rev, message.rev);
        break;
      }
      case 'selection':
        if (this.synced) store.select(message.nodeIds);
        break;
      case 'request-screenshot':
        void import('./screenshotResponder.js')
          .then((module) =>
            module.respondToScreenshotRequest(message, (reply) => {
              this.send(reply);
            }),
          )
          .catch((error: unknown) => {
            console.error('[pitolet] screenshot module failed to load', error);
            this.send({
              t: 'screenshot-result',
              reqId: message.reqId,
              error: 'The editor could not load its screenshot renderer.',
            });
            store.setSyncIssue('The screenshot could not be captured. Try again.');
          });
        break;
      case 'pong':
        if (message.nonce === this.awaitingPong) {
          this.awaitingPong = null;
          if (this.pongTimer) clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        break;
      case 'error':
        console.error('[pitolet] server error:', message.message);
        store.setSyncIssue(message.message);
        break;
    }
  }

  private enqueuePatch(patch: OutgoingPatch): void {
    if (
      this.inFlight?.patch.patchId === patch.patchId ||
      this.outbox.some((queued) => queued.patchId === patch.patchId)
    ) {
      return;
    }
    this.outbox.push(patch);
    this.flushNextPatch();
  }

  private flushNextPatch(): void {
    if (
      this.inFlight ||
      !this.synced ||
      this.docId === null ||
      this.loadedDocId !== this.docId ||
      this.ws?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const patch = this.outbox.shift();
    if (!patch) return;
    const baseRev = this.rev;
    this.inFlight = { patch, baseRev };
    const sent = this.send({
      t: 'patch',
      docId: this.docId,
      patchId: patch.patchId,
      baseRev,
      label: patch.label,
      ops: patch.ops,
    });
    if (!sent) {
      this.inFlight = null;
      this.outbox.unshift(patch);
      return;
    }
    this.ackTimer = setTimeout(() => {
      if (this.inFlight?.patch.patchId !== patch.patchId) return;
      this.forceReconnect('Pitolet could not confirm the last save. Reconnecting safely…');
    }, ACK_TIMEOUT_MS);
  }

  private requestFullDocument(message: string): void {
    this.clearAckTimer();
    if (this.inFlight) {
      this.uncertainPatchId = this.inFlight.patch.patchId;
      markPendingPatchUncertain(this.inFlight.patch.patchId);
    }
    this.inFlight = null;
    this.outbox = [];
    this.synced = false;
    const store = useEditor.getState();
    store.setConnected(false);
    store.setSyncIssue(message);
    if (this.docId && !this.send({ t: 'open', docId: this.docId })) {
      this.forceReconnect(message);
    }
  }

  private maybeBeginPendingSwitch(): boolean {
    if (!this.pendingDocumentId || useEditor.getState().pendingPatchIds.length > 0) {
      return false;
    }
    const next = this.pendingDocumentId;
    this.beginDocumentSwitch(next);
    return true;
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingPong !== null) {
        this.forceReconnect('Pitolet lost contact with the server. Reconnecting…');
        return;
      }
      const nonce = nanoid(8);
      this.awaitingPong = nonce;
      if (!this.send({ t: 'ping', nonce })) {
        this.forceReconnect('Pitolet lost contact with the server. Reconnecting…');
        return;
      }
      this.pongTimer = setTimeout(() => {
        if (this.awaitingPong === nonce) {
          this.forceReconnect('Pitolet lost contact with the server. Reconnecting…');
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private forceReconnect(message: string): void {
    useEditor.getState().setSyncIssue(message);
    const ws = this.ws;
    if (ws && ws.readyState < WebSocket.CLOSING) {
      ws.close();
    } else if (!this.closed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectAfterAuthCheck().catch((error: unknown) => {
        console.error('[pitolet] reconnect failed', error);
        if (this.closed) return;
        useEditor.getState().setSyncIssue('Pitolet could not reconnect. Trying again…');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async reconnectAfterAuthCheck(): Promise<void> {
    if (this.closed) return;
    try {
      const response = await fetch(apiUrl('/api/documents'));
      if (response.status === 401) {
        this.booted = false;
        useEditor.getState().setAuthRequired(true);
        return;
      }
      if (response.ok) {
        useEditor
          .getState()
          .setReadOnly(isShareSession || response.headers.get('x-pitolet-read-only') === 'true');
      }
    } catch {
      // A network failure here is exactly what the WebSocket backoff handles.
    }
    this.connect();
  }

  private installSessionListeners(): void {
    if (!this.selectionUnsubscribe) {
      let lastSelection = useEditor.getState().selection;
      this.selectionUnsubscribe = useEditor.subscribe((state) => {
        if (state.selection === lastSelection) return;
        lastSelection = state.selection;
        if (this.synced && this.loadedDocId) {
          this.send({
            t: 'select',
            docId: this.loadedDocId,
            nodeIds: state.selection,
          });
        }
      });
    }
    if (!this.beforeUnloadInstalled) {
      window.addEventListener('beforeunload', this.onBeforeUnload);
      this.beforeUnloadInstalled = true;
    }
  }

  private onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (useEditor.getState().pendingPatchIds.length === 0) return;
    event.preventDefault();
    event.returnValue = '';
  };

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.awaitingPong = null;
  }

  private clearTransportTimers(): void {
    this.clearAckTimer();
    this.clearHeartbeat();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }
}

export const connection = new Connection();

/** Resolve a deep-linked document while preserving the first-document fallback. */
export function initialDocument<T extends { id: string }>(
  documents: T[],
  search: string,
): T | undefined {
  const requestedDocumentId = new URLSearchParams(search).get('document');
  return documents.find((document) => document.id === requestedDocumentId) ?? documents[0];
}

/** Keep refresh/back-link behaviour aligned with the document visible in the editor. */
export function replaceDocumentUrl(docId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('document', docId);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
