import { attach, createDocument, createElement, createFrame, createImage } from '@pitolet/schema';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, sharedPasswordAuth, type PitoletApp } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function app(password?: string): Promise<{ app: PitoletApp; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'pitolet-import-api-'));
  const instance = await createApp({
    port: 0,
    dataDir,
    auth: password ? sharedPasswordAuth(password) : undefined,
  });
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  cleanups.push(async () => {
    await instance.adapter.close();
    instance.server.closeAllConnections();
    await new Promise((resolve) => instance.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app: instance, base: `http://127.0.0.1:${port}` };
}

function importedDocument(id = 'imp_api_test') {
  const doc = createDocument({ id, name: 'Imported site' });
  attach(doc, null, createFrame({ name: 'Imported page', width: 1440, height: 'auto' }));
  return doc;
}

async function post(base: string, body: unknown, token?: string) {
  return fetch(`${base}/api/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/import', () => {
  it('validates, persists, and loads a complete document atomically', async () => {
    const { app: instance, base } = await app();
    const document = importedDocument();
    const response = await post(base, document);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ docId: document.id, duplicate: false });
    expect(instance.store.get(document.id)?.doc.name).toBe('Imported site');
  });

  it('treats an exact retry as success but never overwrites a collision', async () => {
    const { app: instance, base } = await app();
    const document = importedDocument();
    expect((await post(base, document)).status).toBe(201);
    const duplicate = await post(base, document);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });

    const changed = structuredClone(document);
    changed.name = 'Collision';
    expect((await post(base, changed)).status).toBe(409);
    expect(instance.store.get(document.id)?.doc.name).toBe('Imported site');
  });

  it('rejects incoherent, too-deep, and oversized-node documents', async () => {
    const { base } = await app();
    const incoherent = importedDocument('imp_bad');
    incoherent.rootOrder.push('missing');
    expect((await post(base, incoherent)).status).toBe(400);

    const deep = importedDocument('imp_deep');
    let parent = deep.rootOrder[0]!;
    for (let i = 0; i < 101; i++) {
      const child = attach(deep, parent, createElement({ name: `Level ${i}` }));
      parent = child.id;
    }
    expect((await post(base, deep)).status).toBe(400);

    const huge = importedDocument('imp_huge');
    for (let i = 0; i < 10_000; i++) {
      const child = createElement({ name: `Node ${i}` });
      huge.nodes[child.id] = child;
    }
    expect((await post(base, huge)).status).toBe(400);
  });

  it('uses the existing shared-password Bearer authorization', async () => {
    const password = 'import-secret';
    const { base } = await app(password);
    expect((await post(base, importedDocument('imp_no_auth'))).status).toBe(401);
    expect((await post(base, importedDocument('imp_wrong'), 'wrong')).status).toBe(401);
    expect((await post(base, importedDocument('imp_authorized'), password)).status).toBe(201);
  });

  it('does not create a document when a required asset upload is missing', async () => {
    const { app: instance, base } = await app();
    const document = importedDocument('imp_missing_asset');
    document.assets['0000000000000000.png'] = {
      fileName: 'missing.png',
      width: 10,
      height: 10,
      mime: 'image/png',
    };
    attach(
      document,
      document.rootOrder[0]!,
      createImage({ src: { asset: '0000000000000000.png' }, alt: 'Missing' }),
    );
    expect((await post(base, document)).status).toBe(400);
    expect(instance.store.get(document.id)).toBeUndefined();
  });

  it('rejects import bodies larger than 25 MB without crashing the server', async () => {
    const { base } = await app();
    const response = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(25 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  }, 20_000);

  it('survives a client disconnect halfway through an import', async () => {
    const { base } = await app();
    const port = Number(new URL(base).port);
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(
          'POST /api/import HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"partial":',
        );
        socket.destroy();
      });
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
    await expect.poll(async () => (await fetch(`${base}/api/health`)).status).toBe(200);
  });
});
