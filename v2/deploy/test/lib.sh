# Shared helpers for deploy scenario tests. Real git, stubbed docker/curl, everything under a temp dir.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SRC_DEPLOY=$(cd "$HERE/.." && pwd)
STUBS="$HERE/stubs"
fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3: expected [$1] got [$2]"; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }
assert_no_file() { [ ! -e "$1" ] || fail "unexpected $1"; }
assert_contains() { grep -qF -- "$2" "$1" || fail "$1 lacks [$2]"; }
calls() { cat "$T/calls.$1" 2>/dev/null || true; }
set_health_build() { echo "$1" > "$T/health-build"; }
setup() {
  T=$(mktemp -d); export T
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/repo" 2>/dev/null
  mkdir -p "$T/repo/v2"; cp -R "$SRC_DEPLOY" "$T/repo/v2/deploy"; rm -rf "$T/repo/v2/deploy/test" "$T/repo/v2/deploy/backups" "$T/repo/v2/deploy/.env"
  printf 'NOTIFY_URL=https://ntfy.example/t\n' > "$T/repo/v2/deploy/.env"
  printf '.env\nbackups/\n.deployed\n.failed\n' > "$T/repo/v2/deploy/.gitignore"
  git -C "$T/repo" -c user.email=t@t -c user.name=t add -A >/dev/null
  git -C "$T/repo" -c user.email=t@t -c user.name=t commit -qm "base"
  git -C "$T/repo" push -q origin main
  git clone -q "$T/origin.git" "$T/other"
  git -C "$T/repo" rev-parse HEAD > "$T/repo/v2/deploy/.deployed"
  export DEPLOY="$T/repo/v2/deploy" PI_STATE_DIR="$T/state" PATH="$STUBS:$PATH" HEALTH_WAIT_S=6 HEALTH_POLL_S=1
  mkdir -p "$PI_STATE_DIR"
  set_health_build "$(git -C "$T/repo" rev-parse --short=7 HEAD)"
}
commit_remote() {
  git -C "$T/other" pull -q --ff-only
  git -C "$T/other" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$1"
  git -C "$T/other" push -q origin main
  git -C "$T/other" rev-parse HEAD
}
teardown() { rm -rf "$T"; }
