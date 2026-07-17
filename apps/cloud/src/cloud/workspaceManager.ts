import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import type { Pool } from 'pg';
import { createRuntime, type PitoletRuntime } from 'pitolet';
import { PgStorageAdapter, type PgStorageAdapterOptions } from '../storage/PgStorageAdapter.js';
import { makeWorkspaceAuthHooks } from './authHooks.js';
import { assetLimitMessage, docCreateDenial, PLAN_LIMITS, planOf, type Plan } from './plans.js';

/**
 * Lazy per-workspace runtime cache. Each workspace gets its own
 * DocumentStore + WsHub + PgStorageAdapter (workspace-scoped SQL) — tenant
 * isolation is structural: there is no shared store to leak through.
 *
 * Lifecycle: created on first request, touched per request, evicted by a
 * sweep when idle (no WS clients + no HTTP traffic for idleMs) or when the
 * LRU hard cap is exceeded. Eviction: flush → re-check activity → close.
 */

export interface WorkspaceManagerOptions {
  /** Evict after this much inactivity (default 15 min). */
  idleMs?: number;
  /** Sweep cadence (default 1 min). */
  sweepMs?: number;
  /** Hard cap on loaded runtimes (default 100) — oldest idle evicted over cap. */
  maxLoaded?: number;
  logError?: (message: string, err?: unknown) => void;
  /** Injectable clock for plan-gate rate buckets (tests). */
  clock?: () => number;
  /**
   * PgStorageAdapter tuning passthrough — write debounce and snapshot
   * cadence. Production uses the adapter defaults; tests inject fast values
   * to force auto-snapshots deterministically.
   */
  storage?: Pick<
    PgStorageAdapterOptions,
    | 'debounceMs'
    | 'maxWaitMs'
    | 'snapshotEveryRevs'
    | 'snapshotEveryMs'
    | 'assetGcGraceMs'
    | 'assetGcIntervalMs'
  >;
}

interface Entry {
  runtime: PitoletRuntime;
  adapter: PgStorageAdapter;
  lastTouched: number;
  /** Monotonic generation — bumped on touch; an eviction aborts if it moved. */
  gen: number;
  /**
   * Live plan for this runtime's closures (auth hooks, quotas). Mutated in
   * place by onPlanChanged so a Paddle webhook applies WITHOUT a reload;
   * fresh loads read workspaces.plan from the database.
   */
  planRef: { plan: Plan };
}

