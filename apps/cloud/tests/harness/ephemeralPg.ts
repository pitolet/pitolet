import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

// Match the app pool's int8 handling (see src/db/pool.ts): rev counters fit
// comfortably in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const exec = promisify(execFile);

// Pin the locale for every postgres binary: inherited LANG/LC_* are often
// invalid inside test runners; initdb bails ("invalid locale settings") and
// on macOS the postmaster dies with "postmaster became multithreaded".
const PG_ENV = { ...process.env, LANG: 'C', LC_ALL: 'C' };

function run(file: string, args: string[], timeout: number) {
  return exec(file, args, { timeout, env: PG_ENV });
}

export interface EphemeralPg {
  pool: pg.Pool;
  url: string;
  stop(): Promise<void>;
}

/** Locate PostgreSQL binaries: $PGBIN → pg_config --bindir → homebrew pg16. */
async function findBinDir(): Promise<string> {
  if (process.env.PGBIN) return process.env.PGBIN;
  try {
    const { stdout } = await run('pg_config', ['--bindir'], 10_000);
    const dir = stdout.trim();
    if (dir) return dir;
  } catch {
    // fall through
  }
  return '/opt/homebrew/opt/postgresql@16/bin';
}

/**
 * Spin up a throwaway PostgreSQL instance in a temp dir (initdb + pg_ctl on
 * a random localhost port), create a database, and hand back a pool. stop()
 * shuts the server down and removes the directory. One instance per test
 * file — call from beforeAll/afterAll.
 */
export async function startEphemeralPg(dbName = 'pitolet_cloud_test'): Promise<EphemeralPg> {
  const bin = await findBinDir();
  // os.tmpdir(), not the deep vitest cwd: unix socket paths are length-limited.
  const dir = mkdtempSync(join(tmpdir(), 'pitolet-pg-'));
  const dataDir = join(dir, 'data');

  const cleanupDir = () => rmSync(dir, { recursive: true, force: true });
  try {
    await run(
      join(bin, 'initdb'),
      ['-D', dataDir, '-A', 'trust', '--no-sync', '-U', 'postgres', '--locale=C', '--encoding=UTF8'],
      60_000,
    );
  } catch (err) {
    cleanupDir();
    throw err;
  }

  // Random localhost port; retry a few times in case of a collision.
  let port = 0;
  let started = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5 && !started; attempt++) {
    port = 21000 + Math.floor(Math.random() * 9000);
    try {
      await run(
        join(bin, 'pg_ctl'),
        [
          '-D',
          dataDir,
          '-o',
          `-p ${port} -k ${dir} -F -c listen_addresses=127.0.0.1`,
          '-l',
          join(dir, 'pg.log'),
          '-w',
          '-t',
          '60',
          'start',
        ],
        90_000,
      );
      started = true;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!started) {
    cleanupDir();
    throw new Error(`ephemeral postgres failed to start: ${(lastErr as Error)?.message}`);
  }

  const stopServer = async () => {
    await run(join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], 60_000).catch(
      () => {},
    );
    cleanupDir();
  };

  try {
    await run(
      join(bin, 'createdb'),
      ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', dbName],
      30_000,
    );
  } catch (err) {
    await stopServer();
    throw err;
  }

  const url = `postgresql://postgres@127.0.0.1:${port}/${dbName}`;
  const pool = new pg.Pool({ connectionString: url });

  return {
    pool,
    url,
    async stop() {
      await pool.end().catch(() => {});
      await stopServer();
    },
  };
}
