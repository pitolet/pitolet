import {
  createElement,
  createSampleDocument,
  type PitoletDocument,
  type PatchOp,
  type ServerMessage,
} from '@pitolet/schema';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, DocumentStore, PatchRejectedError, type PitoletApp } from '../src/index.js';

describe('DocumentStore', () => {
  it('applies valid patches, bumps rev, notifies', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const seen: string[] = [];
    store.subscribe((p) => seen.push(`${p.origin}@${p.rev}`));

    const rev = store.applyPatch(
      doc.id,
      [{ op: 'replace', path: ['name'], value: 'Renamed' }],
      'mcp',
      'Rename',
    );
    expect(rev).toBe(1);
    expect(store.get(doc.id)!.doc.name).toBe('Renamed');
    expect(seen).toEqual(['mcp@1']);
  });

  it('rejects patches producing invalid nodes, leaving the doc untouched', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const frameId = doc.rootOrder[0]!;
    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['nodes', frameId, 'styles', 'base', 'opacity'], value: 7 }],
        'mcp',
        'Bad opacity',
      ),
    ).toThrow(PatchRejectedError);
    expect(store.get(doc.id)!.doc).toEqual(doc);
    expect(store.get(doc.id)!.rev).toBe(0);
  });

  it('rejects structural breakage (dangling child)', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const frameId = doc.rootOrder[0]!;
    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'add', path: ['nodes', frameId, 'children', 0], value: 'no-such-node' }],
        'mcp',
        'Dangling child',
      ),
    ).toThrow(PatchRejectedError);
  });

  it('rejects patches touching forbidden paths', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['schemaVersion'], value: 99 }],
        'mcp',
        'Nope',
      ),
    ).toThrow(PatchRejectedError);
  });

  it('fully validates root collection replacements', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const invalidNodes = structuredClone(doc.nodes);
    const frame = invalidNodes[doc.rootOrder[0]!]!;
    if (frame.type !== 'frame') throw new Error('expected frame');
    frame.canvas.width = -12;

    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['nodes'], value: invalidNodes }],
        'mcp',
        'Invalid root replacement',
      ),
    ).toThrow(PatchRejectedError);
    expect(store.get(doc.id)!.rev).toBe(0);
    expect(store.get(doc.id)!.doc.nodes[frame.id]).not.toEqual(frame);
  });

  it('rejects unreachable cyclic islands added through a root map patch', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const a = createElement({ name: 'Cycle A' });
    const b = createElement({ name: 'Cycle B' });
    a.parent = b.id;
    a.children = [b.id];
    b.parent = a.id;
    b.children = [a.id];

    expect(() =>
      store.applyPatch(
        doc.id,
        [
          {
            op: 'replace',
            path: ['nodes'],
            value: { ...doc.nodes, [a.id]: a, [b.id]: b },
          },
        ],
        'mcp',
        'Cyclic island',
      ),
    ).toThrow(PatchRejectedError);
    expect(store.get(doc.id)!.rev).toBe(0);
  });

  it('rejects stale expected revisions with the current revision', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    store.applyPatch(
      doc.id,
      [{ op: 'replace', path: ['name'], value: 'First' }],
      'editor:test',
      'First',
      undefined,
      0,
    );

    let rejected: PatchRejectedError | undefined;
    try {
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['name'], value: 'Stale' }],
        'editor:test',
        'Stale',
        undefined,
        0,
      );
    } catch (error) {
      rejected = error as PatchRejectedError;
    }
    expect(rejected).toBeInstanceOf(PatchRejectedError);
    expect(rejected?.code).toBe('revision_conflict');
    expect(rejected?.rev).toBe(1);
    expect(store.get(doc.id)!.doc.name).toBe('First');
  });
});

