import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the built SPA works when mounted under any base
  // path (e.g. a future hosted deployment at /w/:workspaceSlug/). Does not
  // affect the dev server proxy below.
  base: './',
  plugins: [react()],
  optimizeDeps: {
    // Pre-bundle everything up front so a mid-session re-optimization can
    // never split React into two copies.
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'zustand',
      'zustand/react/shallow',
      'immer',
      'nanoid',
      'culori',
      'zod',
      'lucide-react',
      '@base-ui-components/react/select',
      '@base-ui-components/react/tooltip',
      '@base-ui-components/react/popover',
      '@base-ui-components/react/tabs',
    ],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4517',
      '/assets-store': 'http://localhost:4517',
      '/mcp': 'http://localhost:4517',
      '/ws': {
        target: 'ws://localhost:4517',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
