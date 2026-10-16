#!/bin/sh
# migration-gate.sh <candidate v2> <base image> <dump>
# The run's migrations apply to a copy of REAL data through the candidate's production startup, and the image
# that is live right now still serves on the upgraded database (so reverting the code is a real recovery).
set -u
CAND="$1"; BASE_IMAGE="$2"; DUMP="$3"; ID=$$; NET="mig-$ID"; DB="migdb-$ID"; IMG="pi-candidate-$ID"; S=$(mktemp -d)
trap 'st=$?; docker rm -f "$DB" "app-$ID" >/dev/null 2>&1 || :; docker network rm "$NET" >/dev/null 2>&1 || :; docker image rm -f "$IMG" >/dev/null 2>&1 || :; rm -rf "$S" 2>/dev/null || :; exit $st' EXIT
docker build -q -t "$IMG" --build-arg APP_VERSION=candidate "$CAND" >/dev/null || { echo "candidate image does not build"; exit 1; }
cp "$DUMP" "$S/db.dump"
docker network create "$NET" >/dev/null
docker run -d --network "$NET" --name "$DB" -e POSTGRES_USER=profitindex -e POSTGRES_PASSWORD=profitindex -e POSTGRES_DB=profitindex -v "$S/db.dump:/db.dump:ro" postgres:16 >/dev/null
for _ in $(seq 1 30); do docker exec "$DB" pg_isready -U profitindex >/dev/null 2>&1 && break; sleep 2; done
docker exec "$DB" pg_restore --no-owner -U profitindex -d profitindex /db.dump || { echo "restore failed"; exit 1; }
curl_() { docker run --rm --network "$NET" curlimages/curl:8.10.1 -s -m 10 "$@"; }
serve_and_smoke() {  # $1 image, $2 label
  docker rm -f "app-$ID" >/dev/null 2>&1
  docker run -d --network "$NET" --name "app-$ID" -e DATABASE_URL="postgresql://profitindex:profitindex@$DB:5432/profitindex" -e PORT=4199 "$1" >/dev/null
  for _ in $(seq 1 60); do curl_ "http://app-$ID:4199/api/health" | grep -q '"ok":true' && break; sleep 2; done
  curl_ "http://app-$ID:4199/api/health" | grep -q '"ok":true' || { echo "$2: not healthy"; docker logs --tail 20 "app-$ID"; return 1; }
  curl_ "http://app-$ID:4199/api/books/check" | grep -q '"sound":true' || { echo "$2: books unsound"; return 1; }
  P=$(curl_ "http://app-$ID:4199/api/profiles" | sed -n 's/^\[{"id":\([0-9]*\).*/\1/p')
  for path in /api/feedback /api/items /api/purchase-orders /api/reports/to-receive; do
    code=$(docker run --rm --network "$NET" curlimages/curl:8.10.1 -s -o /dev/null -w '%{http_code}' -m 10 -H "x-profile: $P" "http://app-$ID:4199$path")
    [ "$code" = 200 ] || { echo "$2: GET $path -> $code"; return 1; }
  done
}
serve_and_smoke "$IMG" "candidate" || exit 1
serve_and_smoke "$BASE_IMAGE" "live image on the upgraded database" || exit 1
echo "migration gate passed"
