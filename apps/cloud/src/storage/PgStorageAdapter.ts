import { migrateDocument, validateDocument, type PitoletDocument } from '@pitolet/schema';
import { applyPatches, enablePatches, type Patch } from 'immer';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  ASSET_EXT_BY_MIME,
  FileStorageAdapter,
  type AssetStorage,
  type LoadedDoc,
  type StorageAdapter,
} from 'pitolet';
import type { AppliedPatch } from 'pitolet';
import { docCreateDenial, planOf, PlanLimitError } from '../cloud/plans.js';

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
  /** Orphans younger than this are never collected (default 1 hour). */
  assetGcGraceMs?: number;
  /** Online orphan-collection cadence (default 6 hours; 0 disables). */
  assetGcIntervalMs?: number;
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
  /** Latest revision known to be present in the full documents row. */
  durableDocRev: number;
  /** Last persistence failure, cleared only once latestRev is durable. */
  persistenceError: Error | null;
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
  private readonly fileAssets: AssetStorage;
  private assetGcTimer: NodeJS.Timeout | null = null;
  private assetGcPromise: Promise<{ removed: number; reclaimedBytes: number }> | null = null;

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
      assetGcGraceMs: options.assetGcGraceMs ?? 60 * 60_000,
      assetGcIntervalMs: options.assetGcIntervalMs ?? 6 * 60 * 60_000,
    };
    this.quota = options.quota ?? null;
    this.logError =
      options.logError ??
      ((message, err) => console.error(`[pitolet-cloud] ${message}`, err ?? ''));
    // Reuse the OSS content-addressed file asset storage (full SHA-256 ids,
    // traversal-proof) rooted per workspace. FileAssetStorage itself isn't
    // exported, but FileStorageAdapter exposes it; we only borrow `.assets`
    // (the constructor just mkdirs — no watcher, no timers).
    this.fileAssets = new FileStorageAdapter(join(dataRoot, 'workspaces', workspaceId)).assets;
    this.assets = this.quota
      ? this.quotaCheckedAssets(this.fileAssets, this.quota)
      : this.fileAssets;
  }

  /**
   * Byte-quota wrapper around asset storage. The running total lives in
   * workspaces.asset_bytes and workspace_assets. The candidate id is derived
   * before writing, then a workspace row lock serializes quota checking,
   * content storage and unique accounting. Quota rejection therefore leaves
   * no file behind; a later database failure is repaired by orphan GC.
   */
  private quotaCheckedAssets(inner: AssetStorage, quota: PgStorageQuota): AssetStorage {
    return {
      get: (assetId) => inner.get(assetId),
      put: async (data, mime) => {
        const extension = ASSET_EXT_BY_MIME[mime];
        if (!extension) throw new Error(`unsupported asset type ${mime}`);
        const candidateId = `${createHash('sha256').update(data).digest('hex')}.${extension}`;
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const workspace = await client.query(
            'SELECT asset_bytes FROM workspaces WHERE id = $1 FOR UPDATE',
            [this.workspaceId],
          );
          const prior = await client.query(
            `SELECT 1 FROM workspace_assets
             WHERE workspace_id = $1 AND asset_id = $2`,
            [this.workspaceId, candidateId],
          );
          if (prior.rowCount === 0) {
            const limit = quota.maxAssetBytes();
            const used = Number(workspace.rows[0]?.asset_bytes ?? 0);
            if (Number.isFinite(limit) && used + data.length > limit) {
              throw new PlanLimitError(quota.assetLimitMessage());
            }
          }
          const result = await inner.put(data, mime);
          if (result.assetId !== candidateId) {
            throw new Error('asset storage returned a non-deterministic content id');
          }
          if (prior.rowCount === 0) {
            await client.query(
              `INSERT INTO workspace_assets (workspace_id, asset_id, size_bytes)
               VALUES ($1, $2, $3)`,
              [this.workspaceId, result.assetId, data.length],
            );
            await client.query(
              `UPDATE workspaces
               SET asset_bytes = asset_bytes + $2
               WHERE id = $1`,
              [this.workspaceId, data.length],
            );
          }
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
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
      let doc: PitoletDocument;
      try {
        doc = migrateDocument(row.doc);
      } catch (err) {
        // One corrupt row must not make every document in the workspace
        // unavailable. Keep the bytes untouched for operator recovery and
        // omit only the invalid document from the live runtime.
        this.logError(`document ${row.id} is invalid and was quarantined from the runtime`, err);
        continue;
      }
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
    await this.collectOrphanedAssets().catch((error) => {
      this.logError(`asset cleanup failed for workspace ${this.workspaceId}`, error);
      return { removed: 0, reclaimedBytes: 0 };
    });
    this.startAssetGc();
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
          st.persistenceError = asError(err);
          st.forceWrite = true;
          st.pendingWrite = true;
          // The journal append is the normal immediate durability path. If it
          // fails, persist the complete latest document now rather than
          // waiting for the debounce window.
          void this.fireWrite(st);
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
    const isUnknown = !this.docs.has(doc.id);
    if (isUnknown) this.beforeDocCreate?.();
    const client = await this.pool.connect();
    let res;
    try {
      await client.query('BEGIN');
      if (isUnknown) {
        const workspace = await client.query(
          'SELECT plan FROM workspaces WHERE id = $1 FOR UPDATE',
          [this.workspaceId],
        );
        const existing = await client.query(
          `SELECT workspace_id, deleted_at FROM documents
           WHERE id = $1 FOR UPDATE`,
          [doc.id],
        );
        const existingRow = existing.rows[0] as
          { workspace_id: string; deleted_at: Date | null } | undefined;
        if (existingRow && existingRow.workspace_id !== this.workspaceId) {
          throw new Error(
            `saveNow refused: document ${doc.id} belongs to another workspace (cross-tenant write blocked)`,
          );
        }
        if (!existingRow || existingRow.deleted_at !== null) {
          const count = await client.query(
            `SELECT count(*)::int AS n FROM documents
             WHERE workspace_id = $1 AND deleted_at IS NULL`,
            [this.workspaceId],
          );
          const denial = docCreateDenial(
            planOf(workspace.rows[0]?.plan),
            Number(count.rows[0]?.n ?? 0),
          );
          if (denial) throw new PlanLimitError(denial);
        }
      }
      res = await client.query(
        `INSERT INTO documents (id, workspace_id, name, doc, rev)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, doc = EXCLUDED.doc, rev = EXCLUDED.rev,
               updated_at = now(), deleted_at = NULL
           WHERE documents.workspace_id = EXCLUDED.workspace_id`,
        [doc.id, this.workspaceId, doc.name, JSON.stringify(doc), rev],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (res.rowCount === 0) {
      throw new Error(
        `saveNow refused: document ${doc.id} belongs to another workspace (cross-tenant write blocked)`,
      );
    }
    const st = this.docs.get(doc.id);
    if (st) {
      st.latestDoc = doc;
      st.latestRev = rev;
      st.durableDocRev = rev;
      st.persistenceError = null;
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
    // The grace period keeps a just-deleted document recoverable while the
    // periodic collector eventually releases its unreferenced assets.
    void this.collectOrphanedAssets().catch((error) =>
      this.logError(`asset cleanup failed for workspace ${this.workspaceId}`, error),
    );
  }

  /**
   * Remove old content-addressed files that no live document declares and
   * reconcile workspace_assets / workspaces.asset_bytes.
   */
  collectOrphanedAssets(): Promise<{ removed: number; reclaimedBytes: number }> {
    if (this.assetGcPromise) return this.assetGcPromise;
    const operation = this.runAssetGc().finally(() => {
      if (this.assetGcPromise === operation) this.assetGcPromise = null;
    });
    this.assetGcPromise = operation;
    return operation;
  }

  /** Drain every pending revision INSERT and debounced doc UPDATE. */
  async flush(): Promise<void> {
    const failures: Error[] = [];
    await Promise.all(
      [...this.docs.values()].map(async (st) => {
        await st.revQueue; // never rejects (catch attached at chain time)
        if (st.pendingWrite) await this.fireWrite(st);
        else await st.writeChain;
        // A failed timer write remains latched and pending. Give shutdown one
        // final synchronous retry, then fail loudly if the latest acknowledged
        // revision still is not present in the documents row.
        if (st.durableDocRev < st.latestRev) {
          st.pendingWrite = true;
          await this.fireWrite(st);
        }
        if (st.durableDocRev < st.latestRev) {
          failures.push(
            st.persistenceError ??
              new Error(`document ${st.latestDoc.id} rev ${st.latestRev} was not durably stored`),
          );
        }
      }),
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to durably store ${failures.length} document(s)`);
    }
  }

  /** Flush; the pool is owned by the app and is NOT closed here. */
  async close(): Promise<void> {
    if (this.assetGcTimer) clearInterval(this.assetGcTimer);
    this.assetGcTimer = null;
    await this.assetGcPromise?.catch((error) =>
      this.logError(`asset cleanup failed during close for workspace ${this.workspaceId}`, error),
    );
    try {
      await this.flush();
    } finally {
      for (const st of this.docs.values()) this.clearTimers(st);
    }
  }

  // --- internals ---

  private startAssetGc(): void {
    if (this.assetGcTimer || this.opts.assetGcIntervalMs <= 0) return;
    this.assetGcTimer = setInterval(() => {
      void this.collectOrphanedAssets().catch((error) =>
        this.logError(`asset cleanup failed for workspace ${this.workspaceId}`, error),
      );
    }, this.opts.assetGcIntervalMs);
    this.assetGcTimer.unref?.();
  }

  private async runAssetGc(): Promise<{ removed: number; reclaimedBytes: number }> {
    if (!this.fileAssets.list || !this.fileAssets.remove) {
      return { removed: 0, reclaimedBytes: 0 };
    }
    const cutoff = Date.now() - this.opts.assetGcGraceMs;
    const client = await this.pool.connect();
    let removed = 0;
    let reclaimedBytes = 0;
    try {
      await client.query('BEGIN');
      const workspace = await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
        this.workspaceId,
      ]);
      if (workspace.rowCount === 0) {
        await client.query('ROLLBACK');
        return { removed: 0, reclaimedBytes: 0 };
      }
      // Existing-document writes lock these rows. Taking the same locks after
      // the workspace lock prevents a reference from appearing during a scan.
      await client.query(
        `SELECT id FROM documents
         WHERE workspace_id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [this.workspaceId],
      );
      const references = await client.query<{ asset_id: string }>(
        `SELECT DISTINCT asset.asset_id
         FROM documents d
         CROSS JOIN LATERAL jsonb_object_keys(
           CASE
             WHEN jsonb_typeof(d.doc->'assets') = 'object' THEN d.doc->'assets'
             ELSE '{}'::jsonb
           END
         ) AS asset(asset_id)
         WHERE d.workspace_id = $1 AND d.deleted_at IS NULL`,
        [this.workspaceId],
      );
      const referenced = new Set(references.rows.map((row) => row.asset_id));
      const accounted = await client.query<{
        asset_id: string;
        size_bytes: string | number;
        created_at: Date | string;
      }>(
        `SELECT asset_id, size_bytes, created_at
         FROM workspace_assets
         WHERE workspace_id = $1`,
        [this.workspaceId],
      );
      const files = await this.fileAssets.list();
      const fileById = new Map(files.map((file) => [file.assetId, file]));
      const accountedIds = new Set(accounted.rows.map((row) => row.asset_id));

      for (const row of accounted.rows) {
        if (referenced.has(row.asset_id)) continue;
        if (new Date(row.created_at).getTime() > cutoff) continue;
        const file = fileById.get(row.asset_id);
        if (file) {
          const didRemove = await this.fileAssets.remove(row.asset_id);
          if (!didRemove) {
            const stillPresent = await this.fileAssets.get(row.asset_id);
            if (stillPresent) {
              stillPresent.stream.destroy();
              continue;
            }
          }
        }
        const deletion = await client.query(
          `DELETE FROM workspace_assets
           WHERE workspace_id = $1 AND asset_id = $2`,
          [this.workspaceId, row.asset_id],
        );
        if (deletion.rowCount === 0) continue;
        removed += 1;
        reclaimedBytes += Number(row.size_bytes);
      }

      // Files left by a failed upload transaction have no accounting row.
      for (const file of files) {
        if (
          accountedIds.has(file.assetId) ||
          referenced.has(file.assetId) ||
          file.modifiedAt > cutoff
        ) {
          continue;
        }
        if (await this.fileAssets.remove(file.assetId)) removed += 1;
      }

      if (reclaimedBytes > 0) {
        await client.query(
          `UPDATE workspaces
           SET asset_bytes = greatest(0, asset_bytes - $2)
           WHERE id = $1`,
          [this.workspaceId, reclaimedBytes],
        );
      }
      await client.query('COMMIT');
      return { removed, reclaimedBytes };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private freshState(doc: PitoletDocument, rev: number): DocState {
    return {
      latestDoc: doc,
      latestRev: rev,
      durableDocRev: rev,
      persistenceError: null,
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
      .catch((err) => {
        const failure = asError(err);
        st.persistenceError = failure;
        st.pendingWrite = true;
        this.logError(`doc update failed for ${doc.id} rev ${rev}`, failure);
        // A transient database failure should self-heal while the process is
        // still running. The latch remains set and flush/close still fail if
        // retries cannot reach latestRev.
        if (!st.debounceTimer) {
          st.debounceTimer = setTimeout(
            () => void this.fireWrite(st),
            Math.max(250, this.opts.debounceMs),
          );
          st.debounceTimer.unref?.();
        }
      });
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
    st.durableDocRev = Math.max(st.durableDocRev, rev);
    if (st.durableDocRev >= st.latestRev) st.persistenceError = null;
    const now = Date.now();
    const snapshotDue =
      rev - st.lastSnapshotRev >= this.opts.snapshotEveryRevs ||
      (now - st.lastSnapshotAt >= this.opts.snapshotEveryMs && rev > st.lastSnapshotRev);
    if (snapshotDue) {
      try {
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
      } catch (error) {
        // Snapshot history is secondary to the full document row. Do not
        // report an acknowledged edit as lost after that row is durable.
        this.logError(`snapshot write failed for ${doc.id} rev ${rev}`, error);
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
