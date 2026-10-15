#!/bin/sh
# Runs every deploy scenario test; each test runs in its own process and temp dir.
cd "$(dirname "$0")"
pass=0; failed=0
for t in ./*.test.sh; do
  if sh "$t" > "/tmp/deploy-test-$$.log" 2>&1; then pass=$((pass+1)); echo "ok   $t"; else failed=$((failed+1)); echo "FAIL $t"; sed 's/^/     /' "/tmp/deploy-test-$$.log"; fi
done
rm -f "/tmp/deploy-test-$$.log"
echo "$pass passed, $failed failed"; [ "$failed" -eq 0 ]
