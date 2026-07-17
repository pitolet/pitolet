import { createDocument, type PitoletDocument } from '@pitolet/schema';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileStorageAdapter,
  type FileStorageAdapterOptions,
} from '../src/storage/FileStorageAdapter.js';

const PNG_MIME = 'image/png';
const ASSET_METADATA = {
  fileName: 'test.png',
  mime: PNG_MIME,
  width: 10,
  height: 10,
} as const;

describe('FileStorageAdapter asset garbage collection', () => {
  const adapters: FileStorageAdapter[] = [];
  const dataDirs: string[] = [];

  afterEach(async () => {
    for (const adapter of adapters.reverse()) await adapter.close();
    for (const dataDir of dataDirs) rmSync(dataDir, { recursive: true, force: true });
    adapters.length = 0;
    dataDirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeDataDir(): string {
    const dataDir = mkdtempSync(join(tmpdir(), 'pitolet-asset-gc-'));
    dataDirs.push(dataDir);
    return dataDir;
  }

  function makeAdapter(
    dataDir: string,
    options: FileStorageAdapterOptions = {},
  ): FileStorageAdapter {
    const adapter = new FileStorageAdapter(dataDir, {
      assetGcIntervalMs: 0,
      ...options,
    });
    adapters.push(adapter);
    return adapter;
  }

  function assetPath(dataDir: string, assetId: string): string {
    return join(dataDir, 'assets', assetId);
  }

  function makeOld(path: string): void {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    utimesSync(path, old, old);
  }

  function referenceAsset(doc: PitoletDocument, assetId: string): void {
    doc.assets[assetId] = { ...ASSET_METADATA };
  }

  it('removes an old unreferenced asset during the post-load scan', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 60_000 });
    const { assetId } = await adapter.assets.put(Buffer.from('old orphan'), PNG_MIME);
    makeOld(assetPath(dataDir, assetId));

    await adapter.loadAll();

    expect(existsSync(assetPath(dataDir, assetId))).toBe(false);
  });

  it('keeps a fresh unreferenced upload for the import grace period', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 60 * 60 * 1_000 });
    const { assetId } = await adapter.assets.put(Buffer.from('fresh upload'), PNG_MIME);

    await adapter.loadAll();

    expect(existsSync(assetPath(dataDir, assetId))).toBe(true);
  });

  it('preserves references from every valid disk document, including a skipped duplicate id', async () => {
    const dataDir = makeDataDir();
    const writer = makeAdapter(dataDir);
    const firstAsset = await writer.assets.put(Buffer.from('first reference'), PNG_MIME);
    const secondAsset = await writer.assets.put(Buffer.from('second reference'), PNG_MIME);
    const first = createDocument({ id: 'duplicate-id', name: 'First' });
    referenceAsset(first, firstAsset.assetId);
    await writer.saveNow(first, 0);

    const duplicate = createDocument({ id: first.id, name: 'Duplicate' });
    referenceAsset(duplicate, secondAsset.assetId);
    writeFileSync(join(dataDir, 'duplicate.pitolet.json'), JSON.stringify(duplicate));
    makeOld(assetPath(dataDir, firstAsset.assetId));
    makeOld(assetPath(dataDir, secondAsset.assetId));

    const reader = makeAdapter(dataDir, { assetGcGraceMs: 0 });
    const loaded = await reader.loadAll();

    expect(loaded).toHaveLength(1);
    expect(existsSync(assetPath(dataDir, firstAsset.assetId))).toBe(true);
    expect(existsSync(assetPath(dataDir, secondAsset.assetId))).toBe(true);
  });

  it('fails closed when any document file is unreadable or invalid', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 0 });
    const { assetId } = await adapter.assets.put(Buffer.from('must survive'), PNG_MIME);
    makeOld(assetPath(dataDir, assetId));
    writeFileSync(join(dataDir, 'broken.pitolet.json'), '{ definitely not json');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await adapter.loadAll();

    expect(existsSync(assetPath(dataDir, assetId))).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('asset cleanup skipped because document broken.pitolet.json'),
      expect.anything(),
    );
  });

  it('keeps a reference added to a pending live document while a scan is in flight', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 0 });
    await adapter.loadAll();
    const { assetId } = await adapter.assets.put(Buffer.from('pending reference'), PNG_MIME);
    makeOld(assetPath(dataDir, assetId));

    const originalList = adapter.assets.list!.bind(adapter.assets);
    let releaseList!: () => void;
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    adapter.assets.list = async () => {
      const result = await originalList();
      markListStarted();
      await listGate;
      return result;
    };

    const collection = adapter.collectOrphanAssets();
    await listStarted;
    const pending = createDocument({ name: 'Pending import' });
    referenceAsset(pending, assetId);
    adapter.handlePatch(
      {
        docId: pending.id,
        rev: 1,
        ops: [],
        origin: 'test',
        label: 'pending import',
      },
      pending,
    );
    releaseList();
    await collection;

    expect(existsSync(assetPath(dataDir, assetId))).toBe(true);
  });

  it('preserves a loaded live document even if its backing file disappears', async () => {
    const dataDir = makeDataDir();
    const writer = makeAdapter(dataDir);
    const { assetId } = await writer.assets.put(Buffer.from('live reference'), PNG_MIME);
    const doc = createDocument({ name: 'Live document' });
    referenceAsset(doc, assetId);
    await writer.saveNow(doc, 0);
    makeOld(assetPath(dataDir, assetId));

    const reader = makeAdapter(dataDir, { assetGcGraceMs: 0 });
    await reader.loadAll();
    const documentFile = readdirSync(dataDir).find((file) => file.endsWith('.pitolet.json'));
    expect(documentFile).toBeTruthy();
    unlinkSync(join(dataDir, documentFile!));

    await reader.collectOrphanAssets();

    expect(existsSync(assetPath(dataDir, assetId))).toBe(true);
  });

  it('renews the grace period when old content is uploaded again before import', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 60 * 60 * 1_000 });
    await adapter.loadAll();
    const bytes = Buffer.from('same upload');
    const { assetId } = await adapter.assets.put(bytes, PNG_MIME);
    const path = assetPath(dataDir, assetId);
    makeOld(path);
    const oldMtime = (await adapter.assets.list!()).find(
      (asset) => asset.assetId === assetId,
    )!.modifiedAt;

    expect((await adapter.assets.put(bytes, PNG_MIME)).assetId).toBe(assetId);
    await adapter.collectOrphanAssets();
    const refreshedMtime = (await adapter.assets.list!()).find(
      (asset) => asset.assetId === assetId,
    )!.modifiedAt;

    expect(refreshedMtime).toBeGreaterThan(oldMtime);
    expect(existsSync(assetPath(dataDir, assetId))).toBe(true);
  });

  it('runs periodically after load', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 0, assetGcIntervalMs: 15 });
    await adapter.loadAll();
    const { assetId } = await adapter.assets.put(Buffer.from('periodic orphan'), PNG_MIME);
    makeOld(assetPath(dataDir, assetId));

    await expect
      .poll(() => !existsSync(assetPath(dataDir, assetId)), { timeout: 1_000 })
      .toBe(true);
  });

  it('clears its periodic timer and awaits an in-flight scan during close', async () => {
    const dataDir = makeDataDir();
    const adapter = makeAdapter(dataDir, { assetGcGraceMs: 0, assetGcIntervalMs: 100 });
    await adapter.loadAll();

    const originalList = adapter.assets.list!.bind(adapter.assets);
    let releaseList!: () => void;
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    adapter.assets.list = async () => {
      markListStarted();
      await listGate;
      return originalList();
    };

    const collection = adapter.collectOrphanAssets();
    await listStarted;
    let closeFinished = false;
    const close = adapter.close().then(() => {
      closeFinished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeFinished).toBe(false);
    releaseList();
    await Promise.all([collection, close]);
    expect(closeFinished).toBe(true);

    const { assetId } = await adapter.assets.put(Buffer.from('after close'), PNG_MIME);
    makeOld(assetPath(dataDir, assetId));
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(existsSync(assetPath(dataDir, assetId))).toBe(true);
    expect(readFileSync(assetPath(dataDir, assetId))).toEqual(Buffer.from('after close'));
  });
});
