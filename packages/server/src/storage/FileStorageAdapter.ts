import { createSampleDocument, migrateDocument, type PitoletDocument } from '@pitolet/schema';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { AppliedPatch } from '../store/DocumentStore.js';
import {
  ASSET_EXT_BY_MIME,
  ASSET_ID_PATTERN,
  assetMimeForId,
  type AssetStorage,
  type LoadedDoc,
  type StorageAdapter,
} from './StorageAdapter.js';

const FILE_SUFFIX = '.pitolet.json';
const SAVE_DEBOUNCE_MS = 500;
const SAVE_RETRY_MS = 2_000;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const DEFAULT_ASSET_GC_GRACE_MS = 60 * 60 * 1_000;
export const DEFAULT_ASSET_GC_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface FileStorageAdapterOptions {
  /**
   * Minimum age of an unreferenced asset before it may be removed. The grace
   * protects the upload-before-import window. Defaults to one hour.
   */
  assetGcGraceMs?: number;
  /**
   * Delay between orphan scans. Set to zero to disable periodic scans while
   * retaining the scan performed after loadAll(). Defaults to six hours.
   */
  assetGcIntervalMs?: number;
}

/**
 * File-backed storage: documents live as human-readable JSON files in the
 * data directory — repo-native and git-friendly. Saves are debounced and
 * atomic (tmp + rename). External edits (git checkout, an agent editing the
 * file directly) are detected via fs.watch and surfaced through
 * onExternalChange. Assets are content-addressed files in <dataDir>/assets.
 */
export class FileStorageAdapter implements StorageAdapter {
  readonly exportBaseDir: string;
  readonly assets: AssetStorage;

  private readonly fileAssets: FileAssetStorage;
  private readonly assetGcGraceMs: number;
  private readonly assetGcIntervalMs: number;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private pendingDocs = new Map<string, PitoletDocument>();
  /** Latest in-process version, including documents not yet written to disk. */
  private liveDocs = new Map<string, PitoletDocument>();
  private fileForDoc = new Map<string, string>();
  /** Files we just wrote — ignore the watcher echo for these. */
  private selfWrites = new Set<string>();
  private selfWriteTimers = new Map<string, NodeJS.Timeout>();
  private externalChangeTimers = new Map<string, NodeJS.Timeout>();
  private watcher: ReturnType<typeof watch> | null = null;
  private assetGcTimer: NodeJS.Timeout | null = null;
  private assetGcInFlight: Promise<number> | null = null;
  private closing = false;

  constructor(
    private dataDir: string,
    options: FileStorageAdapterOptions = {},
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.exportBaseDir = dataDir;
    this.assetGcGraceMs = nonNegativeDuration(
      options.assetGcGraceMs,
      DEFAULT_ASSET_GC_GRACE_MS,
      'assetGcGraceMs',
    );
    this.assetGcIntervalMs = nonNegativeDuration(
      options.assetGcIntervalMs,
      DEFAULT_ASSET_GC_INTERVAL_MS,
      'assetGcIntervalMs',
    );
    this.fileAssets = new FileAssetStorage(join(dataDir, 'assets'));
    this.assets = this.fileAssets;
  }

  /** Load every document in the data dir; create the sample doc if empty. */
  async loadAll(): Promise<LoadedDoc[]> {
    const files = readdirSync(this.dataDir)
      .filter((f) => f.endsWith(FILE_SUFFIX))
      .sort();
    if (files.length === 0) {
      const sample = createSampleDocument();
      this.writeNow(sample);
      await this.collectOrphanAssets();
      this.scheduleAssetGc();
      return [{ doc: sample, rev: 0 }];
    }
    const docs: LoadedDoc[] = [];
    for (const file of files) {
      try {
        const doc = this.readFile(file);
        if (this.fileForDoc.has(doc.id)) {
          console.error(
            `[pitolet] skipping duplicate document id ${doc.id} in ${file}; already loaded from ${this.fileForDoc.get(doc.id)}`,
          );
          continue;
        }
        this.fileForDoc.set(doc.id, file);
        this.liveDocs.set(doc.id, doc);
        docs.push({ doc, rev: 0 });
      } catch (err) {
        console.error(`[pitolet] skipping unreadable document ${file}:`, err);
      }
    }
    await this.collectOrphanAssets();
    this.scheduleAssetGc();
    return docs;
  }

