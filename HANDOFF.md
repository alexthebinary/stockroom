# Stockroom — handoff

**As of 2026-09-21.** Live at https://stockroom-axlo.onrender.com, `master` deployed
and verified in a browser. Local dev may still be running on 4000/5173.

> Durable narrative lives in the vault (`logs/2026-09-19-stockroom-serials-receiving-shopify.md`,
> `logs/2026-09-21-stockroom-launch-and-about.md`, `proposals/2026-09-19-stockroom-upgrade-scope.md`).
> This file is operational state only — what is running, what is half-built, what will bite.

## Credentials

| | |
|---|---|
| Production basic auth | `demo` / `8nW16h29fiRSQEyyzLIs` |
| Production app login | `admin@stockroom.local` / `sP_7oe_bp1uJohd-ig_dAV0i` |
| Local app login | `admin@user.com` / password printed in the startup log |

🔴 **The login form prefills `demo@user.com` / `password` and prints it as a hint.
That account exists in NEITHER database.** It is misinformation baked into the UI and it
already cost a day — it was quoted into a design brief as current. Worth deleting.

Production credentials live in Render env vars (`ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`AUTH_SECRET`), so they survive deploys. Locally `AUTH_SECRET` is unset, so **restarting
the API logs you out** — expected, not a bug.

## Running it

```bash
cd ~/Desktop/Projects/inventory-demo
(cd backend && DATABASE_URL="file:$PWD/prisma/dev.db" npx prisma migrate deploy)  # if behind
npm run dev            # api :4000, web :5173
cd backend && npx vitest run     # 76 tests, 13 suites
cd frontend && npm run build     # the only real typecheck
```

⚠️ To stop it, kill by PORT (`ss -ltnp | grep -E ':4000|:5173'`). **Do NOT
`pkill -f "tsx watch"`** — the pattern matches your own shell and kills it (exit 144).

Deploy — auto-deploy is configured but NOT wired (service was created via the API, so no
GitHub webhook exists). Pushing alone does nothing:

```bash
git push origin master
curl -X POST -H "Authorization: Bearer $(cat ~/.config/render/api-key)" \
  https://api.render.com/v1/services/srv-dahgg0u7bikc73fq5j2g/deploys
```

Postgres takes the schema via `db push` (`backend/docker-entrypoint.sh:15`), **not** the
SQLite migration history — the two cannot share migrations.

## 🔴 Hard date

**The Render Postgres expires `2026-10-10T19:40:40Z`.** Read from the instance, not
inferred. Any real receiving data entered before then dies with it. This decision gets
harder the more real data exists, so it is a "decide early" item, not a "deal with it
later" one.

## What is built and working

- **Serialised inventory** — `Product.trackingMode: NONE | SERIAL`, one cost layer per
  unit with `SerialUnit.lotId` pointing at it, so "in-stock serials == onHandQty" holds by
  construction. Ship and adjust branch on it and consume NAMED units.
- **Repair / RMA** — intake posts nothing and holds no cost layer (a customer's unit is not
  our asset). Parts post Dr 5300 Repair Parts / Cr 1200 Inventory, never COGS. Warranty
  derived from a policy, never stored.
- **Camera receiving** — `/receive`, viewfinder stays open between scans, `BarcodeDetector`
  plus up to two server-side vision models. Agreement counted by MODEL FAMILY.
- **Shopify** — outbound quantity only, `inventorySetQuantities` compare-and-set with
  re-read and retry. Ships with a simulator; live needs `SHOPIFY_MODE=live` explicitly.
- **76 tests**, from zero on 2026-09-19.

## Next, in order

1. **Shopify link UI.** `ShopifyLink` / `ShopifyLocation` rows have no way to be created,
   so `POST /shopify/push` returns `unlinked`. This is the only thing between here and a
   complete dock-to-storefront demo.
2. **Camera on a real phone.** `getUserMedia` needs hardware, so this path has NO automated
   test — the only part of the build with nothing behind it. Needs HTTPS (Render provides
   it; `localhost` also works).
3. ⚠️ **Verify the serial regex patterns** in `backend/src/serial_intake.ts` against real
   Unitree / BambuLab / XAG labels. They are my guesses and they drive OCR auto-correction,
   so a wrong pattern turns a good read into a *confident bad one*. Five minutes with a few
   boxes, highest value per minute of anything here.
4. **Role-split UI** — `ROLES` already has VIEWER / WAREHOUSE / FINANCE / ADMIN enforced
   server-side; the 17 flat pages do not reflect it. "Manager" from the scope is not yet a
   capability, only a name.

## Known defects, deliberately unfixed

- **400-vs-409 on a lost FIFO race.** A picker who loses a concurrent race is told "only N
  units are costed — receive stock through a purchase order", i.e. a retryable failure
  reported as permanent with misleading advice. Documented in
  `backend/test/fifo-concurrency.test.ts`. Undecided because "out of stock" and "lost a
  race" are indistinguishable from one read; the fix is a design choice, not a status
  change. **Matters more once several technicians pick at once.**
- **Serialised transfers are refused outright.** A transfer consumes and recreates the cost
  layer, which would sever the serial↔lot link. Operator decision 2026-09-19.
- **5 tables undocumented on `/about`**: DocumentCounter, LedgerSetting, StockCount,
  StockCountLine, User. Pre-existing.

## Traps this project has already sprung

- **Test at the boundary a real caller crosses.** `trackingMode` was readable in six places
  and writable in none (zod drops unknown keys silently) — 72 tests passed because they all
  set it via Prisma. Then `/receive` shipped rendering a blank page because every endpoint
  was checked with curl and nobody opened the browser. Same mistake, one layer apart.
- **Response shapes differ between endpoints.** `/warehouses` is paginated
  (`{data, total}`); `/receiving/expected` is a bare array. `Receive.tsx` has a `rows()`
  helper that accepts either.
- **`npm run build` is the only real typecheck** — `tsc --noEmit` alone has missed things.
