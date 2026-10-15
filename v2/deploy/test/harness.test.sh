. "$(dirname "$0")/lib.sh"
setup
sha=$(commit_remote "hello")
assert_eq "$sha" "$(git -C "$T/origin.git" rev-parse main)" "remote commit"
docker compose --profile backup run --rm backup
ls "$DEPLOY/backups/"profitindex-*.dump >/dev/null || fail "stub made no dump"
assert_eq "$(cat "$T/health-build")" "$(curl -fsS http://127.0.0.1:4100/api/health | sed 's/.*"build":"\([^"]*\)".*/\1/')" "health stub"
teardown
