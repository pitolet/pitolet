import { attach, createDocument, createFrame, createImage } from '@pitolet/schema';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDrift, exportDirFor, exportProject, MANIFEST_NAME } from '../src/export.js';
import { FileStorageAdapter } from '../src/storage/FileStorageAdapter.js';

describe('project asset export', () => {
  let dataDir: string | null = null;

  afterEach(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it('copies content-addressed images and tracks their drift', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-export-assets-'));
    const adapter = new FileStorageAdapter(dataDir);
    const bytes = Buffer.from('asset-bytes');
    const { assetId } = await adapter.assets.put(bytes, 'image/png');
    const doc = createDocument({ name: 'Asset page' });
    const frame = attach(doc, null, createFrame({ name: 'Page' }));
    attach(doc, frame.id, createImage({ src: { asset: assetId }, alt: 'Example' }));
    doc.assets[assetId] = {
      fileName: 'example.png',
      mime: 'image/png',
      width: 10,
      height: 10,
    };

    const result = await exportProject(doc, dataDir, {}, adapter.assets);
    const relativeAsset = `assets/${assetId}`;
    expect(result.files).toContain(relativeAsset);
    const exportedAsset = join(result.dir, relativeAsset);
    expect(existsSync(exportedAsset)).toBe(true);
    expect(readFileSync(exportedAsset)).toEqual(bytes);
    expect(checkDrift(doc, dataDir)?.find((entry) => entry.path === relativeAsset)?.status).toBe(
      'in-sync',
    );

    writeFileSync(exportedAsset, 'changed');
    expect(checkDrift(doc, dataDir)?.find((entry) => entry.path === relativeAsset)?.status).toBe(
      'file-edited',
    );
    await adapter.close();
  });

  it('uses a writable document-specific directory and removes stale managed files', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-export-clean-'));
    const doc = createDocument({ name: 'Same name' });
    const frame = attach(doc, null, createFrame({ name: 'Old frame' }));

    const first = await exportProject(doc, dataDir);
    const oldFile = first.files.find((path) => path.includes('OldFrame'));
    expect(oldFile).toBeTruthy();
    expect(first.dir).toBe(exportDirFor(doc, dataDir));
    expect(first.dir.startsWith(join(dataDir, 'exports'))).toBe(true);

    doc.nodes[frame.id]!.name = 'New frame';
    const second = await exportProject(doc, dataDir);
    expect(second.dir).toBe(first.dir);
    expect(existsSync(join(first.dir, oldFile!))).toBe(false);

    const other = createDocument({ name: 'Same name' });
    expect(exportDirFor(other, dataDir)).not.toBe(first.dir);
  });

  it('flushes pending debounced document writes when closed', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-close-flush-'));
    const adapter = new FileStorageAdapter(dataDir);
    const loaded = await adapter.loadAll();
    const doc = loaded[0]!.doc;
    doc.name = 'Saved at shutdown';
    adapter.handlePatch(
      {
        docId: doc.id,
        rev: 1,
        ops: [],
        origin: 'test',
        label: 'rename',
      },
      doc,
    );

    await adapter.close();

    const documentFile = readdirSync(dataDir).find((file) => file.endsWith('.pitolet.json'));
    expect(documentFile).toBeTruthy();
    const saved = readFileSync(join(dataDir, documentFile!), 'utf8');
    expect(JSON.parse(saved).name).toBe('Saved at shutdown');
  });

  it('does not let an older debounced save overwrite a newer immediate save', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-save-order-'));
    const adapter = new FileStorageAdapter(dataDir);
    const loaded = await adapter.loadAll();
    const oldDocument = structuredClone(loaded[0]!.doc);
    oldDocument.name = 'Older pending value';
    adapter.handlePatch(
      {
        docId: oldDocument.id,
        rev: 1,
        ops: [],
        origin: 'test',
        label: 'old rename',
      },
      oldDocument,
    );

    const newDocument = structuredClone(oldDocument);
    newDocument.name = 'Newest immediate value';
    await adapter.saveNow(newDocument, 2);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await adapter.close();

    const documentFile = readdirSync(dataDir).find((file) => file.endsWith('.pitolet.json'));
    expect(documentFile).toBeTruthy();
    expect(JSON.parse(readFileSync(join(dataDir, documentFile!), 'utf8')).name).toBe(
      'Newest immediate value',
    );
  });

  it('uses a complete SHA-256 digest for new assets', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-full-digest-'));
    const adapter = new FileStorageAdapter(dataDir);
    const { assetId } = await adapter.assets.put(Buffer.from('digest me'), 'image/png');
    expect(assetId).toMatch(/^[a-f0-9]{64}\.png$/);
    await adapter.close();
  });

  it('keeps hostile document ids inside the data directory', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-safe-id-'));
    const adapter = new FileStorageAdapter(dataDir);
    const outsideName = `${basename(dataDir)}-outside`;
    const outsidePath = join(tmpdir(), `${outsideName}.pitolet.json`);
    rmSync(outsidePath, { force: true });
    const doc = createDocument({ id: `/../../${outsideName}`, name: '' });

    try {
      await adapter.saveNow(doc, 0);
      expect(existsSync(outsidePath)).toBe(false);
      expect(readdirSync(dataDir).some((file) => file.endsWith('.pitolet.json'))).toBe(true);
    } finally {
      rmSync(outsidePath, { force: true });
      await adapter.close();
    }
  });

  it.skipIf(process.platform === 'win32')('does not serve asset symlinks', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-asset-symlink-'));
    const adapter = new FileStorageAdapter(dataDir);
    const bytes = Buffer.from('safe image bytes');
    const { assetId } = await adapter.assets.put(bytes, 'image/png');
    const assetPath = join(dataDir, 'assets', assetId);
    rmSync(assetPath);
    symlinkSync('/etc/hosts', assetPath);

    expect(await adapter.assets.get(assetId)).toBeNull();
    await adapter.close();
  });

  it.skipIf(process.platform === 'win32')(
    'does not load document symlinks from outside the data directory',
    async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'pitolet-document-symlink-'));
      const outsideDir = mkdtempSync(join(tmpdir(), 'pitolet-document-outside-'));
      const outsidePath = join(outsideDir, 'outside.pitolet.json');
      const outsideDocument = createDocument({ name: 'Outside document' });
      writeFileSync(outsidePath, JSON.stringify(outsideDocument));
      symlinkSync(outsidePath, join(dataDir, 'linked.pitolet.json'));
      const adapter = new FileStorageAdapter(dataDir);

      try {
        const loaded = await adapter.loadAll();
        expect(loaded.some(({ doc }) => doc.id === outsideDocument.id)).toBe(false);
      } finally {
        await adapter.close();
        rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it('rejects hostile manifest paths without touching files outside the export', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-export-manifest-'));
    const doc = createDocument({ name: 'Safe page' });
    attach(doc, null, createFrame({ name: 'Page' }));
    const result = await exportProject(doc, dataDir);
    const outside = join(dataDir, 'must-stay.txt');
    writeFileSync(outside, 'keep');
    writeFileSync(
      join(result.dir, MANIFEST_NAME),
      JSON.stringify({
        docId: doc.id,
        annotate: false,
        files: {
          '../../must-stay.txt': { hash: '0'.repeat(40) },
        },
      }),
    );

    await expect(exportProject(doc, dataDir)).rejects.toThrow('unsafe export path');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('validates all assets before changing an existing export', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-export-transaction-'));
    const adapter = new FileStorageAdapter(dataDir);
    const doc = createDocument({ name: 'Transactional page' });
    attach(doc, null, createFrame({ name: 'Page' }));
    const first = await exportProject(doc, dataDir, {}, adapter.assets);
    const originalManifest = readFileSync(join(first.dir, MANIFEST_NAME), 'utf8');

    const missingId = `${'a'.repeat(64)}.png`;
    doc.assets[missingId] = {
      fileName: 'missing.png',
      mime: 'image/png',
      width: 10,
      height: 10,
    };
    await expect(exportProject(doc, dataDir, {}, adapter.assets)).rejects.toThrow(
      'is missing from storage',
    );
    expect(readFileSync(join(first.dir, MANIFEST_NAME), 'utf8')).toBe(originalManifest);
    await adapter.close();
  });
});
