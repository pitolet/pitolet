import {
  migrateDocument,
  validateDocument,
  type PitoletDocument,
} from '@pitolet/schema';
import { applyPatches, enablePatches, type Patch } from 'immer';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  FileStorageAdapter,
  type AssetStorage,
  type LoadedDoc,
  type StorageAdapter,
} from 'pitolet';
import type { AppliedPatch } from 'pitolet';

// applyPatches needs the patches plugin; the OSS DocumentStore enables it in
// its own module scope, which this file does not import at runtime.
enablePatches();

export interface PgStorageAdapterOptions {
  /** Debounce for the full-doc UPDATE after a patch. */
  debounceMs?: number;
  /** A patch storm can't defer the doc UPDATE past this. */
  maxWaitMs?: number;
  /** Auto-snapshot after this many revisions since the last snapshot. */
  snapshotEveryRevs?: number;
  /** … or after this much time (if the rev advanced). */
  snapshotEveryMs?: number;
  /** Error sink (tests); defaults to console.error. */
  logError?: (message: string, err?: unknown) => void;
  /**
   * Plan-driven quotas (Pitolet Cloud). Getters read LIVE values so a plan
   * flip (Paddle webhook) applies without reloading the runtime.
   */
  quota?: PgStorageQuota;
}

export interface PgStorageQuota {
  /** Max total asset bytes for the workspace (Infinity = unlimited). */
  maxAssetBytes: () => number;
  /** User-facing error thrown when an upload would exceed the quota. */
  assetLimitMessage: () => string;
  /**
   * History retention: auto-snapshots older than this many days are pruned
   * on the snapshot-write path. Named / pre-restore snapshots live forever.
   */
  historyDays: () => number;
}

interface DocState {
  latestDoc: PitoletDocument;
  latestRev: number;
  /** Serialized per-doc revision INSERT chain — ordering guaranteed. */
  revQueue: Promise<void>;
  /** Serialized per-doc full-doc UPDATE chain. */
  writeChain: Promise<void>;
  pendingWrite: boolean;
  /** Set when a revision INSERT failed: the next doc UPDATE goes out immediately. */
  forceWrite: boolean;
  debounceTimer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
  lastSnapshotRev: number;
  lastSnapshotAt: number;
}

/**
 * Postgres-backed StorageAdapter for Pitolet Cloud. One adapter per
 * workspace; EVERY query is scoped to that workspace_id, so a document id
 * from another tenant can never be read or written through this adapter.
 *
 * Durability model: every applied patch is appended to doc_revisions
 * immediately (serialized per doc); the full document row is written on a
 * debounce. On load, any revisions ahead of documents.rev are replayed
 * (crash recovery), validated, and written back.
 */
export class PgStorageAdapter implements StorageAdapter {
  readonly assets: AssetStorage;

  /**
   * Plan gate for NEW documents (set by WorkspaceManager once the runtime
   * exists; throws a user-facing error when the plan doc limit is hit).
   * This is the enforcement chokepoint for MCP create_document, which
   * persists via saveNow without consulting the runtime authorize hook.
   */
  beforeDocCreate: (() => void) | null = null;

  private readonly docs = new Map<string, DocState>();
  private readonly opts: Required<Omit<PgStorageAdapterOptions, 'logError' | 'quota'>>;
  private readonly quota: PgStorageQuota | null;
  private readonly logError: (message: string, err?: unknown) => void;

  constructor(
    private readonly pool: Pool,
    private readonly workspaceId: string,
    dataRoot: string,
    options: PgStorageAdapterOptions = {},
  ) {
    this.opts = {
      debounceMs: options.debounceMs ?? 1_000,
      maxWaitMs: options.maxWaitMs ?? 10_000,
      snapshotEveryRevs: options.snapshotEveryRevs ?? 200,
      snapshotEveryMs: options.snapshotEveryMs ?? 10 * 60_000,
    };
    this.quota = options.quota ?? null;
    this.logError =
      options.logError ?? ((message, err) => console.error(`[pitolet-cloud] ${message}`, err ?? ''));
    // Reuse the OSS content-addressed file asset storage (sha256-16 ids,
    // traversal-proof) rooted per workspace. FileAssetStorage itself isn't
    // exported, but FileStorageAdapter exposes it; we only borrow `.assets`
    // (the constructor just mkdirs — no watcher, no timers).
    const fileAssets = new FileStorageAdapter(
      join(dataRoot, 'workspaces', workspaceId),
    ).assets;
    this.assets = this.quota ? this.quotaCheckedAssets(fileAssets, this.quota) : fileAssets;
  }

