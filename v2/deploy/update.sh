#!/bin/sh
# Update ProfitIndex on the Dell: back up first, then pull and rebuild.
# Migrations apply when the app starts; phones get the new version on their
# next open. The tunnel is left running, so a temporary address normally stays.
set -eu
cd "$(dirname "$0")"
docker compose --profile backup run --rm backup
git pull --ff-only
docker compose up -d --build
docker compose --profile backup build --quiet backup
docker compose ps
./url.sh
