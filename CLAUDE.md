# ProfitIndex

Inventory, purchasing and ledger app (Fastify + Prisma + React/Mantine PWA). Everything lives in `v2/`; `PRODUCT.md` is the product brief.

- Live: Dell, `/opt/stockroom/v2/deploy` (docker compose, Cloudflare quick tunnel, `profitindex-autodeploy.timer`). Deploy = `v2/deploy/update.sh`.
- This folder is the working copy. Branch `profitindex` descends from the deployed commit with v1 (backend/, frontend/, Render/Fly/Railway files) removed; v1 and the 10-08 plans are archived in the vault at `projects/profitindex-archive/`.
- Docs for new users: `v2/docs/help/*.md` (loaded into the help assistant's prompt). Design: `v2/DESIGN.md`. Deploy: `v2/deploy/README.md`.
- Tests: `cd v2 && npm ci && npm test -w @pi/domain`; API tests need a THROWAWAY Postgres via `TEST_DATABASE_URL` (the setup drops the schema; never point it at the live DB).
- State and history: vault `topics/profitindex.md`.