  /**
   * Byte-quota wrapper around asset storage. The running total lives in
   * workspaces.asset_bytes (migration 003): checked before the write,
   * incremented after. Slightly approximate on purpose — concurrent uploads
   * can race the check and content-addressed duplicates still count — this
   * is an abuse ceiling, not accounting.
   */
  private quotaCheckedAssets(inner: AssetStorage, quota: PgStorageQuota): AssetStorage {
    return {
      get: (assetId) => inner.get(assetId),
      put: async (data, mime) => {
        const limit = quota.maxAssetBytes();
        if (Number.isFinite(limit)) {
          const res = await this.pool.query(
            'SELECT asset_bytes FROM workspaces WHERE id = $1',
            [this.workspaceId],
          );
          const used = Number(res.rows[0]?.asset_bytes ?? 0);
          if (used + data.length > limit) {
            throw new Error(quota.assetLimitMessage());
          }
        }
        const result = await inner.put(data, mime);
        await this.pool
          .query('UPDATE workspaces SET asset_bytes = asset_bytes + $2 WHERE id = $1', [
            this.workspaceId,
            data.length,
          ])
          .catch((err) => this.logError('asset byte counter update failed', err));
        return result;
      },
    };
  }

  /**
   * Load every live document in the workspace. If the revision log is ahead
   * of the stored doc (crash between revision append and doc UPDATE), replay
   * the missing revisions, validate, and persist the healed doc.
   */
  async loadAll(): Promise<LoadedDoc[]> {
    const res = await this.pool.query(
      'SELECT id, doc, rev FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL',
      [this.workspaceId],
    );
    const out: LoadedDoc[] = [];
    for (const row of res.rows) {
      let doc = migrateDocument(row.doc);
      let rev = Number(row.rev);
      try {
        const healed = await this.healFromRevisionLog(row.id as string, doc, rev);
        doc = healed.doc;
        rev = healed.rev;
      } catch (err) {
        // A broken replay must not take the workspace down or destroy data:
        // serve the last stored doc; the revision rows stay in the log.
        this.logError(
          `crash-recovery replay failed for document ${row.id} — serving stored rev ${rev}`,
          err,
        );
      }
      this.docs.set(doc.id, this.freshState(doc, rev));
      out.push({ doc, rev });
    }
    return out;
  }

  private async healFromRevisionLog(
    docId: string,
    doc: PitoletDocument,
    rev: number,
  ): Promise<{ doc: PitoletDocument; rev: number }> {
    const head = await this.pool.query(
      'SELECT max(rev) AS max_rev FROM doc_revisions WHERE doc_id = $1',
      [docId],
    );
    const maxRev = head.rows[0]?.max_rev == null ? rev : Number(head.rows[0].max_rev);
    if (maxRev <= rev) return { doc, rev };

    const missing = await this.pool.query(
      'SELECT rev, ops FROM doc_revisions WHERE doc_id = $1 AND rev > $2 ORDER BY rev ASC',
      [docId, rev],
    );
    let healed = doc;
    let expected = rev;
    for (const r of missing.rows) {
      expected += 1;
      if (Number(r.rev) !== expected) {
        throw new Error(`revision log gap for ${docId}: expected rev ${expected}, found ${r.rev}`);
      }
      healed = applyPatches(healed, r.ops as Patch[]);
    }
    const valid = validateDocument(healed);
    await this.pool.query(
      `UPDATE documents SET doc = $1::jsonb, rev = $2, updated_at = now()
       WHERE id = $3 AND workspace_id = $4`,
      [JSON.stringify(valid), maxRev, docId, this.workspaceId],
    );
    console.warn(
      `[pitolet-cloud] healed document ${docId}: replayed revisions ${rev + 1}…${maxRev}`,
    );
    return { doc: valid, rev: maxRev };
  }

