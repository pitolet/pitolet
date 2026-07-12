# @pitolet/cloud

This package runs [app.pitolet.com](https://app.pitolet.com). It handles accounts, Postgres-backed workspaces, agent tokens, and the hosted MCP endpoint. Each workspace serves the editor under `/w/:slug/`.

The source is visible, but it is commercially licensed rather than open source. See [LICENSE](./LICENSE).

## Layout

- `src/server.ts` — the http server. Validates `DATABASE_URL` +
  `BETTER_AUTH_SECRET`, runs SQL migrations and the better-auth schema, listens
  on `PITOLET_CLOUD_PORT` (default 8080), graceful shutdown on SIGTERM.
- `src/db/migrate.ts` — numbered-SQL migration runner (also a CLI entry).
- `src/router.ts` — the tenancy security boundary.
- `dashboard/` — the account/workspace dashboard SPA (owned separately).

## Develop

```sh
pnpm --filter @pitolet/cloud dev   # tsx watch src/server.ts
```

Requires a reachable Postgres (`DATABASE_URL`) and `BETTER_AUTH_SECRET`.

## Build

```sh
pnpm --filter @pitolet/cloud build
```

`build` runs `build:server` (tsup) then `build:dashboard` (vite). The server
build emits, flat in `dist/`:

- `dist/server.js` — the server bundle (`CMD` of the Docker image).
- `dist/migrate.js` — the migration runner (deploy pre-step).
- `dist/migrations/*.sql` — copied from `src/db/migrations`. The runner
  resolves them relative to its own location, so don't move them.

Workspace deps (`pitolet`, `@pitolet/schema`) are inlined via tsup `noExternal`.

## Deploying

The hosted app ships as a Docker image and runs on a single Hetzner VPS via
Docker Compose (Caddy + app + Postgres + restic backups). Full runbook:
[`deploy/README.md`](../../deploy/README.md) at the repo root.

### Image

`apps/cloud/Dockerfile` is a multi-stage build (**context = repo root**):

```sh
docker build -f apps/cloud/Dockerfile -t ghcr.io/pitolet/pitolet-cloud .
```

The build stage installs the pnpm workspace (manifests-first for layer
caching), runs the root `pnpm build` (editor + server core), builds the cloud
server bundle and — if present — the dashboard, then `pnpm deploy --legacy`
prunes to prod deps. Because the editor and the freshly-built bundles are not
runtime `node_modules` deps, they are copied explicitly into the image:

| Content                   | Image path      | Resolved via                    |
| ------------------------- | --------------- | ------------------------------- |
| `apps/cloud/dist`         | `/app/dist`     | `CMD node dist/server.js`       |
| `packages/editor/dist`    | `/app/editor`   | `PITOLET_EDITOR_DIST=/app/editor` |
| `apps/cloud/dashboard/dist` | `/app/dashboard` | `PITOLET_DASHBOARD_DIST=/app/dashboard` |

`resolveEditorDist()` in `server.ts` honours `PITOLET_EDITOR_DIST` first, so the
image points it at the copied SPA rather than relying on package resolution.

Runtime: `node:22-alpine`, `USER node`, `EXPOSE 8080`, `VOLUME /data`
(`PITOLET_CLOUD_DATA`), healthcheck probes `GET /` (served 200 unauthenticated,
no DB round-trip).

### CI / CD

- **`.github/workflows/docker.yml`** builds and pushes both
  `ghcr.io/pitolet/pitolet` (OSS) and `ghcr.io/pitolet/pitolet-cloud` on `v*`
  tags.
- **`.github/workflows/deploy.yml`** (`workflow_dispatch`, input `tag`) SSHes
  into the VPS and runs `docker compose pull app` → `run --rm app node
  dist/migrate.js` → `up -d app caddy`.
