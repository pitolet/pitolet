import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Advisory lock key so concurrent deploys don't race the runner. */
const MIGRATION_LOCK = 0x7069746f; // 'pito'

/**
 * Numbered-SQL migration runner: applies migrations/*.sql in name order,
 * tracking applied files in schema_migrations. Each migration runs in its
 * own transaction; already-applied files are skipped, so re-running is a
 * no-op (idempotent).
 */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (seen.rowCount) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

// CLI entry: `tsx src/db/migrate.ts` (later `node dist/migrate.js`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { getPool, closePool } = await import('./pool.js');
  try {
    const applied = await runMigrations(getPool());
    console.log(
      applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations',
    );
  } finally {
    await closePool();
  }
}