describe('WS sync end-to-end', () => {
  let app: PitoletApp;
  let dataDir: string;
  let port: number;
  let docId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-test-'));
    app = await createApp({ port: 0, dataDir });
    await new Promise<void>((resolve) => app.server.listen(0, resolve));
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    docId = app.store.list()[0]!.id;
  });

  afterAll(async () => {
    await app.adapter.close();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  function connect(): Promise<TestClient> {
    return TestClient.connect(port, docId);
  }

  it('two clients converge; author gets ack, peer gets patch', async () => {
    const a = await connect();
    const b = await connect();

    const ops: PatchOp[] = [{ op: 'replace', path: ['name'], value: 'From A' }];
    a.send({ t: 'patch', docId, patchId: 'p1', baseRev: a.rev, label: 'Rename', ops });

    const ack = await a.next('ack');
    expect(ack.t === 'ack' && ack.patchId).toBe('p1');
    expect(ack.t === 'ack' && ack.docId).toBe(docId);

    const patch = await b.next('patch');
    expect(patch.t === 'patch' && patch.label).toBe('Rename');
    expect(patch.t === 'patch' && patch.origin.startsWith('editor:')).toBe(true);

    expect(app.store.get(docId)!.doc.name).toBe('From A');
    a.close();
    b.close();
  });

  it('deduplicates a replayed patch id after a lost acknowledgement', async () => {
    const a = await connect();
    const baseRev = a.rev;
    const message = {
      t: 'patch',
      docId,
      patchId: 'dedup-1',
      baseRev,
      label: 'Deduplicated rename',
      ops: [{ op: 'replace', path: ['name'], value: 'Once only' }] as PatchOp[],
    } as const;
    a.send(message);
    const firstAck = await a.next('ack');
    expect(firstAck.t).toBe('ack');
    const committedRev = firstAck.t === 'ack' ? firstAck.rev : -1;

    a.send(message);
    const duplicateAck = await a.next('ack');
    expect(duplicateAck).toMatchObject({
      t: 'ack',
      docId,
      patchId: 'dedup-1',
      rev: committedRev,
      duplicate: true,
    });
    expect(app.store.get(docId)!.rev).toBe(committedRev);

    a.send({ t: 'open', docId });
    const resync = await a.next('doc');
    expect(resync.t === 'doc' && resync.appliedPatchIds).toContain('dedup-1');
    a.close();
  });

  it('rejects a stale patch with a machine-readable revision conflict', async () => {
    const a = await connect();
    const staleRev = a.rev;
    app.store.applyPatch(
      docId,
      [{ op: 'replace', path: ['name'], value: 'Concurrent write' }],
      'mcp',
      'Concurrent write',
    );
    await a.next('patch');

    a.send({
      t: 'patch',
      docId,
      patchId: 'stale-1',
      baseRev: staleRev,
      label: 'Stale rename',
      ops: [{ op: 'replace', path: ['name'], value: 'Must not apply' }],
    });
    const reject = await a.next('reject');
    expect(reject).toMatchObject({
      t: 'reject',
      docId,
      patchId: 'stale-1',
      rev: app.store.get(docId)!.rev,
      code: 'revision_conflict',
    });
    expect(app.store.get(docId)!.doc.name).toBe('Concurrent write');
    a.close();
  });

  it('validates messages, echoes heartbeats, and replaces the active document subscription', async () => {
    const a = await connect();
    a.send({ t: 'not-a-message' });
    expect(await a.next('error')).toMatchObject({ t: 'error', message: 'invalid message' });

    a.send({ t: 'ping', nonce: 'heartbeat-1' });
    expect(await a.next('pong')).toMatchObject({ t: 'pong', nonce: 'heartbeat-1' });

    const second = createSampleDocument();
    second.name = 'Second';
    app.store.load(second);
    a.send({ t: 'open', docId: second.id });
    expect(await a.next('doc')).toMatchObject({ t: 'doc', docId: second.id });
    const selectedId = second.rootOrder[0]!;
    a.send({ t: 'select', docId: second.id, nodeIds: [selectedId] });
    await expect.poll(() => app.hub.getSelection(second.id)).toEqual([selectedId]);
    expect(app.hub.getSelection(docId)).toEqual([]);

    app.store.applyPatch(
      docId,
      [{ op: 'replace', path: ['name'], value: 'Old document changed' }],
      'mcp',
      'Old document changed',
    );
    await expect(a.next('patch', 150)).rejects.toThrow(/timed out/);
    a.close();
  });

  it('invalid patch gets rejected without partial application', async () => {
    const a = await connect();
    const before = app.store.get(docId)!.rev;
    a.send({
      t: 'patch',
      docId,
      patchId: 'p2',
      baseRev: a.rev,
      label: 'Bad',
      ops: [
        { op: 'replace', path: ['name'], value: 'Should not stick' },
        { op: 'replace', path: ['schemaVersion'], value: 9 },
      ],
    });
    const reject = await a.next('reject');
    expect(reject.t).toBe('reject');
    expect(app.store.get(docId)!.rev).toBe(before);
    expect(app.store.get(docId)!.doc.name).not.toBe('Should not stick');
    a.close();
  });

  it('mcp-origin store writes broadcast to connected editors', async () => {
    const a = await connect();
    app.store.applyPatch(
      docId,
      [{ op: 'replace', path: ['name'], value: 'From MCP' }],
      'mcp',
      'MCP: rename',
    );
    const patch = await a.next('patch');
    expect(patch.t === 'patch' && patch.origin).toBe('mcp');
    expect(patch.t === 'patch' && patch.label).toBe('MCP: rename');
    a.close();
  });

  it('survives a client aborting mid-upload (no unhandled rejection crash)', async () => {
    // Start a chunked asset upload, then destroy the socket mid-body. The
    // rejected body iteration must be caught — the process must keep serving.
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        { port, path: '/api/assets', method: 'POST', headers: { 'content-type': 'image/png' } },
        () => resolve(),
      );
      req.on('error', () => resolve()); // socket destroy surfaces here
      req.write(Buffer.alloc(1024, 1));
      setTimeout(() => req.destroy(), 20);
    });
    // Give the (now-caught) rejection a tick to fire if it were unhandled.
    await new Promise((r) => setTimeout(r, 50));
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
  });

  it('persists applied patches to disk (restart restores)', async () => {
    app.store.applyPatch(
      docId,
      [{ op: 'replace', path: ['name'], value: 'Persisted' }],
      'mcp',
      'MCP: rename',
    );
    // Force the debounced save.
    await app.adapter.flush();

    const app2 = await createApp({ port: 0, dataDir });
    const restored = app2.store.get(docId);
    expect(restored?.doc.name).toBe('Persisted');
    await app2.adapter.close();
  });
});

