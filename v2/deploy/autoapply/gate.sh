#!/bin/sh
# gate.sh <v2 dir>: check a disposable copy against a disposable database.
set -eu
V2="$1"; ID=$$; NET="pitest-$ID"; DB="pitest-db-$ID"; NODE="pitest-node-$ID"; S=$(mktemp -d)
# Cleanup never changes the verdict: keep the real exit code (with set -e, a failing rm here would turn a pass into exit 1).
trap 'st=$?; docker rm -fv "$NODE" "$DB" >/dev/null 2>&1 || :; docker network rm "$NET" >/dev/null 2>&1 || :; rm -rf "$S" 2>/dev/null || :; exit $st' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$S/v2" "$S/results"
tar -C "$V2" --exclude=node_modules --exclude=.env --exclude=clarify-worker -cf "$S/source.tar" .
tar -C "$S/v2" -xf "$S/source.tar"
for check in tsc-api tsc-web test build; do echo 1 > "$S/results/$check.rc"; done
docker network create "$NET" >/dev/null
docker run -d --network "$NET" --name "$DB" --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=profitindex -e POSTGRES_PASSWORD=profitindex -e POSTGRES_DB=profitindex_test postgres:16 -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
for _ in $(seq 1 30); do
  docker exec "$DB" pg_isready -U profitindex >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$DB" pg_isready -U profitindex >/dev/null 2>&1
DOCKERFILE="$(dirname "$0")/gate.Dockerfile"
IMAGE_HASH=$(sha256sum < "$DOCKERFILE")
IMAGE="pi-gate:$(printf '%.12s' "$IMAGE_HASH")"
if docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" - < "$DOCKERFILE"; then
  docker run --rm --network "$NET" --name "$NODE" -v "$S/v2:/app" -v "$S/results:/results" -w /app \
    -v pi-gate-npm-cache:/root/.npm \
    -e DATABASE_URL="postgresql://profitindex:profitindex@$DB:5432/profitindex_test" \
    -e HOST_IDS="$(id -u):$(id -g)" \
    -e TEST_DATABASE_URL="postgresql://profitindex:profitindex@$DB:5432/profitindex_test" \
    "$IMAGE" sh -c '
    trap "chown -R \"\$HOST_IDS\" /app /results" EXIT   # whatever happens, the host can delete what we made
    set -e
    npm ci --workspace=@pi/domain --workspace=@pi/api --workspace=@pi/web --include-workspace-root
    npm run generate -w @pi/api
    set +e
    npx tsc -p apps/api/tsconfig.json
    echo $? > /results/tsc-api.rc
    npx tsc -p apps/web/tsconfig.json
    echo $? > /results/tsc-web.rc
    npm test
    echo $? > /results/test.rc
    npm run build -w @pi/web
    echo $? > /results/build.rc
  ' || :
fi
TSC_API=$(cat "$S/results/tsc-api.rc")
TSC_WEB=$(cat "$S/results/tsc-web.rc")
TEST=$(cat "$S/results/test.rc")
BUILD=$(cat "$S/results/build.rc")
echo "tsc-api=$TSC_API tsc-web=$TSC_WEB test=$TEST build=$BUILD"
[ "$TSC_API" = 0 ] && [ "$TSC_WEB" = 0 ] && [ "$TEST" = 0 ] && [ "$BUILD" = 0 ]