  /**
   * Persistence pipeline per applied patch — MUST NOT throw:
   *  (a) revision INSERT on the per-doc serialized queue,
   *  (b) debounced full-doc UPDATE (1s, 10s max-wait),
   *  (c) snapshot cadence check after the UPDATE.
   */
  handlePatch(patch: AppliedPatch, doc: PitoletDocument): void {
    try {
      let st = this.docs.get(patch.docId);
      if (!st) {
        st = this.freshState(doc, patch.rev - 1);
        this.docs.set(patch.docId, st);
      }
      st.latestDoc = doc;
      st.latestRev = patch.rev;
      st.revQueue = st.revQueue
        .then(() => this.insertRevision(patch))
        .catch((err) => {
          this.logError(`revision insert failed for ${patch.docId} rev ${patch.rev}`, err);
          st.forceWrite = true;
        });
      this.scheduleWrite(st);
    } catch (err) {
      this.logError('handlePatch failed', err);
    }
  }

  /**
   * Immediate write — doc creation / external replace. workspace_id is
   * stamped from the adapter, and the ON CONFLICT UPDATE is guarded on it:
   * a doc id owned by another workspace can never be overwritten (globally
   * unique nanoid ids mean a pk collision IS a cross-tenant write attempt).
   */
  async saveNow(doc: PitoletDocument, rev: number): Promise<void> {
    // An unknown doc id = document creation (loadAll seeded this.docs with
    // every live doc) → run the plan gate. Throws surface to the caller
    // (MCP create_document returns the message as a tool error).
    if (!this.docs.has(doc.id)) this.beforeDocCreate?.();
    const res = await this.pool.query(
      `INSERT INTO documents (id, workspace_id, name, doc, rev)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, doc = EXCLUDED.doc, rev = EXCLUDED.rev,
             updated_at = now(), deleted_at = NULL
         WHERE documents.workspace_id = EXCLUDED.workspace_id`,
      [doc.id, this.workspaceId, doc.name, JSON.stringify(doc), rev],
    );
    if (res.rowCount === 0) {
      throw new Error(
        `saveNow refused: document ${doc.id} belongs to another workspace (cross-tenant write blocked)`,
      );
    }
    const st = this.docs.get(doc.id);
    if (st) {
      st.latestDoc = doc;
      st.latestRev = rev;
    } else {
      this.docs.set(doc.id, this.freshState(doc, rev));
    }
  }

  /** Soft delete, scoped to this workspace. */
  async deleteDoc(docId: string): Promise<void> {
    const st = this.docs.get(docId);
    if (st) {
      await st.revQueue.catch(() => {});
      this.clearTimers(st);
      st.pendingWrite = false;
      this.docs.delete(docId);
    }
    await this.pool.query(
      'UPDATE documents SET deleted_at = now(), updated_at = now() WHERE id = $1 AND workspace_id = $2',
      [docId, this.workspaceId],
    );
  }

  /** Drain every pending revision INSERT and debounced doc UPDATE. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.docs.values()].map(async (st) => {
        await st.revQueue; // never rejects (catch attached at chain time)
        if (st.pendingWrite) await this.fireWrite(st);
        else await st.writeChain;
      }),
    );
  }

  /** Flush; the pool is owned by the app and is NOT closed here. */
  async close(): Promise<void> {
    await this.flush();
    for (const st of this.docs.values()) this.clearTimers(st);
  }

  // --- internals ---

  private freshState(doc: PitoletDocument, rev: number): DocState {
    return {
      latestDoc: doc,
      latestRev: rev,
      revQueue: Promise.resolve(),
      writeChain: Promise.resolve(),
      pendingWrite: false,
      forceWrite: false,
      debounceTimer: null,
      maxWaitTimer: null,
      lastSnapshotRev: rev,
      lastSnapshotAt: Date.now(),
    };
  }

