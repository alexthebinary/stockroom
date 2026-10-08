#!/bin/sh
# Nightly backup: a pg_dump of the whole database, checked readable, kept on
# the Dell and copied to Cloudflare R2. Connection comes from PG* variables.
# Exits non-zero on any failure, and tells HEALTHCHECK_URL either way.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_LOCAL="${KEEP_LOCAL:-14}"
stamp=$(date -u +%Y%m%d-%H%M)
file="$BACKUP_DIR/profitindex-$stamp.dump"

ping_health() {
  [ -n "${HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL$1" >/dev/null || echo "warning: could not reach the healthcheck URL" >&2
}
trap 'status=$?; rm -f "$file.partial"; [ "$status" -eq 0 ] || ping_health /fail' EXIT

mkdir -p "$BACKUP_DIR"
pg_dump --format=custom --no-owner --file="$file.partial"
# A dump that pg_restore can't list is not a backup.
pg_restore --list "$file.partial" >/dev/null
mv "$file.partial" "$file"
echo "dumped $(basename "$file") ($(du -h "$file" | cut -f1))"

# Keep the newest KEEP_LOCAL dumps on this machine.
ls -1t "$BACKUP_DIR"/profitindex-*.dump 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | while read -r old; do rm -f "$old"; done

# R2 counts as set up once its access key is in .env (the bucket name comes
# pre-filled, so it can't be the signal). Half set up is an error, not a skip.
if [ -n "${RCLONE_CONFIG_R2_ACCESS_KEY_ID:-}" ]; then
  : "${R2_BUCKET:?the R2 keys are set but R2_BUCKET is empty}"
  rclone copyto "$file" "r2:$R2_BUCKET/$(basename "$file")"
  echo "copied to r2:$R2_BUCKET"
else
  echo "warning: R2 isn't set up yet (no R2_ACCESS_KEY_ID in .env), so this backup exists only on this machine" >&2
fi

ping_health ""
