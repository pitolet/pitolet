#!/usr/bin/env node
import('../packages/server/dist/cli.js').catch((err) => {
  console.error('Pitolet CLI failed to start. Did you run `pnpm build`?');
  console.error(err.message);
  process.exit(1);
});
