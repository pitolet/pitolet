import { createSampleDocument, type PitoletDocument } from '@pitolet/schema';
import { enablePatches, produceWithPatches } from 'immer';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppliedPatch } from 'pitolet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { PgStorageAdapter } from '../src/storage/PgStorageAdapter.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

enablePatches();

let pgi: EphemeralPg;
let dataRoot: string;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-data-'));
  pgi = await startEphemeralPg();
  await runMigrations(pgi.pool);
}, 120_000);

afterAll(async () => {
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function createWorkspace(slug: string): Promise<string> {
  const res = await pgi.pool.query(
    'INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return res.rows[0].id as string;
}

/** Build `count` sequential rename patches starting after `startRev`. */
function makePatches(
  doc: PitoletDocument,
  count: number,
  startRev = 0,
): { steps: { patch: AppliedPatch; doc: PitoletDocument }[]; final: PitoletDocument } {
  let current = doc;
  const steps: { patch: AppliedPatch; doc: PitoletDocument }[] = [];
  for (let i = 1; i <= count; i++) {
    const rev = startRev + i;
    const [next, ops] = produceWithPatches(current, (d) => {
      d.name = `${doc.name} v${rev}`;
    });
    steps.push({
      patch: {
        docId: doc.id,
        rev,
        origin: 'editor:test',
        label: `Rename ${rev}`,
        ops: ops as AppliedPatch['ops'],
        actor: { id: 'user-1', name: 'Test User' },
      },
      doc: next,
    });
    current = next;
  }
  return { steps, final: current };
}

async function poll(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('poll timed out');
}

describe('migrations', () => {
  it('apply idempotently (second run is a no-op)', async () => {
    const secondRun = await runMigrations(pgi.pool);
    expect(secondRun).toEqual([]);
    const applied = await pgi.pool.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(applied.rows.map((r) => r.name)).toEqual([
      '001_init.sql',
      '002_better_auth_users.sql',
      '003_billing_limits.sql',
    ]);
  });
});

describe('PgStorageAdapter', () => {
  it('saveNow + loadAll round-trips a real document', async () => {
    const ws = await createWorkspace('roundtrip');
    const adapter = new PgStorageAdapter(pgi.pool, ws, dataRoot);
    const doc = createSampleDocument();
    await adapter.saveNow(doc, 0);
    await adapter.close();

    const fresh = new PgStorageAdapter(pgi.pool, ws, dataRoot);
    const loaded = await fresh.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.rev).toBe(0);
    expect(loaded[0]!.doc).toEqual(doc);
    await fresh.close();
  });

  it('handlePatch lands a revision row and a durable doc UPDATE after flush', async () => {
    const ws = await createWorkspace('patch-basic');
    const adapter = new PgStorageAdapter(pgi.pool, ws, dataRoot);
    const doc = createSampleDocument();
    await adapter.saveNow(doc, 0);

    const { steps } = makePatches(doc, 1);
    adapter.handlePatch(steps[0]!.patch, steps[0]!.doc);

    // The revision append is immediate (not debounced).
    await poll(async () => {
      const r = await pgi.pool.query('SELECT count(*)::int AS n FROM doc_revisions WHERE doc_id = $1', [doc.id]);
      return r.rows[0].n === 1;
    });
    const rev = await pgi.pool.query(
      'SELECT rev, origin, label, actor_id, actor_name, ops FROM doc_revisions WHERE doc_id = $1',
      [doc.id],
    );
    expect(rev.rows[0]).toMatchObject({
      rev: 1,
      origin: 'editor:test',
      label: 'Rename 1',
      actor_id: 'user-1',
      actor_name: 'Test User',
    });
    expect(rev.rows[0].ops).toEqual(steps[0]!.patch.ops);

    await adapter.flush();
    const row = await pgi.pool.query('SELECT rev, doc FROM documents WHERE id = $1', [doc.id]);
    expect(row.rows[0].rev).toBe(1);
    expect(row.rows[0].doc.name).toBe(steps[0]!.doc.name);
    await adapter.close();

    // Durable across a fresh adapter.
    const fresh = new PgStorageAdapter(pgi.pool, ws, dataRoot);
    const loaded = await fresh.loadAll();
    expect(loaded[0]!.rev).toBe(1);
    expect(loaded[0]!.doc.name).toBe(steps[0]!.doc.name);
    await fresh.close();
  });

  it('a patch storm settles to a consistent doc with a full monotonic revision log', async () => {
    const ws = await createWorkspace('storm');
    const adapter = new PgStorageAdapter(pgi.pool, ws, dataRoot, { debounceMs: 50, maxWaitMs: 500 });
    const doc = createSampleDocument();
    await adapter.saveNow(doc, 0);

    const { steps, final } = makePatches(doc, 15);
    for (const step of steps) adapter.handlePatch(step.patch, step.doc);
    await adapter.flush();

    const revs = await pgi.pool.query(
      'SELECT rev FROM doc_revisions WHERE doc_id = $1 ORDER BY id ASC',
      [doc.id],
    );
    expect(revs.rows.map((r) => r.rev)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

    const row = await pgi.pool.query('SELECT rev, doc FROM documents WHERE id = $1', [doc.id]);
    expect(row.rows[0].rev).toBe(15);
    expect(row.rows[0].doc).toEqual(JSON.parse(JSON.stringify(final)));
    await adapter.close();
  });

  it('heals from the revision log after a crash before the doc UPDATE', async () => {
    const ws = await createWorkspace('crash');
    // Huge debounce: the doc UPDATE never fires — only revision appends land,
    // exactly the state a crash between append and UPDATE leaves behind.
    const crashed = new PgStorageAdapter(pgi.pool, ws, dataRoot, {
      debounceMs: 60_000,
      maxWaitMs: 600_000,
    });
    const doc = createSampleDocument();
    await crashed.saveNow(doc, 0);

    const { steps, final } = makePatches(doc, 3);
    for (const step of steps) crashed.handlePatch(step.patch, step.doc);
    await poll(async () => {
      const r = await pgi.pool.query('SELECT count(*)::int AS n FROM doc_revisions WHERE doc_id = $1', [doc.id]);
      return r.rows[0].n === 3;
    });
    // Deliberately NO flush — the stored doc row is stale at rev 0.
    const stale = await pgi.pool.query('SELECT rev FROM documents WHERE id = $1', [doc.id]);
    expect(stale.rows[0].rev).toBe(0);

    const recovered = new PgStorageAdapter(pgi.pool, ws, dataRoot);
    const loaded = await recovered.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.rev).toBe(3);
    expect(loaded[0]!.doc.name).toBe(final.name);

    // The heal also repaired the documents table.
    const healed = await pgi.pool.query('SELECT rev, doc FROM documents WHERE id = $1', [doc.id]);
    expect(healed.rows[0].rev).toBe(3);
    expect(healed.rows[0].doc.name).toBe(final.name);

    await recovered.close();
    await crashed.close(); // rewrites the same healed state; harmless
  });

  it('scopes every read and write to the adapter workspace', async () => {
    const wsA = await createWorkspace('tenant-a');
    const wsB = await createWorkspace('tenant-b');
    const errors: string[] = [];
    const adapterA = new PgStorageAdapter(pgi.pool, wsA, dataRoot, {
      logError: (m) => errors.push(m),
    });
    const adapterB = new PgStorageAdapter(pgi.pool, wsB, dataRoot);

    const docA = createSampleDocument();
    const docB = createSampleDocument();
    await adapterA.saveNow(docA, 0);
    await adapterB.saveNow(docB, 0);

    // Each tenant sees only its own documents.
    const seenA = await adapterA.loadAll();
    const seenB = await adapterB.loadAll();
    expect(seenA.map((d) => d.doc.id)).toEqual([docA.id]);
    expect(seenB.map((d) => d.doc.id)).toEqual([docB.id]);

    // Cross-tenant saveNow (doc id owned by workspace B) is rejected …
    const evil = { ...docB, name: 'pwned by A' };
    await expect(adapterA.saveNow(evil, 99)).rejects.toThrow(/another workspace/);

    // … and cross-tenant handlePatch drops the revision without throwing.
    const { steps } = makePatches(docB, 1);
    adapterA.handlePatch(steps[0]!.patch, steps[0]!.doc);
    await adapterA.flush();
    const revCount = await pgi.pool.query(
      'SELECT count(*)::int AS n FROM doc_revisions WHERE doc_id = $1',
      [docB.id],
    );
    expect(revCount.rows[0].n).toBe(0);
    expect(errors.some((m) => m.includes('revision insert failed'))).toBe(true);

    // B's document is untouched.
    const rowB = await pgi.pool.query(
      'SELECT workspace_id, name, rev, doc FROM documents WHERE id = $1',
      [docB.id],
    );
    expect(rowB.rows[0].workspace_id).toBe(wsB);
    expect(rowB.rows[0].name).toBe(docB.name);
    expect(rowB.rows[0].rev).toBe(0);
    expect(rowB.rows[0].doc.name).toBe(docB.name);

    await adapterA.close();
    await adapterB.close();
  });

  it('soft-deletes documents within the workspace', async () => {
    const ws = await createWorkspace('delete');
    const adapter = new PgStorageAdapter(pgi.pool, ws, dataRoot);
    const doc = createSampleDocument();
    await adapter.saveNow(doc, 0);
    await adapter.deleteDoc(doc.id);

    expect(await adapter.loadAll()).toEqual([]);
    const row = await pgi.pool.query('SELECT deleted_at FROM documents WHERE id = $1', [doc.id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    await adapter.close();
  });

  it('writes an auto snapshot after 200+ revisions', async () => {
    const ws = await createWorkspace('snapshots');
    const adapter = new PgStorageAdapter(pgi.pool, ws, dataRoot, { debounceMs: 50, maxWaitMs: 500 });
    const doc = createSampleDocument();
    await adapter.saveNow(doc, 0);

    const { steps } = makePatches(doc, 205);
    for (const step of steps) adapter.handlePatch(step.patch, step.doc);
    await adapter.flush();

    const snaps = await pgi.pool.query(
      'SELECT rev, kind FROM doc_snapshots WHERE doc_id = $1 ORDER BY created_at DESC',
      [doc.id],
    );
    expect(snaps.rows.length).toBeGreaterThanOrEqual(1);
    expect(snaps.rows[0].kind).toBe('auto');
    expect(Number(snaps.rows[0].rev)).toBeGreaterThanOrEqual(200);
    await adapter.close();
  });

  it('handlePatch never throws, even with a dead pool', async () => {
    const ws = await createWorkspace('dead-pool');
    const deadPool = new pg.Pool({ connectionString: pgi.url });
    await deadPool.end(); // every query now rejects immediately

    const errors: string[] = [];
    const adapter = new PgStorageAdapter(deadPool, ws, dataRoot, {
      debounceMs: 10,
      logError: (m) => errors.push(m),
    });
    const doc = createSampleDocument();
    const { steps } = makePatches(doc, 2);

    expect(() => {
      for (const step of steps) adapter.handlePatch(step.patch, step.doc);
    }).not.toThrow();
    await expect(adapter.flush()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    // close() must also survive a dead pool.
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