  /**
   * Revision INSERT is guarded through the documents table: the row only
   * lands if the doc exists AND belongs to this adapter's workspace.
   */
  private async insertRevision(patch: AppliedPatch): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO doc_revisions (doc_id, rev, origin, label, actor_id, actor_name, ops)
       SELECT d.id, $2, $3, $4, $5, $6, $7::jsonb
       FROM documents d
       WHERE d.id = $1 AND d.workspace_id = $8`,
      [
        patch.docId,
        patch.rev,
        patch.origin,
        patch.label,
        patch.actor?.id ?? null,
        patch.actor?.name ?? null,
        JSON.stringify(patch.ops),
        this.workspaceId,
      ],
    );
    if (res.rowCount === 0) {
      throw new Error(`document ${patch.docId} not found in workspace ${this.workspaceId}`);
    }
  }

  private scheduleWrite(st: DocState): void {
    st.pendingWrite = true;
    if (st.forceWrite) {
      void this.fireWrite(st);
      return;
    }
    if (st.debounceTimer) clearTimeout(st.debounceTimer);
    st.debounceTimer = setTimeout(() => void this.fireWrite(st), this.opts.debounceMs);
    if (!st.maxWaitTimer) {
      st.maxWaitTimer = setTimeout(() => void this.fireWrite(st), this.opts.maxWaitMs);
    }
  }

  private fireWrite(st: DocState): Promise<void> {
    this.clearTimers(st);
    if (!st.pendingWrite) return st.writeChain;
    st.pendingWrite = false;
    st.forceWrite = false;
    const doc = st.latestDoc;
    const rev = st.latestRev;
    st.writeChain = st.writeChain
      .then(() => this.writeDoc(st, doc, rev))
      .catch((err) => this.logError(`doc update failed for ${doc.id} rev ${rev}`, err));
    return st.writeChain;
  }

  private async writeDoc(st: DocState, doc: PitoletDocument, rev: number): Promise<void> {
    const res = await this.pool.query(
      `UPDATE documents SET doc = $1::jsonb, rev = $2, name = $3, updated_at = now()
       WHERE id = $4 AND workspace_id = $5`,
      [JSON.stringify(doc), rev, doc.name, doc.id, this.workspaceId],
    );
    if (res.rowCount === 0) {
      throw new Error(`document ${doc.id} not found in workspace ${this.workspaceId}`);
    }
    const now = Date.now();
    const snapshotDue =
      rev - st.lastSnapshotRev >= this.opts.snapshotEveryRevs ||
      (now - st.lastSnapshotAt >= this.opts.snapshotEveryMs && rev > st.lastSnapshotRev);
    if (snapshotDue) {
      await this.pool.query(
        `INSERT INTO doc_snapshots (doc_id, rev, doc, kind)
         SELECT d.id, $2, $3::jsonb, 'auto'
         FROM documents d
         WHERE d.id = $1 AND d.workspace_id = $4`,
        [doc.id, rev, JSON.stringify(doc), this.workspaceId],
      );
      st.lastSnapshotRev = rev;
      st.lastSnapshotAt = now;
      // History retention rides the snapshot cadence (no separate timer):
      // prune AUTO snapshots past the plan window; named & pre-restore
      // snapshots are kept forever.
      const days = this.quota?.historyDays();
      if (days !== undefined && Number.isFinite(days)) {
        await this.pool.query(
          `DELETE FROM doc_snapshots
           WHERE doc_id = $1 AND kind = 'auto'
             AND created_at < now() - make_interval(days => $2)`,
          [doc.id, Math.floor(days)],
        );
      }
    }
  }

  private clearTimers(st: DocState): void {
    if (st.debounceTimer) {
      clearTimeout(st.debounceTimer);
      st.debounceTimer = null;
    }
    if (st.maxWaitTimer) {
      clearTimeout(st.maxWaitTimer);
      st.maxWaitTimer = null;
    }
  }
}
