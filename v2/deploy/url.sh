#!/bin/sh
# Print the address the app is on right now.
#
# With no TUNNEL_TOKEN the address is a temporary https://….trycloudflare.com
# one. It changes whenever the tunnel restarts (a reboot of the Dell, say), so
# run this again and resend it to testers.
set -eu
cd "$(dirname "$0")"

if [ -n "${TUNNEL_TOKEN:-}" ] || grep -q '^TUNNEL_TOKEN=.' .env 2>/dev/null; then
  echo "The app is on your own domain: the public hostname set for this tunnel in the Cloudflare dashboard."
  exit 0
fi

# A quick tunnel announces its address in its log; the last one is the current one.
for _ in $(seq 1 30); do
  url=$(docker compose logs --no-log-prefix cloudflared 2>/dev/null |
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -n 1 || true)
  if [ -n "$url" ]; then
    echo "The app is at:   $url"
    echo "Test sheet:      $url/test-sheet   (open on a laptop, or print it)"
    exit 0
  fi
  sleep 2
done
echo "No temporary address yet. See what the tunnel says: docker compose logs cloudflared" >&2
exit 1
