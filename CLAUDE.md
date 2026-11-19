# ProfitIndex

Inventory, purchasing and ledger app (Fastify + Prisma + React/Mantine PWA). Everything lives in `v2/`; `PRODUCT.md` is the product brief.

- Live: Dell, `/opt/stockroom/v2/deploy` (docker compose, Cloudflare quick tunnel, `profitindex-autodeploy.timer`). Deploy = `v2/deploy/update.sh`.
- This folder is the working copy. Branch `profitindex` descends from the deployed commit with v1 (backend/, frontend/, Render/Fly/Railway files) removed; v1 and the 10-08 plans are archived in the vault at `projects/profitindex-archive/`.
- Docs for new users: `v2/docs/help/*.md` (loaded into the help assistant's prompt). Design: `v2/DESIGN.md`. Deploy: `v2/deploy/README.md`.
- Tests: `cd v2 && npm ci && (cd apps/api && npx prisma generate) && npm test -w @pi/domain` (npm ci does not generate the Prisma client; both Grok jobs on 2026-11-09 lost minutes to it); API tests: `cd v2 && docker compose up -d db` (dev Postgres on :5432, never the live DB); each branch gets its own `profitindex_test_<branch>` DB, schema dropped every run; an explicit `TEST_DATABASE_URL` wins. `sh .claude/verify.sh` runs domain + API tests.
- State and history: vault `topics/profitindex.md`.
