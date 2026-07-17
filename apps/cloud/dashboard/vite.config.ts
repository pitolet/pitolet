import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard SPA is NOT its own workspace package — it builds from inside
// apps/cloud with cloud's own vite + plugin-react devDeps. `root` is this
// directory so index.html and src/ resolve regardless of the cwd `vite build`
// runs from.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  // Absolute base: the dashboard is always served from the domain root `/`, and
  // its index.html is the fallback for nested client routes like /settings/:id.
  // Relative ('./') asset URLs would resolve against /settings/ and 404 — so
  // asset URLs must be root-absolute. (The editor SPA uses './' because it is
  // mounted under /w/:slug/, a different constraint.)
  base: '/',
  plugins: [react()],
  server: {
    // `pnpm --filter @pitolet/cloud dev:dashboard` proxies API/auth to the
    // running cloud server on :8080.
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
