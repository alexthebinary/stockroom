#!/bin/sh
# Update ProfitIndex on the Dell: back up first, then move to the commit and rebuild.
#   ./update.sh <sha>   deploy exactly that commit (autodeploy passes the one it chose)
#   ./update.sh         pull the branch tip (by hand, and the previous autodeploy)
# Migrations apply when the app starts; phones get the new version on their next open.
# With a SHA, a receipt names the backup taken just before, so a bad migration can be undone.
set -eu
cd "$(dirname "$0")"
STATE_DIR="${PI_STATE_DIR:-$HOME/.local/state}"
target="${1:-}"

before=$(ls -1t backups/profitindex-*.dump 2>/dev/null | head -n 1 || true)
docker compose --profile backup run --rm backup
dump=$(ls -1t backups/profitindex-*.dump 2>/dev/null | head -n 1 || true)
[ -n "$dump" ] && [ "$dump" != "$before" ] || { echo "the backup made no new dump" >&2; exit 1; }

if [ -n "$target" ]; then
  git fetch --quiet origin
  git merge --ff-only --quiet "$target"
  mkdir -p "$STATE_DIR/profitindex-deploy"
  printf '{"sha":"%s","backup":"%s","sha256":"%s","at":"%s"}\n' \
    "$(git rev-parse "$target")" "$(cd "$(dirname "$dump")" && pwd)/$(basename "$dump")" \
    "$(sha256sum "$dump" | cut -d' ' -f1)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$STATE_DIR/profitindex-deploy/receipt-$(git rev-parse "$target").json"
else
  git pull --ff-only
fi
APP_VERSION=$(git rev-parse --short=7 HEAD) docker compose up -d --build
docker compose --profile backup build --quiet backup
docker compose ps
./url.sh || true
