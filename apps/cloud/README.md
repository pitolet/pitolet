# @pitolet/cloud

This package contains the server behind
[app.pitolet.com](https://app.pitolet.com). It adds accounts and
Postgres-backed workspaces to the core server. Each workspace gets an editor
URL under `/w/:slug/` and its own MCP endpoint.

The source is visible, but it is commercially licensed rather than open source. See [LICENSE](./LICENSE).

## Layout

- `src/server.ts`: the HTTP server. Validates `DATABASE_URL` +
  `BETTER_AUTH_SECRET`, runs SQL migrations and the better-auth schema, listens
  on `PITOLET_CLOUD_PORT` (default 8080), graceful shutdown on SIGTERM.
- `src/db/migrate.ts`: numbered-SQL migration runner and CLI entry.
- `src/router.ts`: the tenancy security boundary.
- `dashboard/`: the account and workspace dashboard.

## Develop

```sh
pnpm --filter @pitolet/cloud dev   # tsx watch src/server.ts
```

Requires a reachable Postgres (`DATABASE_URL`) and `BETTER_AUTH_SECRET`.
Public HTTPS deployments also require `RESEND_API_KEY`; password accounts do
not receive a session until their email is verified.

Billing is enabled only with a complete Paddle configuration:
`PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID_PRO`,
`PADDLE_PRODUCT_ID_PRO`, and `PADDLE_ENV`. A production deployment that does
not offer billing must say so explicitly with `PADDLE_BILLING_DISABLED=true`;
partial billing configuration stops the server at boot.

## Build

```sh
pnpm --filter @pitolet/cloud build
```

`build` runs `build:server` (tsup) then `build:dashboard` (vite). The server
build emits, flat in `dist/`:

- `dist/server.js`: the server bundle (`CMD` of the Docker image).
- `dist/migrate.js`: the migration runner used during deployment.
- `dist/migrations/*.sql`: copied from `src/db/migrations`. The runner
  resolves them relative to its own location, so don't move them.

Workspace deps (`pitolet`, `@pitolet/schema`) are inlined via tsup `noExternal`.

## Deploying

The hosted app ships as a Docker image and runs on a single Virtarix VPS via
Docker Compose (Caddy + app + Postgres + restic backups). Full runbook:
[`deploy/README.md`](../../deploy/README.md) at the repo root.

### Image

`apps/cloud/Dockerfile` is a multi-stage build (**context = repo root**):

```sh
docker build -f apps/cloud/Dockerfile -t ghcr.io/pitolet/pitolet-cloud .
```

The build installs workspace dependencies before copying the source so Docker
can reuse the dependency layer. It then builds the editor, core server, cloud
server, and dashboard. `pnpm deploy --legacy` removes development
dependencies.

The built editor and server bundles are copied into the image explicitly
because they are not runtime packages in `node_modules`:

| Content                     | Image path       | Resolved via                            |
| --------------------------- | ---------------- | --------------------------------------- |
| `apps/cloud/dist`           | `/app/dist`      | `CMD node dist/server.js`               |
| `packages/editor/dist`      | `/app/editor`    | `PITOLET_EDITOR_DIST=/app/editor`       |
| `apps/cloud/dashboard/dist` | `/app/dashboard` | `PITOLET_DASHBOARD_DIST=/app/dashboard` |

`resolveEditorDist()` in `server.ts` honours `PITOLET_EDITOR_DIST` first, so the
image points it at the copied SPA rather than relying on package resolution.

Runtime: `node:22-alpine`, `USER node`, `EXPOSE 8080`, `VOLUME /data`
(`PITOLET_CLOUD_DATA`), healthcheck probes `GET /readyz`, which includes a
Postgres round-trip. `GET /healthz` is the process-only liveness endpoint.

### Release and deployment

`.github/workflows/release.yml` publishes npm and builds the matching container
images through `.github/workflows/docker.yml`.

`.github/workflows/deploy.yml` takes a fresh backup and starts a candidate
container before replacing the live app. If a later public check fails, it
restores the previous image and configuration.