  handlePatch(_patch: AppliedPatch, doc: PitoletDocument): void {
    this.liveDocs.set(doc.id, doc);
    this.scheduleSave(doc);
  }

  async saveNow(doc: PitoletDocument, _rev: number): Promise<void> {
    const timer = this.saveTimers.get(doc.id);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(doc.id);
    this.pendingDocs.delete(doc.id);
    this.writeNow(doc);
  }

  /**
   * Remove content-addressed assets that are older than the grace period and
   * absent from every valid document on disk and every live/pending document.
   * Concurrent calls share one scan. Filesystem or document-read failures are
   * fail-closed: the scan logs the failure and removes nothing.
   */
  collectOrphanAssets(): Promise<number> {
    if (this.closing) return this.assetGcInFlight ?? Promise.resolve(0);
    if (this.assetGcInFlight) return this.assetGcInFlight;

    const run = this.collectOrphanAssetsNow()
      .catch((error) => {
        console.error('[pitolet] asset cleanup skipped:', error);
        return 0;
      })
      .finally(() => {
        if (this.assetGcInFlight === run) this.assetGcInFlight = null;
      });
    this.assetGcInFlight = run;
    return run;
  }

  async flush(): Promise<void> {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    const failures: Error[] = [];
    for (const [docId, doc] of this.pendingDocs) {
      try {
        this.writeNow(doc);
        if (this.pendingDocs.get(docId) === doc) this.pendingDocs.delete(docId);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to save ${failures.length} document(s)`);
    }
  }

  /** Watch for external file edits. Callback receives freshly parsed docs. */
  onExternalChange(callback: (doc: PitoletDocument) => void): void {
    this.watcher?.close();
    try {
      this.watcher = watch(this.dataDir, (_event, fileName) => {
        if (this.closing || !fileName || !fileName.endsWith(FILE_SUFFIX)) return;
        if (this.selfWrites.has(fileName)) return;
        if (!existsSync(join(this.dataDir, fileName))) return;
        // Debounce rapid write sequences from external tools.
        const existing = this.externalChangeTimers.get(fileName);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.externalChangeTimers.delete(fileName);
          if (this.closing || this.selfWrites.has(fileName)) return;
          try {
            const doc = this.readFile(fileName);
            const existingFile = this.fileForDoc.get(doc.id);
            if (existingFile && existingFile !== fileName) {
              console.error(
                `[pitolet] ignoring duplicate document id ${doc.id} in external file ${fileName}`,
              );
              return;
            }
            this.fileForDoc.set(doc.id, fileName);
            this.liveDocs.set(doc.id, doc);
            callback(doc);
          } catch {
            // Mid-write or invalid — the next change event will retry.
          }
        }, 120);
        timer.unref?.();
        this.externalChangeTimers.set(fileName, timer);
      });
      this.watcher.on('error', (error) => {
        if (!this.closing) {
          console.error('[pitolet] document file watcher stopped:', error);
        }
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (error) {
      this.watcher = null;
      console.error('[pitolet] document file watching is unavailable:', error);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.assetGcTimer) clearTimeout(this.assetGcTimer);
    this.assetGcTimer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.externalChangeTimers.values()) clearTimeout(timer);
    this.externalChangeTimers.clear();
    for (const timer of this.selfWriteTimers.values()) clearTimeout(timer);
    this.selfWriteTimers.clear();
    this.selfWrites.clear();
    await this.assetGcInFlight;
    await this.flush();
  }

  private scheduleSave(doc: PitoletDocument): void {
    if (this.closing) {
      this.pendingDocs.set(doc.id, doc);
      try {
        this.writeNow(doc);
        if (this.pendingDocs.get(doc.id) === doc) this.pendingDocs.delete(doc.id);
      } catch (error) {
        console.error(`[pitolet] failed to save ${doc.name} during shutdown:`, error);
      }
      return;
    }
    const existing = this.saveTimers.get(doc.id);
    if (existing) clearTimeout(existing);
    this.pendingDocs.set(doc.id, doc);
    this.saveTimers.set(
      doc.id,
      setTimeout(() => {
        this.saveTimers.delete(doc.id);
        const pending = this.pendingDocs.get(doc.id);
        if (!pending) return;
        try {
          this.writeNow(pending);
          if (this.pendingDocs.get(doc.id) === pending) this.pendingDocs.delete(doc.id);
        } catch (error) {
          console.error(`[pitolet] failed to save ${pending.name}; retrying:`, error);
          if (!this.closing) {
            this.saveTimers.set(
              doc.id,
              setTimeout(() => {
                this.saveTimers.delete(doc.id);
                const retry = this.pendingDocs.get(doc.id);
                if (retry) this.scheduleSave(retry);
              }, SAVE_RETRY_MS),
            );
          }
        }
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private writeNow(doc: PitoletDocument): void {
    const file =
      this.fileForDoc.get(doc.id) ?? `${sanitize(doc.name)}-${sanitizeId(doc.id)}${FILE_SUFFIX}`;
    this.fileForDoc.set(doc.id, file);
    const path = join(this.dataDir, file);
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    this.selfWrites.add(file);
    const oldSelfWriteTimer = this.selfWriteTimers.get(file);
    if (oldSelfWriteTimer) clearTimeout(oldSelfWriteTimer);
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      this.selfWrites.delete(file);
      throw error;
    } finally {
      rmSync(tmp, { force: true });
    }
    this.liveDocs.set(doc.id, doc);
    const timer = setTimeout(() => {
      this.selfWriteTimers.delete(file);
      this.selfWrites.delete(file);
    }, 1500);
    timer.unref?.();
    this.selfWriteTimers.set(file, timer);
  }

  private readFile(fileName: string): PitoletDocument {
    const path = join(this.dataDir, fileName);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`document path ${fileName} is not a regular file`);
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return migrateDocument(raw);
  }

  private async collectOrphanAssetsNow(): Promise<number> {
    const assets = await this.fileAssets.list();
    if (assets.length === 0) return 0;

    // Re-read disk documents after the asynchronous list boundary. Changes
    // made by an editor/import while listing are therefore included before
    // deletion starts.
    const references = this.collectAssetReferences();
    if (!references) return 0;

    const cutoff = Date.now() - this.assetGcGraceMs;
    let removed = 0;
    // removeIfOlderThan() is synchronous internally. No request handler can
    // interleave between the final reference snapshot and these checks, and a
    // same-content re-upload refreshes mtime before it returns to the caller.
    for (const asset of assets) {
      if (references.has(asset.assetId) || asset.modifiedAt > cutoff) continue;
      if (this.fileAssets.removeIfOlderThan(asset.assetId, cutoff)) removed += 1;
    }
    if (removed > 0) {
      console.log(
        `[pitolet] removed ${removed} unreferenced asset${removed === 1 ? '' : 's'} older than ${this.assetGcGraceMs} ms`,
      );
    }
    return removed;
  }

  /**
   * Return null when even one on-disk document cannot be read and validated.
   * In that case cleanup must remove nothing: a skipped document may be the
   * only owner of an otherwise apparently orphaned asset.
   */
  private collectAssetReferences(): Set<string> | null {
    const references = new Set<string>();
    let files: string[];
    try {
      files = readdirSync(this.dataDir)
        .filter((file) => file.endsWith(FILE_SUFFIX))
        .sort();
    } catch (error) {
      console.error('[pitolet] asset cleanup could not list documents:', error);
      return null;
    }

    for (const file of files) {
      try {
        addDocumentAssetReferences(references, this.readFile(file));
      } catch (error) {
        console.error(
          `[pitolet] asset cleanup skipped because document ${file} is unreadable or invalid:`,
          error,
        );
        return null;
      }
    }

    // A live edit can be newer than its file, while a pending document may
    // not have a file at all yet. Keep the union rather than trusting disk.
    for (const doc of this.liveDocs.values()) addDocumentAssetReferences(references, doc);
    for (const doc of this.pendingDocs.values()) addDocumentAssetReferences(references, doc);
    return references;
  }

  private scheduleAssetGc(): void {
    if (this.closing || this.assetGcIntervalMs === 0 || this.assetGcTimer) return;
    this.assetGcTimer = setTimeout(() => {
      this.assetGcTimer = null;
      void this.runScheduledAssetGc();
    }, this.assetGcIntervalMs);
    this.assetGcTimer.unref?.();
  }

  private async runScheduledAssetGc(): Promise<void> {
    await this.collectOrphanAssets();
    this.scheduleAssetGc();
  }
}

/** Content-addressed asset files in <dataDir>/assets. */
class FileAssetStorage implements AssetStorage {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async put(data: Buffer, mime: string): Promise<{ assetId: string }> {
    if (data.length > MAX_ASSET_BYTES) throw new Error('asset exceeds 20 MB');
    const ext = ASSET_EXT_BY_MIME[mime];
    if (!ext) throw new Error(`unsupported asset type ${mime}`);
    const hash = createHash('sha256').update(data).digest('hex');
    const assetId = `${hash}.${ext}`;
    const path = join(this.dir, assetId);
    if (existsSync(path)) {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`asset path ${assetId} is not a regular file`);
      }
    } else {
      const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        writeFileSync(temp, data, { mode: 0o600 });
        // Concurrent writes have identical bytes by construction. Replacing
        // one complete file with another complete file remains atomic.
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    if (!readFileSync(path).equals(data)) {
      // A content-addressed collision should be impossible with SHA-256. Fail
      // closed instead of silently returning an id for different bytes.
      throw new Error(`asset digest collision for ${assetId}`);
    }
    // Re-uploading identical content is still a new upload attempt. Refresh
    // its age so garbage collection cannot remove an old, currently
    // unreferenced copy while the importer is about to create its document.
    const now = new Date();
    utimesSync(path, now, now);
    return { assetId };
  }

  async get(assetId: string): Promise<{ stream: Readable; mime: string; size?: number } | null> {
    // Content-addressed names only — no traversal.
    if (!ASSET_ID_PATTERN.test(assetId)) return null;
    const path = join(this.dir, assetId);
    if (!existsSync(path)) return null;
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) return null;
      return { stream: createReadStream(path), mime: assetMimeForId(assetId), size: entry.size };
    } catch {
      // The file may have been removed between existsSync and lstatSync.
      return null;
    }
  }

  async list(): Promise<Array<{ assetId: string; size: number; modifiedAt: number }>> {
    const assets: Array<{ assetId: string; size: number; modifiedAt: number }> = [];
    for (const assetId of readdirSync(this.dir)) {
      if (!ASSET_ID_PATTERN.test(assetId)) continue;
      try {
        const entry = lstatSync(join(this.dir, assetId));
        if (!entry.isSymbolicLink() && entry.isFile()) {
          assets.push({ assetId, size: entry.size, modifiedAt: entry.mtimeMs });
        }
      } catch {
        // A concurrent cleanup may have removed the entry.
      }
    }
    return assets;
  }

  async remove(assetId: string): Promise<boolean> {
    if (!ASSET_ID_PATTERN.test(assetId)) return false;
    const path = join(this.dir, assetId);
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  removeIfOlderThan(assetId: string, cutoff: number): boolean {
    if (!ASSET_ID_PATTERN.test(assetId)) return false;
    const path = join(this.dir, assetId);
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.mtimeMs > cutoff) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
}

function addDocumentAssetReferences(references: Set<string>, doc: PitoletDocument): void {
  for (const assetId of Object.keys(doc.assets)) references.add(assetId);
  // Valid documents declare every referenced image in doc.assets. These
  // defensive checks also preserve references in an in-process document
  // while a multi-step caller is still assembling it.
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'image' && 'asset' in node.src) references.add(node.src.asset);
    if (node.type !== 'instance') continue;
    for (const override of Object.values(node.overrides)) {
      if (override.src && 'asset' in override.src) references.add(override.src.asset);
    }
  }
}

function nonNegativeDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`${name} must be a finite, non-negative number`);
  }
  return duration;
}

function sanitize(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 80) || 'untitled'
  );
}

function sanitizeId(id: string): string {
  return (
    id
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 128) || 'document'
  );
}
