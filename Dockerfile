# syntax=docker/dockerfile:1

# ---- build: install workspace + build editor and server ----
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

RUN pnpm install --frozen-lockfile

# Now the sources, then build (root build compiles editor before server,
# and the server build bundles the editor into packages/server/dist/editor).
COPY . .
RUN pnpm build

# ---- deploy: prune to the publishable `pitolet` package + prod deps ----
# pnpm 11 requires --legacy for non-injected workspaces (or the deploy errors).
RUN pnpm deploy --legacy --filter ./packages/server --prod /out \
    && cp -r packages/server/dist /out/dist

# ---- runtime: minimal image serving the built app ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PITOLET_PORT=4517 \
    PITOLET_DATA=/data

COPY --from=build /out .

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4517

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PITOLET_PORT||4517)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js"]
