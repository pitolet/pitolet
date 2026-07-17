import {
  MAX_SERVER_MESSAGE_BYTES,
  MAX_WS_MESSAGE_BYTES,
  createSampleDocument,
  type ClientMessage,
  type ServerMessage,
} from '@pitolet/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { history, setPatchSender, useEditor } from '../src/store/index.js';
import { Connection, initialDocument, replaceDocumentUrl } from '../src/sync/connection.js';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  receiveRaw(message: unknown): void {
    this.onmessage?.({
      data: typeof message === 'string' ? message : JSON.stringify(message),
    } as MessageEvent);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  send(payload: string): void {
    this.sent.push(payload);
  }
}

const connections: Connection[] = [];

describe('document deep links', () => {
  const documents = [
    { id: 'welcome', name: 'Welcome' },
    { id: 'imported', name: 'Imported site' },
  ];

  it('opens the requested imported document', () => {
    expect(initialDocument(documents, '?document=imported')?.id).toBe('imported');
  });

  it('falls back to the first document for missing or unknown ids', () => {
    expect(initialDocument(documents, '')?.id).toBe('welcome');
    expect(initialDocument(documents, '?document=missing')?.id).toBe('welcome');
  });

  it('updates only the document query parameter after a successful open', () => {
    window.history.replaceState({}, '', '/editor?share=abc#canvas');
    replaceDocumentUrl('next');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/editor?share=abc&document=next#canvas',
    );
  });
});

