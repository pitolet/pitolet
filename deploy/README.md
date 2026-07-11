# Deploying Pitolet Cloud

Single-VPS production stack: **Caddy** (TLS + static landing + reverse proxy),
the **app** (`ghcr.io/pitolet/pitolet-cloud`), **Postgres 17**, and a **restic**
backup sidecar. Once the box is set up, it all comes up with `docker compose up -d`.

Target hosts:

- `pitolet.com` — static marketing site (served from `./static`, including
  `/vs-figma/`).
- `app.pitolet.com` — the cloud app.

## 1. Provision the VPS

1. Create a Hetzner Cloud **CPX31** (Ubuntu 24.04), or larger.
2. Point DNS **A records** at the server's public IPv4 (and **AAAA** at the
   IPv6 if you use it):
   - `pitolet.com`
   - `app.pitolet.com`
   Wait for propagation before step 6. Caddy needs the names resolving to the
   box to issue Let's Encrypt certificates.

## 2. Create a deploy user + harden SSH

As root on the fresh box:

```sh
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
# paste your workstation public key:
nano /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

Harden `/etc/ssh/sshd_config` — key-only, no root:

```
PermitRootLogin no
PasswordAuthentication no
```

```sh
systemctl restart ssh
```

Reconnect as `deploy` in a new terminal **before** closing the root session.

## 3. Install Docker + Compose v2

```sh
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker deploy    # log out/in for group to take effect
docker compose version            # verify v2
```

## 4. Firewall

```sh
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 5. Copy the deploy dir + fill secrets

```sh
sudo mkdir -p /opt/pitolet && sudo chown deploy:deploy /opt/pitolet
# from your workstation:
#   scp -r deploy/* deploy@<host>:/opt/pitolet/
cd /opt/pitolet
cp .env.example .env
nano .env    # set POSTGRES_PASSWORD, DATABASE_URL (same password), BETTER_AUTH_SECRET,
             # BETTER_AUTH_URL, RESTIC_REPOSITORY, RESTIC_PASSWORD (see hints in the file)
```

Generate secrets with `openssl rand -hex 32`.

For `RESTIC_REPOSITORY` (Hetzner Storage Box over sftp) make sure the deploy
user's SSH key is authorized on the Storage Box so restic can connect
non-interactively.

## 6. Launch

```sh
cd /opt/pitolet
docker login ghcr.io          # if the image is private
docker compose pull
docker compose up -d
docker compose ps             # all services healthy?
```

Run the DB migrations once (the deploy workflow does this on every release, but
do it explicitly the first time):

```sh
docker compose run --rm app node dist/migrate.js
```

## 7. Verify

```sh
curl -I https://pitolet.com            # 200, landing page
curl -I https://app.pitolet.com/       # 200 (app liveness endpoint)
docker compose logs -f app             # watch boot / requests
docker compose logs backup             # confirm first nightly backup path
```

Caddy fetches certs on the first HTTPS request, so the first hit may take a few
seconds. If a cert fails, re-check DNS (step 1) and `docker compose logs caddy`.

## Monitoring

Operational monitoring is in-process; there's no separate metrics stack.

**Metrics endpoint.** `GET /internal/metrics` returns a JSON gauge snapshot.
It is gated by a shared secret. Caddy proxies everything, so binding to
loopback would not restrict access. Set `PITOLET_METRICS_TOKEN` in `.env`
(`openssl rand -hex 32`); when unset the route 404s (dev default: off).

```sh
curl -H "Authorization: Bearer $PITOLET_METRICS_TOKEN" \
  https://app.pitolet.com/internal/metrics
# {"loadedWorkspaces":3,"wsClients":7,"rssBytes":...,"heapUsedBytes":...,
#  "uptimeSeconds":...,"pgPoolTotal":...,"pgPoolIdle":...,"pgPoolWaiting":...}
```

**Uptime checks.** Point [UptimeRobot](https://uptimerobot.com) (or similar)
at two HTTP(S) monitors, both expecting `200`:

- `https://app.pitolet.com/` — the app liveness endpoint (same URL the
  Dockerfile HEALTHCHECK hits).
- `https://pitolet.com` — the static landing page.

**Gauge log.** Every 5 minutes (and once at shutdown) the app logs a single
structured line. Grep it out of the container logs; no backend required:

```sh
docker compose logs app | grep gauges
# [pitolet-cloud] gauges {"loadedWorkspaces":3,"wsClients":7,...}
```

**Error tracking (optional).** Set `SENTRY_DSN` in `.env` to report
process-level `uncaughtException` / `unhandledRejection` events. Any
Sentry-DSN-compatible backend works, including self-hosted
[GlitchTip](https://glitchtip.com) (paste its project DSN as `SENTRY_DSN`).
The `@sentry/node` package is intentionally not bundled — install it in the
image (`pnpm add @sentry/node`) to opt in; without it, `SENTRY_DSN` is a no-op.

**When memory grows.** Watch `rssBytes` against `loadedWorkspaces` in the
gauge log or metrics endpoint. RSS tracking `loadedWorkspaces` upward is
expected, since each resident runtime holds a document store; idle ones are
evicted by the sweep (15 min idle, LRU hard cap). If RSS climbs while
`loadedWorkspaces` stays flat, that's a leak rather than fleet load.

## 8. GitHub Actions deploy key

The `.github/workflows/deploy.yml` workflow SSHes in and rolls the app forward.
Add these repository **secrets**:

- `VPS_HOST` — the server IP or hostname.
- `VPS_USER` — `deploy`.
- `VPS_SSH_KEY` — a private key whose public half is in
  `/home/deploy/.ssh/authorized_keys`. Generate a dedicated pair:
  `ssh-keygen -t ed25519 -f pitolet_deploy -N ""`, append `pitolet_deploy.pub`
  to the deploy user's `authorized_keys`, and paste `pitolet_deploy` (private)
  as the secret.

Trigger from the Actions tab (**workflow_dispatch**), optionally with a `tag`
input; it pulls that tag, runs migrations, and restarts `app` + `caddy`.

## 9. Monthly restore drill

Once a month, restore the latest backup to a throwaway scratch DB and confirm
the dump loads:

```sh
cd /opt/pitolet

# 1. See what's in the repo.
docker compose run --rm backup sh -c 'restic snapshots'

# 2. Restore the latest DB dump + assets into a scratch dir inside the container.
docker compose run --rm backup sh -c '
  restic restore latest --target /restore &&
  ls -la /restore /restore/data
'

# 3. Load the dump into a scratch database and sanity-check row counts.
docker compose exec postgres sh -c '
  createdb -U "$POSTGRES_USER" pitolet_restore_test 2>/dev/null || true
'
docker compose run --rm backup sh -c '
  restic dump latest /pitolet.dump \
    | PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h postgres -U "$POSTGRES_USER" \
        -d pitolet_restore_test --clean --if-exists --no-owner
'
docker compose exec postgres sh -c '
  psql -U "$POSTGRES_USER" -d pitolet_restore_test -c "\dt" &&
  dropdb -U "$POSTGRES_USER" pitolet_restore_test
'
```

If every step succeeds and the tables/rows look right, the backup chain is
sound. Write down the drill date where you'll find it again.
