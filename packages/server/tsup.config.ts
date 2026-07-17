import { defineConfig } from 'tsup';

const shared = {
  format: ['esm'] as const,
  outDir: 'dist',
  // Workspace packages ship TypeScript source — inline them into the bundle.
  noExternal: ['@pitolet/schema', '@pitolet/codegen'],
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    clean: true,
    // npm bin entry must be directly executable.
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: false,
    external: [/^node:/],
    // bundle-declarations.mjs rewrites the private workspace schema reference
    // to the publishable declarations emitted beside this entry.
    dts: true,
  },
]);
