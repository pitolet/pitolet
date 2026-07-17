# syntax=docker/dockerfile:1

# Pitolet Cloud — the commercial hosted app (ghcr.io/pitolet/pitolet-cloud).
# Multi-stage build mirroring the OSS root Dockerfile's pnpm pattern.
# Build context is the REPO ROOT (docker build -f apps/cloud/Dockerfile .).

# ---- build: install workspace, build editor + server core + cloud server ----
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

# Manifests first, for dependency-layer caching. Copy each package.json
# explicitly so a source-only change doesn't bust the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/schema/package.json   packages/schema/package.json
COPY packages/codegen/package.json  packages/codegen/package.json
COPY packages/server/package.json   packages/server/package.json
COPY packages/editor/package.json   packages/editor/package.json
COPY packages/ui/package.json       packages/ui/package.json
COPY apps/cloud/package.json        apps/cloud/package.json

RUN pnpm install --frozen-lockfile

# Sources, then build. Root `pnpm build` compiles the editor (→
# packages/editor/dist) and the server core. Then build the cloud server
# bundle (→ apps/cloud/dist: server.js, migrate.js, migrations/*.sql) and the
# dashboard SPA if the concurrent agent's dashboard/ exists yet.
COPY . .
RUN pnpm build
RUN pnpm --filter @pitolet/cloud build:server
# Guard on the vite config (not just the dir): the dashboard agent may have
# scaffolded apps/cloud/dashboard/ before its build is wired up.
RUN if [ -f apps/cloud/dashboard/vite.config.ts ]; then \
      pnpm --filter @pitolet/cloud build:dashboard; \
    else \
      echo "no apps/cloud/dashboard/vite.config.ts — skipping dashboard build"; \
    fi

# ---- deploy: prune to the cloud package + prod deps, then graft built dist ----
# pnpm 11 requires --legacy for non-injected workspaces (or the deploy errors).
# `pnpm deploy` gives us /out/node_modules with pitolet + @pitolet/schema
# inlined-source deps resolved, but NOT the built dist dirs (editor is not a
# runtime dep of the cloud pkg, and the server bundle post-dates install), so
# we copy those explicitly to the paths the runtime env points at.
RUN pnpm deploy --legacy --filter ./apps/cloud --prod /out \
    && cp -r apps/cloud/dist /out/dist \
    && cp -r packages/editor/dist /out/editor \
    && if [ -d apps/cloud/dashboard/dist ]; then \
         rm -rf /out/dashboard \
         && cp -r apps/cloud/dashboard/dist /out/dashboard; \
       fi

# ---- runtime: minimal image serving the cloud app ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PITOLET_CLOUD_PORT=8080 \
    PITOLET_CLOUD_DATA=/data \
    PITOLET_EDITOR_DIST=/app/editor \
    PITOLET_DASHBOARD_DIST=/app/dashboard

COPY --from=build /out .

# Guard the exact production dashboard shape. `pnpm deploy` includes the
# dashboard source directory, so the build stage must replace it with Vite's
# output rather than nesting that output at /app/dashboard/dist. Serving the
# source index would reference /src/main.tsx and leave the browser blank.
RUN test -f /app/dashboard/index.html \
    && test -d /app/dashboard/assets \
    && test ! -d /app/dashboard/src \
    && ! grep -q '/src/main.tsx' /app/dashboard/index.html \
    && grep -qE 'src="/assets/[^" ]+\.js"' /app/dashboard/index.html \
    && node -e "Promise.all([import('@sentry/node'), import('playwright-core')])"

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

# Readiness includes a database round-trip; a static dashboard response must
# not keep a container marked healthy while Postgres is unavailable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PITOLET_CLOUD_PORT||8080)+'/readyz').then(async r=>{const type=r.headers.get('content-type')||'';const body=await r.json().catch(()=>null);process.exit(r.ok&&type.toLowerCase().startsWith('application/json')&&body?.ok===true?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
