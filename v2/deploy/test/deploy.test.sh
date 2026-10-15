. "$(dirname "$0")/lib.sh"
short() { git -C "$T/repo" rev-parse --short=7 "$1"; }

# exact SHA: a new commit is deployed, recorded after health reports it, receipt names the backup
setup; touch "$T/health-follows-up"
sha=$(commit_remote "feat: one")
sh "$DEPLOY/autodeploy.sh" || fail "autodeploy exit"
assert_eq "$sha" "$(cat "$DEPLOY/.deployed")" "deployed sha"
assert_eq "$sha" "$(git -C "$T/repo" rev-parse HEAD)" "checked out sha"
calls docker | grep -q "up -d --build APP_VERSION=$(short "$sha")" || fail "up without APP_VERSION=$(short "$sha")"
r="$PI_STATE_DIR/profitindex-deploy/receipt-$sha.json"; assert_file "$r"
b=$(sed -n 's/.*"backup":"\([^"]*\)".*/\1/p' "$r"); assert_file "$b"
assert_eq "$(sha256sum "$b" | cut -d' ' -f1)" "$(sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' "$r")" "receipt checksum"
teardown

# moving remote: a push during the backup does not change what is deployed
setup; touch "$T/health-follows-up"
sha=$(commit_remote "feat: chosen")
printf '#!/bin/sh\ngit -C "%s/other" -c user.email=t@t -c user.name=t commit -q --allow-empty -m late && git -C "%s/other" push -q origin main\n' "$T" "$T" > "$T/hook-on-backup"; chmod +x "$T/hook-on-backup"
sh "$DEPLOY/autodeploy.sh" || fail "autodeploy exit"
assert_eq "$sha" "$(git -C "$T/repo" rev-parse HEAD)" "HEAD is the chosen target, not the late push"
assert_eq "$sha" "$(cat "$DEPLOY/.deployed")" "recorded the chosen target"
teardown

# stale build: health never reports the new build -> no .deployed, one alert, .failed set
setup
before=$(cat "$DEPLOY/.deployed"); sha=$(commit_remote "feat: two")
sh "$DEPLOY/autodeploy.sh" && fail "should exit non-zero"
assert_eq "$before" "$(cat "$DEPLOY/.deployed")" ".deployed unchanged"
assert_eq "$sha" "$(cat "$DEPLOY/.failed")" ".failed set"
assert_eq 1 "$(calls curl | grep -c '^PUSH Deploy failed')" "one failure push"
sh "$DEPLOY/autodeploy.sh" || true
assert_eq 1 "$(calls curl | grep -c '^PUSH Deploy failed')" "still one push after retry"
teardown

# no-arg update: the OLD autodeploy calls update.sh with no SHA; it still deploys
setup; touch "$T/health-follows-up"
sha=$(commit_remote "feat: legacy")
(cd "$DEPLOY" && sh ./update.sh) || fail "no-arg update failed"
assert_eq "$sha" "$(git -C "$T/repo" rev-parse HEAD)" "no-arg pulled"
teardown

# halt by ancestry: HALT=<sha> refuses that release and anything on top of it; HALT=* refuses all
setup; touch "$T/health-follows-up"
bad=$(commit_remote "feat: bad release")
mkdir -p "$PI_STATE_DIR/profitindex-autoapply"; echo "$bad" > "$PI_STATE_DIR/profitindex-autoapply/HALT"
on_top=$(commit_remote "fix: ordinary commit on top")
before=$(cat "$DEPLOY/.deployed")
sh "$DEPLOY/autodeploy.sh" || fail "halt should exit 0"
assert_eq "$before" "$(cat "$DEPLOY/.deployed")" "nothing deployed under HALT"
calls docker | grep -q "up -d" && fail "rebuilt under HALT"
assert_eq 1 "$(calls curl | grep -c '^PUSH Deploy halted')" "one halt push"
echo '*' > "$PI_STATE_DIR/profitindex-autoapply/HALT"; sh "$DEPLOY/autodeploy.sh" || fail "halt * exit"
assert_eq "$before" "$(cat "$DEPLOY/.deployed")" "nothing deployed under HALT=*"
teardown

# lock: a held deploy lock means this run does nothing and exits 0
setup
sha=$(commit_remote "feat: locked")
before=$(cat "$DEPLOY/.deployed")
( flock 9; sh "$DEPLOY/autodeploy.sh" ) 9> "$PI_STATE_DIR/profitindex-deploy.lock" || fail "locked run exit"
assert_eq "$before" "$(cat "$DEPLOY/.deployed")" "nothing deployed while locked"
teardown

# done scan: every number, no reverts, no Auto-apply commits
setup; touch "$T/health-follows-up"
commit_remote "feat: items (feedback #4, #5 and #6)" >/dev/null
commit_remote 'feat: auto thing (feedback #9)

Auto-apply: run-20261016' >/dev/null
commit_remote 'Revert "feat: old (feedback #3)"' >/dev/null
sh "$DEPLOY/autodeploy.sh" || fail "autodeploy exit"
assert_eq "PATCH 4
PATCH 5
PATCH 6" "$(calls curl | grep '^PATCH' | sort)" "marked exactly 4, 5, 6"
teardown
# retry keeps the receipt: a failing deploy retried later must not replace its receipt, and the
# receipt's backup survives the backup service pruning backups/
setup
sha=$(commit_remote "feat: migration that breaks the app")
sh "$DEPLOY/autodeploy.sh" && fail "should fail"
r="$PI_STATE_DIR/profitindex-deploy/receipt-$sha.json"; assert_file "$r"
first=$(cat "$r"); b=$(sed -n 's/.*"backup":"\([^"]*\)".*/\1/p' "$r")
case "$b" in "$PI_STATE_DIR"/*) ;; *) fail "receipt backup not pinned under the state dir: $b" ;; esac
sh "$DEPLOY/autodeploy.sh" && fail "retry should fail too"
assert_eq "$first" "$(cat "$r")" "receipt unchanged by the retry"
rm -f "$DEPLOY"/backups/*.dump
assert_file "$b"
assert_eq "$(sha256sum "$b" | cut -d' ' -f1)" "$(sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' "$r")" "pinned backup checksum"
teardown

# halt fails closed: an unknown SHA, an empty file, or a real SHA with CRLF/whitespace all refuse
for content in "0123456789abcdef0123456789abcdef01234567" "" "SPACED"; do
  setup; touch "$T/health-follows-up"
  bad=$(commit_remote "feat: candidate")
  mkdir -p "$PI_STATE_DIR/profitindex-autoapply"
  if [ "$content" = SPACED ]; then printf ' %s\r\n' "$bad" > "$PI_STATE_DIR/profitindex-autoapply/HALT"; else printf '%s' "$content" > "$PI_STATE_DIR/profitindex-autoapply/HALT"; fi
  before=$(cat "$DEPLOY/.deployed")
  sh "$DEPLOY/autodeploy.sh" || fail "halt run exit ($content)"
  assert_eq "$before" "$(cat "$DEPLOY/.deployed")" "nothing deployed under HALT [$content]"
  calls curl | grep -q '^PUSH Deploy halted' || fail "no halt push for [$content]"
  teardown
done
echo "deploy scenarios ok"
