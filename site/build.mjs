/**
 * Launcher for the public-site build.
 *
 * The real builder (build.ts) imports Pitolet's TypeScript packages directly
 * from the workspace source, so it needs a TS-aware loader. This launcher boots
 * the declared tsx ESM loader and then runs build.ts. That lets you build the
 * page with a plain `node site/build.mjs`.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const buildTs = resolve(here, 'build.ts');
const require = createRequire(import.meta.url);
let tsxLoader;

try {
  tsxLoader = require.resolve('tsx');
} catch {
  // An existing workspace may not have relinked after tsx was promoted to a
  // root dependency. The server also declares it, so this fallback keeps the
  // build usable until the next `pnpm install`.
  try {
    tsxLoader = require.resolve('tsx', { paths: [resolve(repoRoot, 'packages/server')] });
  } catch {
    console.error(
      'Could not resolve the tsx loader.\n' +
        'Run this from the Pitolet monorepo with dependencies installed (pnpm install).',
    );
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, ['--import', pathToFileURL(tsxLoader).href, buildTs], {
  stdio: 'inherit',
  cwd: repoRoot,
});
process.exit(result.status ?? 1);
