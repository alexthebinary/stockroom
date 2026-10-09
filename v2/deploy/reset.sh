#!/bin/sh
# Wipe this install back to a brand-new company: the setup wizard opens again.
# For a beta that testers have played with. A backup is taken first, so
# restore.sh can undo it, and testers' feedback notes are kept.
set -eu
cd "$(dirname "$0")"
printf 'This ERASES the company, its stock and its books on this install (a backup is taken first). Type WIPE to continue: '
read -r answer
[ "$answer" = "WIPE" ] || { echo "cancelled"; exit 1; }

docker compose --profile backup run --rm backup
# Testers' feedback outlives the wipe: set aside now, put back below.
kept="backups/feedback-$(date -u +%Y%m%d-%H%M%S).sql"
docker compose exec -T db pg_dump -U profitindex --data-only -t 'public."Feedback"' profitindex > "$kept" 2>/dev/null || : > "$kept"
# Only the app and its database go: the tunnel keeps running, so a temporary
# address stays the same for testers.
ids=$(docker compose ps -aq app db)
[ -z "$ids" ] || docker rm -f $ids >/dev/null
docker volume rm --force profitindex_pgdata >/dev/null
docker compose up -d --wait
docker compose exec -T db psql -q -U profitindex -d profitindex -v ON_ERROR_STOP=1 < "$kept" >/dev/null
echo "wiped: open the app to run the setup wizard again"
echo "kept $(docker compose exec -T db psql -tA -U profitindex -d profitindex -c 'select count(*) from "Feedback"') feedback note(s)"
./url.sh
