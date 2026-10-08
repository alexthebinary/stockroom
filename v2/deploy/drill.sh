#!/bin/sh
# Restore drill: prove a backup is good without touching the live database.
# Restores it into a scratch database, starts a throwaway copy of the app on
# it, prints the books check, then cleans up.
#
#   ./drill.sh                                       # the newest local dump
#   ./drill.sh backups/profitindex-20261008-0230.dump
set -eu
cd "$(dirname "$0")"
file="${1:-$(ls -1t backups/profitindex-*.dump 2>/dev/null | head -n 1)}"
[ -n "$file" ] && [ -f "$file" ] || { echo "no dump found: run a backup first" >&2; exit 1; }
dump="$(basename "$file")"
mkdir -p backups
cmp -s "$file" "backups/$dump" || cp "$file" "backups/$dump"

cleanup() {
  docker rm -f profitindex-drill >/dev/null 2>&1 || true
  docker compose exec -T db dropdb -U profitindex --if-exists profitindex_drill || true
}
trap cleanup EXIT

cleanup
docker compose exec -T db createdb -U profitindex profitindex_drill
docker compose --profile backup run --rm -e PGDATABASE=profitindex_drill --entrypoint restore-db.sh backup "/backups/$dump"
docker compose run -d --rm --no-deps --name profitindex-drill -p 127.0.0.1:4101:4100 --entrypoint sh app \
  -c 'DATABASE_URL="${DATABASE_URL%/*}/profitindex_drill" exec node apps/api/dist/server.js' >/dev/null

for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4101/api/health >/dev/null 2>&1 && break
  sleep 2
done
check=$(curl -fsS http://127.0.0.1:4101/api/books/check)
echo "books check on the restored copy of $dump:"
echo "$check"
case "$check" in
  *'"sound":true'*) echo "drill passed" ;;
  *) echo "drill FAILED: the restored books are not sound" >&2; exit 1 ;;
esac
