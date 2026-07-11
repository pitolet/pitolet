import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'schema',
          include: ['packages/schema/tests/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'codegen',
          include: ['packages/codegen/tests/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          include: ['packages/server/tests/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'cloud',
          include: ['apps/cloud/tests/**/*.test.ts'],
          environment: 'node',
          // The suite spins up a real ephemeral PostgreSQL instance.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'editor',
          include: ['packages/editor/tests/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'ui',
          include: ['packages/ui/tests/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
