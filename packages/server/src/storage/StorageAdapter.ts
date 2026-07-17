import type { PitoletDocument } from '@pitolet/schema';
import type { Readable } from 'node:stream';
import type { AppliedPatch } from '../store/DocumentStore.js';

export interface LoadedDoc {
  doc: PitoletDocument;
  rev: number;
}

/**
 * Binary asset storage (images). Assets are content-addressed:
 * put() derives the id from a hash of the data, so ids are stable and
 * immutable-cacheable. HTTP concerns (request parsing, response writing,
 * cache headers) live in the server layer — see assets.ts.
 */
export interface AssetStorage {
  put(data: Buffer, mime: string): Promise<{ assetId: string }>;
  get(assetId: string): Promise<{ stream: Readable; mime: string; size?: number } | null>;
  /** Optional filesystem/object-store capabilities used by orphan collection. */
  list?(): Promise<Array<{ assetId: string; size: number; modifiedAt: number }>>;
  remove?(assetId: string): Promise<boolean>;
}

/**
 * Storage backend for Pitolet documents + assets. The adapter is a
 * patch consumer: the runtime forwards every applied patch and the
 * adapter owns its own write strategy (debouncing, batching, …).
 *
 * Optional capabilities:
 * - onExternalChange: backends that can detect out-of-band edits
 *   (fs.watch) surface freshly parsed documents through this callback.
 * - exportBaseDir: a local directory exports can be written next to —
 *   gates the export/drift features (REST /api/export and the
 *   export_project / check_drift MCP tools).
 */
export interface StorageAdapter {
  /** Load every document in scope (creating seed content if applicable). */
  loadAll(): Promise<LoadedDoc[]>;
  /** Called for every applied patch; the adapter owns debounce. Must not throw. */
  handlePatch(patch: AppliedPatch, doc: PitoletDocument): void;
  /** Persist immediately — for docs not born from patches (create_document, external replace). */
  saveNow(doc: PitoletDocument, rev: number): Promise<void>;
  deleteDoc?(docId: string): Promise<void>;
  /** Drain pending (debounced) writes. */
  flush(): Promise<void>;
  /** OPTIONAL capability: observe external edits to the backing storage. */
  onExternalChange?(cb: (doc: PitoletDocument) => void): void;
  /** OPTIONAL capability: local directory anchoring code export + drift checks. */
  exportBaseDir?: string;
  assets: AssetStorage;
  close(): Promise<void>;
}

/** Supported asset image types → content-addressed file extension. */
export const ASSET_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
};

/**
 * Content-addressed asset ids. New assets use the complete SHA-256 digest.
 * The 16-character form remains readable for documents created by older
 * Pitolet releases.
 */
export const ASSET_ID_PATTERN = /^(?:[a-f0-9]{16}|[a-f0-9]{64})\.[a-z0-9]+$/;

/** Derive the mime type from a content-addressed asset id's extension. */
export function assetMimeForId(assetId: string): string {
  const ext = assetId.split('.')[1]!;
  return (
    Object.entries(ASSET_EXT_BY_MIME).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream'
  );
}
