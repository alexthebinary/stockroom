#!/bin/sh
# Run every few minutes by systemd/profitindex-autodeploy.timer: when the
# branch has a commit that hasn't been deployed yet, update (back up, pull,
# rebuild). The tunnel keeps running, so the link stays the same.
set -eu
cd "$(dirname "$0")"
branch=$(git rev-parse --abbrev-ref HEAD)
git fetch --quiet origin "$branch"
target=$(git rev-parse "origin/$branch")
# The last commit that deployed successfully: a failed build is retried next run.
[ "$(cat .deployed 2>/dev/null || true)" = "$target" ] && exit 0
echo "deploying $(git rev-parse --short "$target")"
./update.sh
echo "$target" > .deployed