describe('connection synchronization', () => {
  beforeEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          documents: [{ id: 'welcome', name: 'Welcome' }],
        }),
      })),
    );
    window.history.replaceState({}, '', '/');
    history.clear();
    setPatchSender(null);
    const doc = createSampleDocument();
    doc.id = 'welcome';
    useEditor.getState().setDocument(doc, 0);
    useEditor.getState().setConnected(false);
    useEditor.getState().setReadOnly(false);
    useEditor.getState().setAuthRequired(false);
    useEditor.getState().setSyncIssue(null);
  });

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends one patch at a time with the latest confirmed base revision', async () => {
    const { connection, socket, doc } = await connected();
    socket.sent = [];

    useEditor.getState().dispatchEdit('First', (draft) => {
      draft.name = 'First';
    });
    useEditor.getState().dispatchEdit('Second', (draft) => {
      draft.name = 'Second';
    });

    let patches = sentMessages(socket).filter((message) => message.t === 'patch');
    expect(patches).toHaveLength(1);
    const first = patches[0]!;
    expect(first.t === 'patch' && first.baseRev).toBe(0);

    socket.receive({
      t: 'ack',
      docId: doc.id,
      patchId: first.t === 'patch' ? first.patchId : '',
      rev: 1,
    });
    patches = sentMessages(socket).filter((message) => message.t === 'patch');
    expect(patches).toHaveLength(2);
    const second = patches[1]!;
    expect(second.t === 'patch' && second.baseRev).toBe(1);
    expect(connection.currentDocId).toBe(doc.id);
  });

  it('uses the authenticated runtime response to enter view-only mode', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-pitolet-read-only': 'true' }),
      json: async () => ({
        documents: [{ id: 'welcome', name: 'Welcome' }],
      }),
    } as Response);

    await connected();
    expect(useEditor.getState().readOnly).toBe(true);
    expect(useEditor.getState().activeTool).toBe('select');
  });

  it('rejects malformed server messages before they reach editor state', async () => {
    const { socket } = await connected();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    socket.receiveRaw({
      t: 'ack',
      docId: 'welcome',
      patchId: 'patch',
      rev: -1,
    });

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(useEditor.getState().connected).toBe(false);
    expect(useEditor.getState().syncIssue).toBe(
      'Pitolet received an invalid server response. Reconnecting…',
    );
    error.mockRestore();
  });

  it('rejects structurally invalid documents from the server', async () => {
    const { socket, doc } = await connected();
    const invalid = structuredClone(doc);
    const rootId = invalid.rootOrder[0]!;
    invalid.nodes[rootId]!.children.push(rootId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    socket.receiveRaw({
      t: 'doc',
      docId: invalid.id,
      rev: 1,
      document: invalid,
    });

    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(useEditor.getState().connected).toBe(false);
    expect(useEditor.getState().docRev).toBe(0);
    error.mockRestore();
  });

  it('accepts valid document snapshots larger than the client-message ceiling', async () => {
    expect(MAX_SERVER_MESSAGE_BYTES).toBeGreaterThan(MAX_WS_MESSAGE_BYTES);
    const { socket, doc } = await connected();
    const text = Object.values(doc.nodes).find((node) => node.type === 'text');
    if (!text || text.type !== 'text') throw new Error('expected sample text');
    const largeText = 'x'.repeat(MAX_WS_MESSAGE_BYTES + 1_024);
    text.content = [{ text: largeText }];

    socket.receive({ t: 'doc', docId: doc.id, rev: 1, document: doc });

    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(useEditor.getState().docRev).toBe(1);
    const received = useEditor.getState().doc!.nodes[text.id]!;
    expect(received.type === 'text' ? received.content[0]?.text.length : 0).toBe(largeText.length);
  });

  it('rebases and retries the same pending patch after a revision conflict', async () => {
    const { socket, doc } = await connected();
    socket.sent = [];
    const frameId = doc.rootOrder[0]!;
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Local name';
    });
    const firstPatch = sentMessages(socket).find((message) => message.t === 'patch');
    expect(firstPatch?.t).toBe('patch');

    const remoteOp = {
      op: 'replace' as const,
      path: ['nodes', frameId, 'canvas', 'x'],
      value: 900,
    };
    socket.receive({
      t: 'patch',
      docId: doc.id,
      rev: 1,
      origin: 'editor:peer',
      label: 'Peer move',
      ops: [remoteOp],
    });
    socket.receive({
      t: 'reject',
      docId: doc.id,
      patchId: firstPatch!.t === 'patch' ? firstPatch!.patchId : '',
      reason: 'revision conflict',
      rev: 1,
      code: 'revision_conflict',
    });
    expect(sentMessages(socket).at(-1)).toEqual({ t: 'open', docId: doc.id });

    const authoritative = structuredClone(doc);
    const frame = authoritative.nodes[frameId]!;
    if (frame.type === 'frame') frame.canvas.x = 900;
    socket.receive({
      t: 'doc',
      docId: doc.id,
      rev: 1,
      document: authoritative,
      appliedPatchIds: [],
    });

    const retried = sentMessages(socket)
      .filter((message) => message.t === 'patch')
      .at(-1);
    expect(retried).toMatchObject({
      t: 'patch',
      docId: doc.id,
      patchId: firstPatch!.t === 'patch' ? firstPatch!.patchId : '',
      baseRev: 1,
    });
    expect(useEditor.getState().doc?.name).toBe('Local name');
    const visibleFrame = useEditor.getState().doc!.nodes[frameId]!;
    expect(visibleFrame.type === 'frame' && visibleFrame.canvas.x).toBe(900);
  });

  it('does not replay a patch the reconnect snapshot says was already committed', async () => {
    const { socket, doc } = await connected();
    socket.sent = [];
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Already committed';
    });
    const patch = sentMessages(socket).find((message) => message.t === 'patch');
    expect(patch?.t).toBe('patch');

    const authoritative = createSampleDocument();
    authoritative.id = doc.id;
    authoritative.name = 'Already committed';
    socket.receive({
      t: 'doc',
      docId: doc.id,
      rev: 1,
      document: authoritative,
      appliedPatchIds: [patch!.t === 'patch' ? patch!.patchId : ''],
    });

    expect(useEditor.getState().pendingPatchIds).toEqual([]);
    expect(sentMessages(socket).filter((message) => message.t === 'patch')).toHaveLength(1);
  });

  it('recognizes an array add committed before an acknowledgement was lost', async () => {
    const { connection, socket, doc } = await connected();
    socket.sent = [];
    useEditor.getState().dispatchEdit('Add breakpoint', (draft) => {
      draft.breakpoints.push({ id: 'wide', name: 'Wide', minWidth: 2_000 });
    });
    const patch = sentMessages(socket).find((message) => message.t === 'patch');
    expect(patch?.t).toBe('patch');
    const committed = structuredClone(useEditor.getState().doc!);

    // The persisted document contains the change, but a restarted server has
    // lost the transient patch-id cache and the client never saw the ack. A
    // replacement Connection must retain that delivery uncertainty.
    connection.stop();
    const replacement = new Connection();
    connections.push(replacement);
    await replacement.start();
    const replacementSocket = MockWebSocket.instances.at(-1)!;
    replacementSocket.open();
    replacementSocket.receive({ t: 'doc', docId: doc.id, rev: 1, document: committed });

    expect(useEditor.getState().pendingPatchIds).toEqual([]);
    expect(useEditor.getState().doc!.breakpoints.filter(({ id }) => id === 'wide')).toHaveLength(1);
    expect(sentMessages(socket).filter((message) => message.t === 'patch')).toHaveLength(1);
    expect(sentMessages(replacementSocket).filter((message) => message.t === 'patch')).toHaveLength(
      0,
    );
  });

  it('replays an uncertain array add only when its exact preconditions still hold', async () => {
    const { socket, doc } = await connected();
    socket.sent = [];
    const authoritative = structuredClone(doc);
    useEditor.getState().dispatchEdit('Add breakpoint', (draft) => {
      draft.breakpoints.push({ id: 'wide', name: 'Wide', minWidth: 2_000 });
    });
    const firstPatch = sentMessages(socket).find((message) => message.t === 'patch');
    expect(firstPatch?.t).toBe('patch');

    socket.receive({ t: 'doc', docId: doc.id, rev: 0, document: authoritative });

    const patches = sentMessages(socket).filter((message) => message.t === 'patch');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({
      t: 'patch',
      patchId: firstPatch!.t === 'patch' ? firstPatch!.patchId : '',
      baseRev: 0,
    });
    expect(useEditor.getState().doc!.breakpoints.filter(({ id }) => id === 'wide')).toHaveLength(1);
    expect(useEditor.getState().connected).toBe(true);
  });

  it('pauses instead of duplicating an uncertain array edit after a same-path change', async () => {
    const { socket, doc } = await connected();
    socket.sent = [];
    useEditor.getState().dispatchEdit('Add breakpoint', (draft) => {
      draft.breakpoints.push({ id: 'wide', name: 'Wide', minWidth: 2_000 });
    });
    const authoritative = structuredClone(doc);
    authoritative.breakpoints.push({ id: 'peer-wide', name: 'Peer wide', minWidth: 2_100 });

    socket.receive({ t: 'doc', docId: doc.id, rev: 1, document: authoritative });

    expect(useEditor.getState().connected).toBe(false);
    expect(useEditor.getState().pendingPatchIds).toHaveLength(1);
    expect(useEditor.getState().syncIssue).toContain('prevent a duplicate change');
    expect(sentMessages(socket).filter((message) => message.t === 'patch')).toHaveLength(1);
    expect(useEditor.getState().doc!.breakpoints.filter(({ id }) => id === 'wide')).toHaveLength(1);
  });

  it('waits for pending saves before switching and ignores late old-document replies', async () => {
    const { connection, socket, doc } = await connected();
    socket.sent = [];
    useEditor.getState().select([doc.rootOrder[0]!]);
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Saved first';
    });
    const patch = sentMessages(socket).find((message) => message.t === 'patch');
    connection.openDocument('second');
    expect(useEditor.getState().switchingDocument).toBe(true);
    expect(sentMessages(socket)).not.toContainEqual({ t: 'open', docId: 'second' });

    socket.receive({
      t: 'ack',
      docId: doc.id,
      patchId: patch!.t === 'patch' ? patch!.patchId : '',
      rev: 1,
    });
    expect(sentMessages(socket).at(-1)).toEqual({ t: 'open', docId: 'second' });

    const second = createSampleDocument();
    second.id = 'second';
    second.name = 'Second';
    socket.receive({ t: 'doc', docId: 'second', rev: 0, document: second });
    expect(useEditor.getState().doc?.id).toBe('second');
    expect(useEditor.getState().selection).toEqual([]);
    expect(useEditor.getState().switchingDocument).toBe(false);
    expect(window.location.search).toBe('?document=second');

    socket.receive({
      t: 'ack',
      docId: doc.id,
      patchId: patch!.t === 'patch' ? patch!.patchId : '',
      rev: 2,
    });
    expect(useEditor.getState().doc?.id).toBe('second');
    expect(useEditor.getState().docRev).toBe(0);
  });

  it('warns before unloading while a save is pending', async () => {
    const { socket, doc } = await connected();
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Pending';
    });
    const event = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);

    const patch = sentMessages(socket).find((message) => message.t === 'patch');
    socket.receive({
      t: 'ack',
      docId: doc.id,
      patchId: patch!.t === 'patch' ? patch!.patchId : '',
      rev: 1,
    });
    const savedEvent = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(savedEvent)).toBe(true);
  });

  it('reconnects when a patch acknowledgement times out', async () => {
    vi.useFakeTimers();
    const { socket } = await connected();
    useEditor.getState().dispatchEdit('Rename', (draft) => {
      draft.name = 'Pending';
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(useEditor.getState().connected).toBe(false);
    expect(useEditor.getState().pendingPatchIds).toHaveLength(1);
  });

  it('uses an application heartbeat to detect a half-open socket', async () => {
    vi.useFakeTimers();
    const { socket } = await connected();
    await vi.advanceTimersByTimeAsync(20_000);
    const ping = sentMessages(socket).find((message) => message.t === 'ping');
    expect(ping?.t).toBe('ping');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('stops reconnecting and returns to login when the session expires', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    const { socket } = await connected();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);
    socket.close();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(useEditor.getState().authRequired).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

async function connected(): Promise<{
  connection: Connection;
  socket: MockWebSocket;
  doc: ReturnType<typeof createSampleDocument>;
}> {
  const connection = new Connection();
  connections.push(connection);
  await connection.start();
  const socket = MockWebSocket.instances.at(-1)!;
  socket.open();
  const doc = createSampleDocument();
  doc.id = 'welcome';
  socket.receive({ t: 'doc', docId: doc.id, rev: 0, document: doc });
  return { connection, socket, doc };
}

function sentMessages(socket: MockWebSocket): ClientMessage[] {
  return socket.sent.map((payload) => JSON.parse(payload) as ClientMessage);
}
