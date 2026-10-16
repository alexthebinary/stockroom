. "$(dirname "$0")/lib.sh"
short() { git -C "$T/repo" rev-parse --short=7 "$1"; }
commit_file_remote() {
  git -C "$T/other" pull -q --ff-only || fail "pull before file commit"
  printf '%s\n' "$1" > "$T/other/fix.txt" || fail "write fix file"
  git -C "$T/other" add fix.txt || fail "add fix file"
  git -C "$T/other" -c user.email=t@t -c user.name=t commit -qm "$1" || fail "commit fix file"
  git -C "$T/other" push -q origin main || fail "push file commit"
  git -C "$T/other" rev-parse HEAD
}

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

# Run both regressions even when the first one fails.
h_failed=0
# H1: revert of a fix in the same range; unrelated fixes must still be marked done.
(
  setup; touch "$T/health-follows-up"
  trap teardown EXIT
  fix=$(commit_file_remote "fix: thing (feedback #7)") || fail "create non-empty fix"
  git -C "$T/other" -c user.email=t@t -c user.name=t revert --no-edit "$fix" || fail "revert fix"
  git -C "$T/other" push -q origin main || fail "push revert"
  commit_remote "fix: other (feedback #8)" >/dev/null || fail "commit unrelated fix"
  sh "$DEPLOY/autodeploy.sh" || fail "H1: autodeploy exit"
  calls curl | grep -q '^PUSH Deployed ' || fail "H1: no Deployed push"
  calls curl | grep -qx 'PATCH 8' || fail "H1: unrelated feedback #8 not marked done"
  # The stub records PATCH calls, not push bodies: use this to check the reverted fix.
  if calls curl | grep -qx 'PATCH 7'; then fail "H1: reverted feedback #7 marked done"; fi
) || h_failed=1

# H2: health budget includes request time, not just the sleeps between requests.
(
  setup
  trap teardown EXIT
  export HEALTH_WAIT_S=3 HEALTH_POLL_S=1
  echo 2 > "$T/health-delay"
  commit_remote "feat: slow health" >/dev/null || fail "commit slow-health candidate"
  started=$(date +%s)
  status=0
  sh "$DEPLOY/autodeploy.sh" || status=$?
  elapsed=$(($(date +%s) - started))
  [ "$status" -ne 0 ] || fail "H2: stale health should exit non-zero"
  [ "$elapsed" -le $((3 + 3)) ] || fail "H2: health budget exceeded: ${elapsed}s > 6s"
) || h_failed=1

# Run both M regressions even when either one or an H regression fails.
m_failed=0
# M1: done scan reads every number, including Oxford commas and ampersands.
(
  setup; touch "$T/health-follows-up"
  trap teardown EXIT
  commit_remote "fix: a (feedback #11, #12, and #13)" >/dev/null || fail "M1: commit first fix"
  commit_remote "fix: b (feedback #14 & #15)" >/dev/null || fail "M1: commit second fix"
  sh "$DEPLOY/autodeploy.sh" || fail "M1: autodeploy exit"
  assert_eq "PATCH 11
PATCH 12
PATCH 13
PATCH 14
PATCH 15" "$(calls curl | grep '^PATCH' | sort)" "M1: done scan reads every number"
) || m_failed=1

# M2: a backup in the same minute is not a failure (the dump name is reused).
(
  setup; touch "$T/health-follows-up" "$T/backup-fixed-name"
  trap teardown EXIT
  first=$(commit_remote "feat: first same-minute deploy") || fail "M2: commit first candidate"
  sh "$DEPLOY/autodeploy.sh" || fail "M2: first deploy exit"
  assert_eq "$first" "$(cat "$DEPLOY/.deployed")" "M2: first deployed sha"
  assert_file "$DEPLOY/backups/profitindex-fixed.dump"
  second=$(commit_remote "feat: second same-minute deploy") || fail "M2: commit second candidate"
  status=0
  sh "$DEPLOY/autodeploy.sh" || status=$?
  assert_eq 0 "$status" "M2: second deploy exit"
  assert_eq "$second" "$(cat "$DEPLOY/.deployed")" "M2: second deployed sha"
  if calls curl | grep -q '^PUSH Deploy failed'; then fail "M2: unexpected Deploy failed push"; fi
) || m_failed=1

[ "$h_failed" -eq 0 ] && [ "$m_failed" -eq 0 ] || fail "new deploy regressions failed"
echo "deploy scenarios ok"
