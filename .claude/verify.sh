#!/bin/sh
set -eu
cd "$(dirname "$0")/../v2"

npm test -w @pi/domain
# pg_isready is not installed on every host; node is.
if node -e 'require("net").connect(5432, "localhost").on("connect", () => process.exit(0)).on("error", () => process.exit(1))' 2>/dev/null; then
  exec npm test -w @pi/api
fi
echo "API tests skipped: nothing listening on at localhost:5432."
