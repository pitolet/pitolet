# Deploying Pitolet Cloud

Pitolet Cloud runs on one VPS with Caddy, the app container, Postgres 17, and restic backups. After the initial setup, `docker compose up -d` starts the full stack.

Target hosts:

- `pitolet.com` — static marketing site (served from `./static`, including
  `/vs-figma/`).
- `app.pitolet.com` — the cloud app.

## 1. Provision the VPS

1. Create a Virtarix VPS running **Ubuntu 24.04**. Start with 2 vCPU and
   4 GB RAM; move up only if the database or image builds need it.
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
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin rsync
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
#   rsync -av deploy/ deploy@<host>:/opt/pitolet/
cd /opt/pitolet
cp .env.example .env
nano .env    # set POSTGRES_PASSWORD, DATABASE_URL (same password), BETTER_AUTH_SECRET,
             # BETTER_AUTH_URL, RESEND_API_KEY, RESTIC_REPOSITORY,
             # RESTIC_PASSWORD, and either Paddle credentials or
             # PADDLE_BILLING_DISABLED=true (see hints in the file)
```

Generate secrets with `openssl rand -hex 32`.
Set `TAG` to an immutable published version such as `1.1.0`; do not use
`latest`. Both deploy and rollback rely on that exact value.

For an SFTP `RESTIC_REPOSITORY`, create a dedicated key and pin the host key:

```sh
mkdir -p backup-ssh
ssh-keygen -t ed25519 -f backup-ssh/id_ed25519 -N ""
# Add backup-ssh/id_ed25519.pub at your storage provider, then:
ssh-keyscan -H <backup-host> > backup-ssh/known_hosts
chmod 700 backup-ssh
chmod 600 backup-ssh/id_ed25519 backup-ssh/known_hosts
```

Set `RESTIC_SSH_DIR=./backup-ssh`. Keep the private key and `known_hosts` out
of Git.

## 6. Launch

```sh
cd /opt/pitolet
docker login ghcr.io          # if the image is private
docker compose config         # catches missing variables and YAML errors
docker compose pull app caddy postgres
docker compose build --pull backup
docker compose up -d
docker compose ps             # all services healthy?
```

The app applies pending database migrations before it starts listening. During
a deploy, the isolated candidate starts first and applies those migrations
before the live container is replaced.

## 7. Verify

```sh
curl -fsS https://pitolet.com >/dev/null
curl -fsS https://app.pitolet.com/healthz
curl -fsS https://app.pitolet.com/readyz
docker compose logs -f app             # watch boot / requests
docker compose logs backup             # the first backup runs immediately
docker compose exec backup restic snapshots --host pitolet-cloud --tag pitolet-nightly
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

**Uptime checks.** Point an uptime monitor at these URLs, all expecting `200`:

- `https://app.pitolet.com/healthz` — process liveness.
- `https://app.pitolet.com/readyz` — readiness, including a database query
  (the Docker health check uses this URL).
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
The stock image includes the Sentry client. If `SENTRY_DSN` is configured but
the client cannot initialize, startup stops instead of silently running
without reporting. When `SENTRY_DSN` is unset, error tracking stays off.

**When memory grows.** Watch `rssBytes` against `loadedWorkspaces` in the
gauge log or metrics endpoint. RSS tracking `loadedWorkspaces` upward is
expected, since each resident runtime holds a document store; idle ones are
evicted by the sweep (15 min idle, LRU hard cap). If RSS climbs while
`loadedWorkspaces` stays flat, that's a leak rather than fleet load.

## 8. GitHub Actions deploy key

The `.github/workflows/deploy.yml` workflow uploads the complete `deploy/`
directory, not only the static site. It validates Compose and Caddy, takes a
fresh database-and-assets backup, boots the new image as an isolated candidate,
and requires `/readyz` to pass before replacing the live app. If a later check
fails, it restores the previous image tag, Compose file, Caddyfile, backup
configuration, and static site.

Migrations run in the candidate before it receives traffic. Production
migrations must still be backward compatible with the previous app release:
automatic rollback intentionally does not rewrite a live database. The
pre-deploy restic snapshot is the recovery point for a manual database restore.

Add these repository **secrets**:

- `VPS_HOST` — the server IP or hostname.
- `VPS_USER` — `deploy`.
- `VPS_SSH_KEY` — a private key whose public half is in
  `/home/deploy/.ssh/authorized_keys`. Generate a dedicated pair:
  `ssh-keygen -t ed25519 -f pitolet_deploy -N ""`, append `pitolet_deploy.pub`
  to the deploy user's `authorized_keys`, and paste `pitolet_deploy` (private)
  as the secret.

Trigger from the Actions tab (**workflow_dispatch**) with the immutable image
tag to deploy, for example `1.1.0`.

## 9. Monthly restore drill

Once a month, restore the latest backup to a throwaway scratch DB and confirm
the dump loads:

```sh
cd /opt/pitolet

# 1. See what's in the repo.
docker compose run --rm backup sh -c \
  'restic snapshots --host pitolet-cloud --tag pitolet-nightly'

# 2. Restore the latest complete nightly snapshot into the persistent
#    backup_restore volume (never into the live asset volume).
docker compose run --rm backup sh -c '
  rm -rf /restore/* &&
  restic restore latest --host pitolet-cloud --tag pitolet-nightly --target /restore &&
  test -s /restore/tmp/pitolet-backup/pitolet.dump &&
  test -d /restore/data &&
  ls -la /restore/data
'

# 3. Load the dump into a scratch database and sanity-check row counts.
docker compose exec postgres sh -c '
  dropdb -U "$POSTGRES_USER" --if-exists pitolet_restore_test &&
  createdb -U "$POSTGRES_USER" pitolet_restore_test
'
docker compose run --rm backup sh -c '
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
    -h postgres -U "$POSTGRES_USER" -d pitolet_restore_test \
    --clean --if-exists --no-owner \
    /restore/tmp/pitolet-backup/pitolet.dump
'
docker compose exec postgres sh -c '
  psql -U "$POSTGRES_USER" -d pitolet_restore_test -c "\dt" &&
  dropdb -U "$POSTGRES_USER" pitolet_restore_test
'

# 4. Remove the decrypted restore from the VPS after the drill.
docker compose run --rm backup sh -c 'rm -rf /restore/*'
```

If every step succeeds and the tables/rows look right, the backup chain is
sound. Record the drill date and snapshot ID. If a step fails, remove the
scratch database and `/restore/*` before retrying.
