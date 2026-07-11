import { cpSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Bundle the cloud server to plain ESM. Two entries land flat in dist/:
 *   dist/server.js   — the http server (CMD in the Docker image)
 *   dist/migrate.js  — the SQL migration runner (deploy pre-step / CLI)
 *
 * migrate.ts resolves its SQL relative to its own file location
 * (`join(dirname(import.meta.url), 'migrations')`), so the built runner
 * reads dist/migrations/*.sql. We copy the .sql files there in onSuccess
 * (they are data, not modules, so tsup won't emit them otherwise).
 *
 * Neither entry is a bin, so no shebang banner is needed (unlike
 * packages/server which emits an executable cli.js).
 */
export default defineConfig({
  // Object form pins the output basenames so both land flat in dist/
  // (dist/server.js, dist/migrate.js) regardless of source directory.
  entry: { server: 'src/server.ts', migrate: 'src/db/migrate.ts' },
  format: 'esm',
  outDir: 'dist',
  clean: true,
  // Workspace packages ship TypeScript source — inline them into the bundle
  // instead of leaving bare imports node can't resolve at runtime.
  noExternal: ['pitolet', '@pitolet/schema'],
  onSuccess: async () => {
    mkdirSync('dist/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
  },
});
