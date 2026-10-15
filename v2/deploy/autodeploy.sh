#!/bin/sh
# Run every few minutes by the profitindex-autodeploy unit: when the branch has a
# commit that isn't live yet, deploy exactly that commit and record it only once
# the running app reports it (GET /api/health → build).
#
# Shared with the daily auto-apply job: the deploy lock, and the HALT flag
# (a SHA = refuse that release and anything on top of it; * = refuse everything).
# Commits that say "feedback #12" (or "#4, #5 and #6") mark those notes done once
# they're live; reverts and commits with an "Auto-apply:" trailer are skipped
# (the job completes its own notes). With NOTIFY_URL in .env, results are pushed.
set -eu
# This script is replaced by the very deploys it runs: run from a private copy,
# keeping the real deploy directory (the copy's own $0 lives in /tmp).
AUTODEPLOY_DIR="${AUTODEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
if [ -z "${AUTODEPLOY_COPY:-}" ]; then
  copy=$(mktemp); cp "$0" "$copy"
  status=0; AUTODEPLOY_COPY=1 AUTODEPLOY_DIR="$AUTODEPLOY_DIR" sh "$copy" "$@" || status=$?
  rm -f "$copy"; exit $status
fi
cd "$AUTODEPLOY_DIR"
STATE_DIR="${PI_STATE_DIR:-$HOME/.local/state}"
HALT="$STATE_DIR/profitindex-autoapply/HALT"
mkdir -p "$STATE_DIR"
exec 9> "$STATE_DIR/profitindex-deploy.lock"
flock -n 9 || { echo "another deploy holds the lock"; exit 0; }

NOTIFY_URL=$(sed -n 's/^NOTIFY_URL=//p' .env 2>/dev/null | tail -n 1)
push() {
  [ -n "$NOTIFY_URL" ] || return 0
  curl -fsS -m 10 -H "Title: $1" -d "$2" "$NOTIFY_URL" >/dev/null 2>&1 || true
}

branch=$(git rev-parse --abbrev-ref HEAD)
git fetch --quiet origin "$branch"
target=$(git rev-parse "origin/$branch")
previous=$(cat .deployed 2>/dev/null || true)
[ "$previous" = "$target" ] && exit 0
short=$(git rev-parse --short=7 "$target")
subject=$(git log -1 --format=%s "$target")

if [ -e "$HALT" ]; then
  halted=$(cat "$HALT")
  if [ "$halted" = "*" ] || git merge-base --is-ancestor "$halted" "$target" 2>/dev/null; then
    echo "halted: $short not deployed (HALT=$halted)"
    if [ "$(cat .halted 2>/dev/null || true)" != "$target" ]; then
      push "Deploy halted" "$short ($subject) was not deployed: auto-apply is halted ($halted). Resolve, then remove $HALT."
      echo "$target" > .halted
    fi
    exit 0
  fi
fi

fail() {
  if [ "$(cat .failed 2>/dev/null || true)" != "$target" ]; then
    push "Deploy failed" "$short ($subject): $1. Details: journalctl -u profitindex-autodeploy"
    echo "$target" > .failed
  fi
  exit 1
}

echo "deploying $short"
./update.sh "$target" || fail "the update did not finish; the previous version may still be running"

# Recorded only once the running app says it is this build.
waited=0
until [ "$(curl -fsS -m 5 http://127.0.0.1:4100/api/health 2>/dev/null | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')" = "$short" ]; do
  [ "$waited" -ge "${HEALTH_WAIT_S:-300}" ] && fail "the app did not come back on $short within ${HEALTH_WAIT_S:-300}s"
  sleep "${HEALTH_POLL_S:-3}"; waited=$((waited + ${HEALTH_POLL_S:-3}))
done
echo "$target" > .deployed
rm -f .failed .halted

fixed=""
if [ -n "$previous" ] && git cat-file -e "$previous" 2>/dev/null; then
  for c in $(git rev-list "$previous..$target"); do
    git log -1 --format=%s "$c" | grep -q '^Revert' && continue
    git log -1 --format=%B "$c" | grep -q '^Auto-apply:' && continue
    for id in $(git log -1 --format=%B "$c" | grep -oiE 'feedback #[0-9]+((, *| and )#[0-9]+)*' | grep -oE '[0-9]+'); do
      case " $fixed " in *" #$id "*) continue ;; esac
      curl -fsS -m 10 -X PATCH -H 'content-type: application/json' -d '{"status":"DONE"}' "http://127.0.0.1:4100/api/feedback/$id" >/dev/null 2>&1 && fixed="$fixed #$id"
    done
  done
fi
push "Deployed $short" "$subject${fixed:+
Fixed:$fixed}"
echo "deployed $short${fixed:+, fixed$fixed}"
