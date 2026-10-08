#!/bin/sh
# Wipe this install back to a brand-new company: the setup wizard opens again.
# For a beta that testers have played with. A backup is taken first, so
# restore.sh can undo it.
set -eu
cd "$(dirname "$0")"
printf 'This ERASES the company, its stock and its books on this install (a backup is taken first). Type WIPE to continue: '
read -r answer
[ "$answer" = "WIPE" ] || { echo "cancelled"; exit 1; }

docker compose --profile backup run --rm backup
docker compose down --volumes     # the database volume; backups/ is kept
docker compose up -d --wait
echo "wiped: open the app to run the setup wizard again"
