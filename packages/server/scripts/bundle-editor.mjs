// Copies the built editor SPA into the server's dist so the published `pitolet`
// package can serve it. cli.ts probes for `<dist>/editor` first, so it lands there.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const editorDist = resolve(serverRoot, '../editor/dist');
const target = join(serverRoot, 'dist', 'editor');

if (!existsSync(editorDist)) {
  console.error(
    `[bundle-editor] editor build not found at ${editorDist}\n` +
      `               Build the editor first: pnpm --filter @pitolet/editor build\n` +
      `               (or run \`pnpm build\` from the repo root, which builds both in order)`,
  );
  process.exit(1);
}

// Skip sourcemaps: they add ~3.6MB to the npm tarball and matter only when
// debugging the editor itself — dev uses Vite directly, not this bundle.
cpSync(editorDist, target, {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});
console.log(`[bundle-editor] copied editor → ${target} (sourcemaps stripped)`);
