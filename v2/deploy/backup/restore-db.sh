#!/bin/sh
# Restore a dump into $PGDATABASE (connection from PG* variables). This
# REPLACES the database's contents. Used by ../restore.sh, which stops the
# app first; can also restore into a scratch database for a drill.
set -eu
file="${1:?usage: restore-db.sh <dump-file>}"
pg_restore --list "$file" >/dev/null
pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction --dbname="$PGDATABASE" "$file"
echo "restored $(basename "$file") into $PGDATABASE"
