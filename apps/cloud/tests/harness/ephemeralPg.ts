import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
interface ActiveEphemeralPg {
  bin: string;
  dataDir: string;
  rootDir: string;
  pool?: pg.Pool;
  stopPromise?: Promise<void>;
  cleaned: boolean;
}

const activeInstances = new Set<ActiveEphemeralPg>();
let cleanupHooksInstalled = false;
const syncWaitCell = new Int32Array(new SharedArrayBuffer(4));

function run(file: string, args: string[], timeout: number) {
  return exec(file, args, { timeout, env: PG_ENV });
}

function stopServerSync(instance: ActiveEphemeralPg): boolean {
  if (instance.cleaned) return true;
  try {
    execFileSync(
      join(instance.bin, 'pg_ctl'),
      ['-D', instance.dataDir, '-m', 'immediate', '-w', '-t', '10', 'stop'],
      { timeout: 15_000, env: PG_ENV, stdio: 'ignore' },
    );
    return true;
  } catch {
    // It may not have reached postmaster startup yet, or may already be gone.
    const pidFile = join(instance.dataDir, 'postmaster.pid');
    if (!existsSync(pidFile)) return true;
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').split('\n')[0] ?? '', 10);
    if (Number.isInteger(pid) && pid > 1) {
      try {
        // SIGQUIT is PostgreSQL's immediate-shutdown signal and lets the
        // postmaster remove shared-memory state before the runner exits.
        process.kill(pid, 'SIGQUIT');
      } catch {
        return true;
      }
      // Give the postmaster a bounded chance to remove its shared-memory
      // state, then verify it is actually down before deleting the data dir.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          execFileSync(join(instance.bin, 'pg_ctl'), ['-D', instance.dataDir, 'status'], {
            timeout: 2_000,
            env: PG_ENV,
            stdio: 'ignore',
          });
        } catch {
          return true;
        }
        Atomics.wait(syncWaitCell, 0, 0, 50);
      }
    }
    return false;
  }
}

function cleanupInstanceSync(instance: ActiveEphemeralPg): void {
  if (instance.cleaned) return;
  const stopped = stopServerSync(instance);
  if (!stopped) return;
  rmSync(instance.rootDir, { recursive: true, force: true });
  instance.cleaned = true;
  activeInstances.delete(instance);
}

function cleanupAllSync(): void {
  for (const instance of [...activeInstances]) cleanupInstanceSync(instance);
}

function installCleanupHooks(): void {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  // Signal cleanup is synchronous on purpose: the runner may exit immediately
  // after its own signal listener runs.
  process.prependOnceListener('SIGINT', cleanupAllSync);
  process.prependOnceListener('SIGTERM', cleanupAllSync);
  process.on('exit', cleanupAllSync);
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
  // Register the temp directory before initdb starts. A test-runner signal
  // during initdb/pg_ctl otherwise leaves the child and its directory outside
  // the normal afterAll cleanup path.
  const active: ActiveEphemeralPg = {
    bin,
    dataDir,
    rootDir: dir,
    cleaned: false,
  };
  activeInstances.add(active);
  installCleanupHooks();
  try {
    await run(
      join(bin, 'initdb'),
      [
        '-D',
        dataDir,
        '-A',
        'trust',
        '--no-sync',
        '-U',
        'postgres',
        '--locale=C',
        '--encoding=UTF8',
      ],
      60_000,
    );
  } catch (err) {
    cleanupInstanceSync(active);
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
      // pg_ctl can time out after the postmaster has actually started. Treat
      // a successful status probe as a successful start rather than launching
      // a second postmaster against the same data directory.
      try {
        await run(join(bin, 'pg_ctl'), ['-D', dataDir, 'status'], 10_000);
        started = true;
      } catch {
        // A real startup failure is safe to retry with another random port.
      }
    }
  }
  if (!started) {
    cleanupInstanceSync(active);
    throw new Error(`ephemeral postgres failed to start: ${(lastErr as Error)?.message}`);
  }

  const stopServer = async () => {
    if (active.cleaned) return;
    let stopped = false;
    for (let attempt = 0; attempt < 2 && !stopped; attempt += 1) {
      await run(
        join(bin, 'pg_ctl'),
        ['-D', dataDir, '-m', 'immediate', '-w', '-t', '30', 'stop'],
        45_000,
      ).catch(() => {});
      stopped = await run(join(bin, 'pg_ctl'), ['-D', dataDir, 'status'], 10_000).then(
        () => false,
        () => true,
      );
    }
    if (!stopped) {
      throw new Error(`ephemeral postgres at ${dataDir} did not stop cleanly`);
    }
    cleanupDir();
    active.cleaned = true;
    activeInstances.delete(active);
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
  active.pool = pool;

  const instance: EphemeralPg = {
    pool,
    url,
    async stop() {
      if (active.stopPromise) return active.stopPromise;
      const operation = (async () => {
        await pool.end().catch(() => {});
        await stopServer();
      })();
      active.stopPromise = operation;
      try {
        await operation;
      } catch (error) {
        active.stopPromise = undefined;
        throw error;
      }
    },
  };
  return instance;
}

export function activeEphemeralPgCountForTests(): number {
  return activeInstances.size;
}
