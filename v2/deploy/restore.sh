#!/bin/sh
# Restore ProfitIndex from a backup, on the Dell.
#
#   ./restore.sh backups/profitindex-20261008-0230.dump    # a local dump
#   ./restore.sh profitindex-20261008-0230.dump            # fetched from R2
#
# Stops the app, replaces the database, starts the app, and ends by printing
# the books check — a restore isn't done until the books are proved sound.
set -eu
cd "$(dirname "$0")"
name="${1:?usage: ./restore.sh <dump file, or its name in R2>}"

if [ -f "$name" ]; then
  dump="$(basename "$name")"
  mkdir -p backups
  cmp -s "$name" "backups/$dump" || cp "$name" "backups/$dump"
else
  dump="$name"
  echo "fetching $dump from R2…"
  docker compose --profile backup run --rm --entrypoint sh backup -c 'rclone copyto "r2:$R2_BUCKET/$0" "/backups/$0"' "$dump"
fi

printf 'This replaces the live database with %s. Type RESTORE to continue: ' "$dump"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "cancelled"; exit 1; }

docker compose stop app
docker compose --profile backup run --rm --entrypoint restore-db.sh backup "/backups/$dump"
docker compose start app

echo "waiting for the app…"
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4100/api/health >/dev/null 2>&1 && break
  sleep 2
done
echo "books check:"
curl -fsS http://127.0.0.1:4100/api/books/check
echo
