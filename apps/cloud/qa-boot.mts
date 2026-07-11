import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSampleDocument } from '@pitolet/schema';

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.PITOLET_DASHBOARD_DIST ??= join(HERE, 'dashboard/dist');
process.env.PITOLET_EDITOR_DIST ??= join(HERE, '../../packages/editor/dist');
import { createAuth, ensureAuthSchema } from './src/auth/auth.js';
import { runMigrations } from './src/db/migrate.js';
import { createCloudServer } from './src/server.js';
import { startEphemeralPg } from './tests/harness/ephemeralPg.js';

const PORT = 8099;
const base = `http://localhost:${PORT}`;
const EMAIL = 'qa@pitolet.test';
const PASSWORD = 'qa-password-123';

async function main() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-qa-data-'));
  const pg = await startEphemeralPg('pitolet_qa');
  await runMigrations(pg.pool);
  const authConfig = { pool: pg.pool, baseURL: base, secret: 'qa-test-secret-at-least-32-chars-long-xx' };
  await ensureAuthSchema(authConfig);
  const auth = createAuth(authConfig);
  const cloud = createCloudServer({ pool: pg.pool, auth, dataRoot, billing: null });
  await new Promise<void>((res) => cloud.server.listen(PORT, '127.0.0.1', res));

  // --- Seed a signed-up user, a workspace, and a document ---
  const signUp = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'QA User' }),
  });
  if (signUp.status !== 200) {
    console.error('SIGNUP FAILED', signUp.status, await signUp.text());
    process.exit(1);
  }
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');

  const wsRes = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Acme Design', slug: 'acme' }),
  });
  if (wsRes.status !== 201) {
    console.error('WORKSPACE FAILED', wsRes.status, await wsRes.text());
    process.exit(1);
  }
  const { workspace } = (await wsRes.json()) as { workspace: { id: string; slug: string } };

  // Seed one document with sample content (frames present so frameCount > 0).
  const doc = createSampleDocument();
  doc.name = 'Landing Page';
  await pg.pool.query(
    'INSERT INTO documents (id, workspace_id, name, doc, rev) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [doc.id, workspace.id, doc.name, JSON.stringify(doc), 0],
  );
  // A couple of pre-existing snapshots so History isn't empty on first load.
  await pg.pool.query(
    `INSERT INTO doc_snapshots (doc_id, rev, doc, kind, label, created_by)
     VALUES ($1, 0, $2::jsonb, 'auto', NULL, $3),
            ($1, 0, $2::jsonb, 'named', 'Initial layout', $3)`,
    [doc.id, JSON.stringify(doc), null],
  );

  console.log(`QA server listening on ${base} (data ${dataRoot})`);
  console.log(`QA seed: email=${EMAIL} password=${PASSWORD} ws=${workspace.slug} docId=${doc.id}`);

  const shutdown = async () => {
    await cloud.close();
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
