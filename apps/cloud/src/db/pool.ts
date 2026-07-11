import pg from 'pg';

// rev / max(rev) come back as int8 — parse to number (revision counters and
// row counts stay far below Number.MAX_SAFE_INTEGER).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/** Create a pool for an explicit connection string (tests, tooling). */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  // An idle client losing its backend (DB restart, failover) emits 'error'
  // on the pool; without a listener that is an uncaught exception and takes
  // the whole server down. Log it — the pool replaces dead clients itself.
  pool.on('error', (err) => {
    console.error('[pitolet-cloud] idle database client error:', err.message);
  });
  return pool;
}

let pool: pg.Pool | null = null;

/** Lazy app-wide pool from DATABASE_URL. */
export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = createPool(url);
  }
  return pool;
}

/** Tiny query helper against the app pool. */
export function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(text, params as never[]);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
