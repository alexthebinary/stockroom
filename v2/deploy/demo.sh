#!/bin/sh
# Try ProfitIndex before any Cloudflare setup, on any machine with Docker:
# the app on a fresh database, plus a temporary https://….trycloudflare.com
# address so a phone can open it (phones only allow the camera over HTTPS).
# No Cloudflare account and no .env needed.
#
#   ./demo.sh          start, and print the phone address (Ctrl-C drops the address)
#   ./demo.sh reset    wipe the demo's data and start again as a fresh install
#   ./demo.sh stop     stop the demo
#
# The demo keeps its own database, apart from the real install, and uses the
# same port; stop it before going live.
set -eu
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=profitindex-demo
# Only so compose.yaml can be read: the demo's database is never on the network,
# and the demo uses a quick tunnel instead of a named one.
export POSTGRES_PASSWORD=demo TUNNEL_TOKEN=unused-by-the-demo

case "${1:-start}" in
  start) ;;
  reset) docker compose down --volumes ;;
  stop) docker compose down; exit 0 ;;
  *) echo "usage: ./demo.sh [start|reset|stop]" >&2; exit 2 ;;
esac

docker compose up -d --build --wait db app
echo
echo "The app is running. Asking Cloudflare for a temporary https address…"
echo "Open the https://….trycloudflare.com address printed below on a phone."
echo
exec docker run --rm --network profitindex-demo_default cloudflare/cloudflared:2026.9.3 \
  tunnel --no-autoupdate --url http://app:4100
