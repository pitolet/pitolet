import {
  createSampleDocument,
  migrateDocument,
  type PitoletDocument,
} from '@pitolet/schema';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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

  private saveTimers = new Map<string, NodeJS.Timeout>();
  private pendingDocs = new Map<string, PitoletDocument>();
  private fileForDoc = new Map<string, string>();
  /** Files we just wrote — ignore the watcher echo for these. */
  private selfWrites = new Set<string>();
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.exportBaseDir = dataDir;
    this.assets = new FileAssetStorage(join(dataDir, 'assets'));
  }

  /** Load every document in the data dir; create the sample doc if empty. */
  async loadAll(): Promise<LoadedDoc[]> {
    const files = readdirSync(this.dataDir).filter((f) => f.endsWith(FILE_SUFFIX));
    if (files.length === 0) {
      const sample = createSampleDocument();
      this.writeNow(sample);
      return [{ doc: sample, rev: 0 }];
    }
    const docs: LoadedDoc[] = [];
    for (const file of files) {
      try {
        const doc = this.readFile(file);
        this.fileForDoc.set(doc.id, file);
        docs.push({ doc, rev: 0 });
      } catch (err) {
        console.error(`[pitolet] skipping unreadable document ${file}:`, err);
      }
    }
    return docs;
  }

  handlePatch(_patch: AppliedPatch, doc: PitoletDocument): void {
    this.scheduleSave(doc);
  }

  async saveNow(doc: PitoletDocument, _rev: number): Promise<void> {
    this.writeNow(doc);
  }

  async flush(): Promise<void> {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    for (const doc of this.pendingDocs.values()) this.writeNow(doc);
    this.pendingDocs.clear();
  }

  /** Watch for external file edits. Callback receives freshly parsed docs. */
  onExternalChange(callback: (doc: PitoletDocument) => void): void {
    this.watcher = watch(this.dataDir, (_event, fileName) => {
      if (!fileName || !fileName.endsWith(FILE_SUFFIX)) return;
      if (this.selfWrites.has(fileName)) return;
      if (!existsSync(join(this.dataDir, fileName))) return;
      // Debounce rapid write sequences from external tools.
      setTimeout(() => {
        try {
          const doc = this.readFile(fileName);
          this.fileForDoc.set(doc.id, fileName);
          callback(doc);
        } catch {
          // Mid-write or invalid — the next change event will retry.
        }
      }, 120);
    });
  }

  async close(): Promise<void> {
    this.watcher?.close();
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.pendingDocs.clear();
  }

  private scheduleSave(doc: PitoletDocument): void {
    const existing = this.saveTimers.get(doc.id);
    if (existing) clearTimeout(existing);
    this.pendingDocs.set(doc.id, doc);
    this.saveTimers.set(
      doc.id,
      setTimeout(() => {
        this.saveTimers.delete(doc.id);
        const pending = this.pendingDocs.get(doc.id);
        this.pendingDocs.delete(doc.id);
        if (pending) this.writeNow(pending);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private writeNow(doc: PitoletDocument): void {
    const file = this.fileForDoc.get(doc.id) ?? `${sanitize(doc.name)}-${doc.id}${FILE_SUFFIX}`;
    this.fileForDoc.set(doc.id, file);
    const path = join(this.dataDir, file);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, path);
    this.selfWrites.add(file);
    setTimeout(() => this.selfWrites.delete(file), 1500);
  }

  private readFile(fileName: string): PitoletDocument {
    const raw = JSON.parse(readFileSync(join(this.dataDir, fileName), 'utf8'));
    return migrateDocument(raw);
  }
}

/** Content-addressed asset files in <dataDir>/assets. */
class FileAssetStorage implements AssetStorage {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async put(data: Buffer, mime: string): Promise<{ assetId: string }> {
    const ext = ASSET_EXT_BY_MIME[mime];
    if (!ext) throw new Error(`unsupported image type ${mime}`);
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 16);
    const assetId = `${hash}.${ext}`;
    const path = join(this.dir, assetId);
    if (!existsSync(path)) writeFileSync(path, data);
    return { assetId };
  }

  async get(assetId: string): Promise<{ stream: Readable; mime: string } | null> {
    // Content-addressed names only — no traversal.
    if (!ASSET_ID_PATTERN.test(assetId)) return null;
    const path = join(this.dir, assetId);
    if (!existsSync(path)) return null;
    return { stream: createReadStream(path), mime: assetMimeForId(assetId) };
  }
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'untitled';
}
