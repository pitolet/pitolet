import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  outDir: 'dist',
  clean: true,
  // npm bin entry must be directly executable.
  banner: { js: '#!/usr/bin/env node' },
  // Workspace packages ship TypeScript source — inline them into the bundle.
  noExternal: ['@pitolet/schema', '@pitolet/codegen'],
});