export class WorkspaceManager {
  private readonly loaded = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry>>();
  private readonly idleMs: number;
  private readonly maxLoaded: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly clock?: () => number;
  private readonly storageOptions: WorkspaceManagerOptions['storage'];
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly dataRoot: string,
    options: WorkspaceManagerOptions = {},
  ) {
    this.idleMs = options.idleMs ?? 15 * 60_000;
    this.maxLoaded = options.maxLoaded ?? 100;
    this.clock = options.clock;
    this.storageOptions = options.storage;
    this.logError =
      options.logError ??
      ((message, err) => console.error(`[pitolet-cloud] ${message}`, err ?? ''));
    this.sweepTimer = setInterval(
      () => void this.sweep().catch((err) => this.logError('workspace sweep failed', err)),
      options.sweepMs ?? 60_000,
    );
    this.sweepTimer.unref?.();
  }

  /** Get (or lazily create) the runtime for a workspace, marking it used. */
  async getRuntime(workspaceId: string): Promise<PitoletRuntime> {
    if (this.stopped) throw new Error('workspace manager is shut down');
    const existing = this.loaded.get(workspaceId);
    if (existing) {
      this.touch(existing);
      return existing.runtime;
    }
    // In-flight dedup: concurrent first requests share one load.
    let pending = this.loading.get(workspaceId);
    if (!pending) {
      pending = this.load(workspaceId).finally(() => this.loading.delete(workspaceId));
      this.loading.set(workspaceId, pending);
    }
    const entry = await pending;
    this.touch(entry);
    return entry.runtime;
  }

  loadedCount(): number {
    return this.loaded.size;
  }

  /** Readiness includes the writable content-addressed asset root. */
  async assertStorageReady(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    await access(this.dataRoot, fsConstants.R_OK | fsConstants.W_OK);
  }

  /**
   * Sum of live WS clients across every loaded runtime (read-only, for the
   * ops metrics snapshot). Not touched — inspecting must not keep a runtime
   * from being evicted.
   */
  totalClientCount(): number {
    let total = 0;
    for (const entry of this.loaded.values()) {
      total += entry.runtime.hub.clientCount();
    }
    return total;
  }

  /**
   * Plan change (Paddle webhook / reconcile): update the LIVE closure of a
   * loaded (or currently loading) runtime in place. Unloaded workspaces need
   * nothing — load() reads workspaces.plan, which the caller already
   * committed before invoking this.
   */
  onPlanChanged(workspaceId: string, plan: Plan): void {
    const entry = this.loaded.get(workspaceId);
    if (entry) entry.planRef.plan = plan;
    // A load racing the webhook may have read the pre-commit plan — correct
    // it when it settles.
    void this.loading
      .get(workspaceId)
      ?.then((e) => {
        e.planRef.plan = plan;
      })
      .catch(() => {});
  }

  /** Flush + close every runtime (SIGTERM path). */
  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    // Let racing loads settle so their adapters get closed too.
    await Promise.allSettled([...this.loading.values()]);
    const entries = [...this.loaded.entries()];
    const failures: Error[] = [];

    // Stop every ingress path before flushing acknowledged writes. Otherwise
    // a socket can race a final patch into an adapter that is already closing,
    // and active WebSockets can keep http.Server.close() pending forever.
    for (const [id, entry] of entries) {
      try {
        entry.runtime.hub.close();
      } catch (error) {
        const failure = asError(error);
        failures.push(failure);
        this.logError(`WebSocket shutdown failed for workspace ${id}`, failure);
      }
    }
    this.loaded.clear();

    const results = await Promise.allSettled(entries.map(([, entry]) => entry.adapter.close()));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const id = entries[index]![0];
      const failure = asError(result.reason);
      failures.push(failure);
      this.logError(`shutdown flush failed for workspace ${id}`, failure);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `failed to close ${failures.length} workspace runtime operation(s)`,
      );
    }
  }

  private touch(entry: Entry): void {
    entry.lastTouched = Date.now();
    entry.gen += 1;
  }

  private async load(workspaceId: string): Promise<Entry> {
    // Plan snapshot at load; kept live afterwards via onPlanChanged.
    const res = await this.pool.query('SELECT plan FROM workspaces WHERE id = $1', [workspaceId]);
    const planRef = { plan: planOf(res.rows[0]?.plan) };
    const limits = () => PLAN_LIMITS[planRef.plan];

    const adapter = new PgStorageAdapter(this.pool, workspaceId, this.dataRoot, {
      ...this.storageOptions,
      quota: {
        maxAssetBytes: () => limits().assetBytesPerWorkspace,
        assetLimitMessage: () => assetLimitMessage(planRef.plan),
        historyDays: () => limits().historyDays,
      },
    });
    // getDocCount is rebound below once the runtime (and its store) exists;
    // authorize can't run before then — createRuntime wires dispatch last.
    let getDocCount = () => 0;
    const runtime = await createRuntime({
      storage: adapter,
      auth: makeWorkspaceAuthHooks(workspaceId, {
        getPlan: () => planRef.plan,
        getDocCount: () => getDocCount(),
        clock: this.clock,
      }),
    });
    getDocCount = () => runtime.store.list().length;
    // The OSS create_document tool persists via adapter.saveNow without
    // consulting the authorize hook — the adapter is the real chokepoint.
    adapter.beforeDocCreate = () => {
      const denial = docCreateDenial(planRef.plan, getDocCount());
      if (denial) throw new Error(denial);
    };
    const entry: Entry = { runtime, adapter, lastTouched: Date.now(), gen: 0, planRef };
    this.loaded.set(workspaceId, entry);
    return entry;
  }

  private idleCandidates(now: number): [string, Entry][] {
    return [...this.loaded.entries()]
      .filter(([, e]) => e.runtime.hub.clientCount() === 0 && now - e.lastTouched > this.idleMs)
      .sort(([, a], [, b]) => a.lastTouched - b.lastTouched);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.idleCandidates(now)) {
      await this.evict(id, entry);
    }
    // LRU hard cap: evict oldest CONNECTION-FREE runtimes over the cap even
    // if not yet idle-expired. Runtimes with live WS clients are never
    // evicted — a busy fleet can exceed the cap rather than cut sessions.
    if (this.loaded.size > this.maxLoaded) {
      const spare = [...this.loaded.entries()]
        .filter(([, e]) => e.runtime.hub.clientCount() === 0)
        .sort(([, a], [, b]) => a.lastTouched - b.lastTouched);
      for (const [id, entry] of spare.slice(0, this.loaded.size - this.maxLoaded)) {
        await this.evict(id, entry);
      }
    }
  }

  /** Flush, then re-check nothing raced in; only then drop the runtime. */
  private async evict(id: string, entry: Entry): Promise<void> {
    const genAtStart = entry.gen;
    try {
      await entry.adapter.flush();
    } catch (err) {
      this.logError(`flush before eviction failed for workspace ${id} — keeping it loaded`, err);
      return;
    }
    // Activity during the flush (new request touched it, or a WS client
    // connected) cancels the eviction — the entry stays.
    if (entry.gen !== genAtStart || entry.runtime.hub.clientCount() > 0) return;
    if (this.loaded.get(id) !== entry) return;
    // No await between the final activity check and closing the hub: a new
    // request cannot touch this runtime in the middle. Closing ingress before
    // adapter.close() also makes the final flush race-free.
    try {
      entry.runtime.hub.close();
    } catch (err) {
      this.logError(`WebSocket close failed for workspace ${id} — keeping it loaded`, err);
      return;
    }
    this.loaded.delete(id);
    try {
      await entry.adapter.close();
    } catch (err) {
      this.logError(`adapter close failed for workspace ${id}`, err);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
