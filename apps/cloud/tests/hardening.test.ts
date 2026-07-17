import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAuthSchema } from '../src/auth/auth.js';
import { createAgentToken } from '../src/cloud/agentTokens.js';
import { createShareLink } from '../src/cloud/shareLinks.js';
import { createWorkspace, removeMember, upsertMember } from '../src/cloud/workspaces.js';
import { runMigrations } from '../src/db/migrate.js';
import { startEphemeralPg, type EphemeralPg } from './harness/ephemeralPg.js';

let pgi: EphemeralPg;
let dataRoot: string;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'pitolet-cloud-hardening-'));
  pgi = await startEphemeralPg('pitolet_hardening');
  await runMigrations(pgi.pool);
  await ensureAuthSchema({
    pool: pgi.pool,
    baseURL: 'http://127.0.0.1',
    secret: 'hardening-test-secret',
  });
}, 120_000);

afterAll(async () => {
  await pgi?.stop();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function insertVerifiedUser(id: string, email: string, verified = true): Promise<void> {
  await pgi.pool.query(
    `INSERT INTO "user"
       (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, now(), now())`,
    [id, id, email, verified],
  );
}

describe('transactional plan and ownership invariants', () => {
  it('serializes concurrent workspace creation per owner', async () => {
    const owner = 'concurrent-workspace-owner';
    const outcomes = await Promise.allSettled([
      createWorkspace(pgi.pool, { name: 'One', slug: 'quota-one', ownerUserId: owner }),
      createWorkspace(pgi.pool, { name: 'Two', slug: 'quota-two', ownerUserId: owner }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('serializes concurrent token and share-link creation', async () => {
    const workspace = await createWorkspace(pgi.pool, {
      name: 'Credential quota',
      slug: 'credential-quota',
      ownerUserId: 'credential-owner',
    });
    const tokenOutcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        createAgentToken(pgi.pool, {
          workspaceId: workspace.id,
          name: `Token ${index}`,
          createdBy: 'credential-owner',
        }),
      ),
    );
    expect(tokenOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    const document = await pgi.pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [workspace.id],
    );
    const linkOutcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createShareLink(pgi.pool, {
          workspaceId: workspace.id,
          docId: document.rows[0]!.id,
          createdBy: 'credential-owner',
        }),
      ),
    );
    expect(linkOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
  });

  it('requires verified invite targets and keeps one owner under concurrent removals', async () => {
    await insertVerifiedUser('verified-a', 'verified-a@example.test');
    await insertVerifiedUser('verified-b', 'verified-b@example.test');
    await insertVerifiedUser('unverified', 'unverified@example.test', false);
    const workspace = await createWorkspace(pgi.pool, {
      name: 'Member safety',
      slug: 'member-safety',
      ownerUserId: 'verified-a',
    });

    expect(
      await upsertMember(pgi.pool, {
        workspaceId: workspace.id,
        email: 'unverified@example.test',
        role: 'editor',
        requireVerifiedEmail: true,
      }),
    ).toEqual({ status: 'user-not-found' });

    expect(
      await upsertMember(pgi.pool, {
        workspaceId: workspace.id,
        email: 'verified-b@example.test',
        role: 'owner',
        requireVerifiedEmail: true,
      }),
    ).toMatchObject({ status: 'updated', userId: 'verified-b', role: 'owner' });

    const removals = await Promise.all([
      removeMember(pgi.pool, workspace.id, 'verified-a'),
      removeMember(pgi.pool, workspace.id, 'verified-b'),
    ]);
    expect(removals.filter((result) => result.status === 'removed')).toHaveLength(1);
    expect(removals.filter((result) => result.status === 'last-owner')).toHaveLength(1);
    const owners = await pgi.pool.query(
      `SELECT count(*)::int AS n FROM memberships
       WHERE workspace_id = $1 AND role = 'owner'`,
      [workspace.id],
    );
    expect(owners.rows[0]!.n).toBe(1);
  });
});
