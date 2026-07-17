#!/bin/sh
set -eu
set -o pipefail
umask 077

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

STAGE=/tmp/pitolet-backup
RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-/tmp/restic-cache}
MAINTENANCE_STAMP=/restore/.last-restic-maintenance
BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}
export RESTIC_CACHE_DIR

case "$BACKUP_INTERVAL_SECONDS" in
  ''|*[!0-9]*)
    echo "[backup] BACKUP_INTERVAL_SECONDS must be an integer" >&2
    exit 2
    ;;
esac
if [ "$BACKUP_INTERVAL_SECONDS" -lt 300 ]; then
  echo "[backup] BACKUP_INTERVAL_SECONDS must be at least 300 seconds" >&2
  exit 2
fi

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

if [ "$#" -gt 0 ] && [ "$1" != "once" ]; then
  exec "$@"
fi

initialise_repository() {
  if restic cat config >/dev/null 2>&1; then
    return
  fi
  echo "[backup] repository is not readable; attempting first-time initialization"
  restic init
}

run_backup() {
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  echo "[backup] $(date -u +%FT%TZ) creating database dump"
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    -h postgres \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Fc \
    -f "$STAGE/pitolet.dump"
  test -s "$STAGE/pitolet.dump"
  pg_restore --list "$STAGE/pitolet.dump" >/dev/null
  test -d /data

  echo "[backup] writing one consistent database-and-assets snapshot"
  restic backup "$STAGE/pitolet.dump" /data \
    --host pitolet-cloud \
    --tag pitolet-nightly
  date -u +%FT%TZ > /tmp/last-backup
}

run_maintenance_if_due() {
  now=$(date +%s)
  last=0
  if [ -f "$MAINTENANCE_STAMP" ]; then
    last=$(cat "$MAINTENANCE_STAMP" 2>/dev/null || echo 0)
  fi
  case "$last" in
    ''|*[!0-9]*) last=0 ;;
  esac
  if [ $((now - last)) -lt 604800 ]; then
    return
  fi

  echo "[backup] checking repository metadata before retention"
  restic check
  echo "[backup] applying retention policy"
  restic forget \
    --host pitolet-cloud \
    --tag pitolet-nightly \
    --keep-daily 14 \
    --keep-weekly 8 \
    --prune
  printf '%s\n' "$now" > "$MAINTENANCE_STAMP"
}

initialise_repository

if [ "${1:-}" = "once" ]; then
  run_backup
  restic snapshots --host pitolet-cloud --tag pitolet-nightly --latest 1
  exit 0
fi

while true; do
  run_backup
  run_maintenance_if_due
  sleep "$BACKUP_INTERVAL_SECONDS"
done
