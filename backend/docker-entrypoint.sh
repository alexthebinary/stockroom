#!/bin/sh
# Pick the schema that matches whatever DATABASE_URL points at, so one image
# serves both a Postgres host (Railway, Render) and a SQLite volume (Fly).
set -e

cd /app/backend

case "${DATABASE_URL}" in
  postgres*|postgresql*)
    echo "Database: PostgreSQL"
    SCHEMA="prisma/postgres/schema.prisma"
    # db push creates the schema directly. The SQLite migration history cannot
    # be replayed here (P3019), and for a demo whose schema is settled this is
    # the honest tool — it refuses rather than silently dropping data.
    MIGRATE="npx prisma db push --schema $SCHEMA --skip-generate"
    ;;
  file:*)
    DB_PATH="${DATABASE_URL#file:}"
    echo "Database: SQLite at ${DB_PATH}"
    SCHEMA="prisma/schema.prisma"
    MIGRATE="npx prisma migrate deploy --schema $SCHEMA"
    # A fresh volume is empty, so the directory must exist before migrating.
    mkdir -p "$(dirname "${DB_PATH}")"
    ;;
  *)
    echo "DATABASE_URL is unset or unrecognised. Refusing to start." >&2
    exit 1
    ;;
esac

$MIGRATE
npx prisma generate --schema "$SCHEMA"

# Seed only an empty database, so a restart or redeploy never wipes what
# testers entered. Any failure to count is treated as "not empty" — refusing
# to seed is always the safe direction.
PRODUCTS=$(node -e "
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  prisma.product.count()
    .then((n) => { console.log(n); return prisma.\$disconnect(); })
    .catch(() => { console.log(-1); process.exit(0); });
" 2>/dev/null || echo -1)

if [ "$PRODUCTS" = "0" ]; then
  echo "Empty database — loading demo data."
  npm run seed
else
  echo "Database is not empty (products: ${PRODUCTS}) — skipping seed."
fi

exec npm run start
