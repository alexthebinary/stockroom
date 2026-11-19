#!/bin/sh
set -eu
cd "$(dirname "$0")/../v2"

npm test -w @pi/domain
if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  exec npm test -w @pi/api
fi
echo "API tests skipped: pg_isready could not confirm Postgres at localhost:5432."
