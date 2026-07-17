import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc', { paths: [repoRoot] });
const config = resolve(serverRoot, 'tsconfig.schema-dts.json');

const emitted = spawnSync(process.execPath, [tsc, '--project', config], {
  cwd: serverRoot,
  stdio: 'inherit',
});
if (emitted.status !== 0) {
  throw new Error(`schema declaration build failed (${emitted.status ?? 'unknown'})`);
}

const entryPath = resolve(serverRoot, 'dist/index.d.ts');
const original = readFileSync(entryPath, 'utf8');
const rewritten = original.replaceAll("from '@pitolet/schema'", "from './schema/index.js'");
if (rewritten === original || rewritten.includes('@pitolet/schema')) {
  throw new Error('could not replace the private @pitolet/schema declaration import');
}
writeFileSync(entryPath, rewritten);
console.log('[bundle-declarations] inlined publishable schema declarations');
