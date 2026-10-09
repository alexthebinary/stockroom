#!/bin/sh
# Run every few minutes by systemd/profitindex-autodeploy.timer: when the
# branch has a commit that hasn't been deployed yet, update (back up, pull,
# rebuild). The tunnel keeps running, so the link stays the same.
#
# Commits that say "feedback #12" mark that note done once they're live, which
# shows the tester a "fixed" banner. With NOTIFY_URL in .env, each deploy (or
# failed deploy) is pushed to your phone.
set -eu
cd "$(dirname "$0")"
NOTIFY_URL=$(sed -n 's/^NOTIFY_URL=//p' .env 2>/dev/null | tail -n 1)
push() {
  [ -n "$NOTIFY_URL" ] || return 0
  curl -fsS -m 10 -H "Title: $1" -d "$2" "$NOTIFY_URL" >/dev/null 2>&1 || true
}

branch=$(git rev-parse --abbrev-ref HEAD)
git fetch --quiet origin "$branch"
target=$(git rev-parse "origin/$branch")
# The last commit that deployed successfully: a failed build is retried next run.
previous=$(cat .deployed 2>/dev/null || true)
[ "$previous" = "$target" ] && exit 0
short=$(git rev-parse --short "$target")
subject=$(git log -1 --format=%s "$target")
echo "deploying $short"

if ! ./update.sh; then
  # Say so once per commit, not every five minutes.
  if [ "$(cat .failed 2>/dev/null || true)" != "$target" ]; then
    push "Deploy failed" "$short ($subject) did not deploy; the previous version is still running. Details: journalctl -u profitindex-autodeploy"
    echo "$target" > .failed
  fi
  exit 1
fi
echo "$target" > .deployed
rm -f .failed

fixed=""
if [ -n "$previous" ] && git cat-file -e "$previous" 2>/dev/null; then
  for _ in $(seq 1 60); do
    curl -fsS -m 5 http://127.0.0.1:4100/api/health >/dev/null 2>&1 && break
    sleep 2
  done
  for id in $(git log --format=%B "$previous..$target" | grep -oiE 'feedback #[0-9]+' | grep -oE '[0-9]+' | sort -un); do
    curl -fsS -m 10 -X PATCH -H 'content-type: application/json' -d '{"status":"DONE"}' "http://127.0.0.1:4100/api/feedback/$id" >/dev/null 2>&1 && fixed="$fixed #$id"
  done
fi
push "Deployed $short" "$subject${fixed:+
Fixed:$fixed}"
echo "deployed $short${fixed:+, fixed$fixed}"
