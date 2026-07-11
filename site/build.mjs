/**
 * Launcher for the public-site build.
 *
 * The real builder (build.ts) imports Pitolet's TypeScript packages directly
 * from the workspace source, so it needs a TS-aware loader. This launcher boots
 * the tsx ESM loader (already installed in the monorepo) and then runs build.ts.
 * That lets you build the page with a plain `node site/build.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
const buildTs = resolve(here, 'build.ts');

if (!existsSync(tsxBin)) {
  console.error(
    'Could not find tsx at node_modules/.bin/tsx.\n' +
      'Run this from the Pitolet monorepo with dependencies installed (pnpm install).',
  );
  process.exit(1);
}

const result = spawnSync(tsxBin, [buildTs], { stdio: 'inherit', cwd: repoRoot });
process.exit(result.status ?? 1);
