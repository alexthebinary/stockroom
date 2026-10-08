#!/bin/sh
# Start ProfitIndex on this machine, in the background, and print its address.
# The first run writes .env with a random database password; later runs keep
# .env as it is. Safe to run again at any time.
#
# With no TUNNEL_TOKEN in .env the app gets a temporary
# https://….trycloudflare.com address. Add your tunnel's token later to move
# to your own domain (README.md, "Your own domain").
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  (umask 077 && sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" .env.example > .env)
  echo "wrote .env with a new database password"
fi

docker compose up -d --build
docker compose --profile backup build --quiet backup
./url.sh