describe('WS actor attribution', () => {
  let app: PitoletApp;
  let dataDir: string;
  let port: number;
  let docId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-actor-test-'));
    // Every socket resolves to the same user identity — enough to prove the
    // server stamps actor onto broadcast patches.
    app = await createApp({
      port: 0,
      dataDir,
      auth: {
        authenticate: async () => ({ kind: 'user', userId: 'u1', displayName: 'Alice' }),
      },
    });
    await new Promise<void>((resolve) => app.server.listen(0, resolve));
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    docId = app.store.list()[0]!.id;
  });

  afterAll(async () => {
    await app.adapter.close();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stamps the authenticated user as actor on broadcast patches', async () => {
    const a = await TestClient.connect(port, docId);
    const b = await TestClient.connect(port, docId);

    const ops: PatchOp[] = [{ op: 'replace', path: ['name'], value: 'From Alice' }];
    a.send({ t: 'patch', docId, patchId: 'pa', baseRev: a.rev, label: 'Rename', ops });

    await a.next('ack');
    const patch = await b.next('patch');
    expect(patch.t === 'patch' && patch.actor).toEqual({ id: 'u1', name: 'Alice' });

    a.close();
    b.close();
  });
});

class TestClient {
  rev = 0;
  document: PitoletDocument | null = null;
  private queue: ServerMessage[] = [];
  private waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];

  private constructor(private socket: WebSocket) {}

  static async connect(port: number, docId: string): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = new TestClient(socket);
    socket.on('message', (data) => client.receive(JSON.parse(String(data)) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    client.send({ t: 'open', docId });
    const doc = await client.next('doc');
    if (doc.t === 'doc') {
      client.rev = doc.rev;
      client.document = doc.document;
    }
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next(type: ServerMessage['t'], timeoutMs = 3000): Promise<ServerMessage> {
    const queued = this.queue.findIndex((m) => m.t === type);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${type}`));
        }
      }, timeoutMs);
    });
  }

  close(): void {
    this.socket.close();
  }

  private receive(message: ServerMessage): void {
    if (message.t === 'ack' || message.t === 'patch') this.rev = message.rev;
    const i = this.waiters.findIndex((w) => w.type === message.t);
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(message);
    else this.queue.push(message);
  }
}
