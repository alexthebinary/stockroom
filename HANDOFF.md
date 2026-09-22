# Stockroom — handoff

**As of 2026-09-22.** Live at https://stockroom-axlo.onrender.com, `master` at `695e427`
deployed and verified in a browser in both colour schemes. Local dev may still be running
on 4000/5173.

> **What this is.** An inventory and warehouse management system with a real general
> ledger, built for the AI age — not a reinvention of accounting. The operator's line,
> stated 2026-09-22: *"we're not looking to reinvent the wheel here, just creating an
> inventory management system fit for the AI age."* Read that before proposing anything
> structural. Where a convention exists (double-entry, FIFO, three-way match), adopt it;
> the novelty budget belongs in the operator's experience — camera receiving, the
> attention list, search — not in the books.

> Durable narrative lives in the vault
> (`logs/2026-09-22-stockroom-dark-mode-and-the-sweep-that-lied.md`,
> `logs/2026-09-21-stockroom-nav-critique-and-outbound-flow.md`,
> `proposals/2026-09-19-stockroom-upgrade-scope.md`).
> This file is operational state only — what is running, what is half-built, what will bite.

## Credentials

| | |
|---|---|
| Production basic auth | `demo` / `8nW16h29fiRSQEyyzLIs` |
| Production app login | `admin@stockroom.local` / `sP_7oe_bp1uJohd-ig_dAV0i` |
| Local app login | `admin@user.com` / password printed in the startup log |

Production credentials live in Render env vars (`ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`AUTH_SECRET`), so they survive deploys. Locally `AUTH_SECRET` is unset, so **restarting
the API logs you out** — expected, not a bug.

`.backups/` is gitignored: it holds password hashes and full `pg_dump`s from the
2026-09-21 reseed to the Unitree / XAG / Bambu Lab catalogue.

🔴 **Unrelated but unresolved: a 21st.dev API key was pasted into a session transcript on
2026-09-21 and is still unrotated.** It is not used by this codebase. Rotate it.

## Running it

```bash
cd ~/Desktop/Projects/inventory-demo
(cd backend && DATABASE_URL="file:$PWD/prisma/dev.db" npx prisma migrate deploy)  # if behind
npm run dev            # api :4000, web :5173
cd backend && npx vitest run     # 171 tests, 23 suites
cd frontend && npm run build     # the only real typecheck
```

⚠️ To stop it, kill by PORT (`ss -ltnp | grep -E ':4000|:5173'`). **Do NOT
`pkill -f "tsx watch"`** — the pattern matches your own shell and kills it (exit 144).

Deploy — **auto-deploy is configured but NOT wired.** The service was created via the API,
so no GitHub webhook exists. Every deploy in the history reads `"trigger":"api"`. Pushing
alone builds nothing:

```bash
git push origin master
curl -X POST -H "Authorization: Bearer $(cat ~/.config/render/api-key)" \
  https://api.render.com/v1/services/srv-dahgg0u7bikc73fq5j2g/deploys
```

Confirm a deploy by the **bundle hash changing**, not by the API's status flag and not by
"an index-*.js exists" — that is true of the old bundle too and it has already fooled me:

```bash
curl -fsS -u demo:PASSWORD https://stockroom-axlo.onrender.com/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
```

Postgres takes the schema via `db push` (`backend/docker-entrypoint.sh:15`), **not** the
SQLite migration history — the two cannot share migrations.

⚠️ **Render Postgres refuses ALL external connections** — `ipAllowList` is empty, which
blocks `psql`, `pg_dump` and Render's own MCP query tool alike (they fail as
`SSL/TLS required`, which reads like a TLS bug and is not). To reach it, PATCH the
allowlist with your public IP, do the work, then PATCH it back to `[]` and prove it with a
refused connection. SSH is not enabled, so there is no inside route.

## 🔴 Hard date

**The Render Postgres expires `2026-10-10T19:40:40Z`** — read from the instance, not
inferred. Any real receiving data entered before then dies with it. $7/mo restores it
intact and adds backups; the free tier has none. Decide early: this gets harder the more
real data exists. A calendar reminder is set for 2026-10-06.

## What is built and working

- **Serialised inventory** — `Product.trackingMode: NONE | SERIAL`, one cost layer per unit
  with `SerialUnit.lotId` pointing at it, so "in-stock serials == onHandQty" holds by
  construction.
- **Repair / RMA** — intake posts nothing and holds no cost layer. Parts post
  Dr 5300 Repair Parts / Cr 1200 Inventory, never COGS.
- **Camera receiving** — `/receive`, viewfinder stays open between scans, `BarcodeDetector`
  plus up to two server-side vision models, agreement counted by MODEL FAMILY.
- **Shopify** — outbound quantity only, compare-and-set with re-read and retry. Simulator
  included; live needs `SHOPIFY_MODE=live` explicitly.
- **Sales-side documents** — invoices, payments, deliveries, for sales made outside Shopify.
- **Dark mode** (2026-09-22) — Mantine owns the switch (`defaultColorScheme="auto"`,
  writes `data-mantine-color-scheme` on `<html>`); `theme.css` keys its tokens off that
  attribute. Appearance picker is in the account menu.
- **171 tests**, from zero on 2026-09-19.

## Next, in order

1. **Sorting on Invoices / Bills / Deliveries / Receipts.** The smallest real job here and
   both halves already exist: `orderByFrom(query, allowed, fallback)` at
   `backend/src/http.ts:58` takes a column allowlist, and `SortableTh` exists in the
   frontend. **Inventory is the only page that wires them together.** Note there is no
   `invoices.ts`/`bills.ts` route file — `/invoices` lives in `salesOrders.ts:148` and
   `/bills` in `purchaseOrders.ts:124`, which is why a filename grep finds nothing.
   ⚠️ The allowlist must contain the column under test or the test passes while the sort
   silently falls back.
2. **Phone tables.** Invoices renders an 860px table in a 390px viewport; 6 of 8 columns
   are off-screen including Total, Paid, Outstanding and Status — every column that
   answers "does this need attention". The page doesn't scroll sideways, so the money is
   simply gone. Card layout below `sm` is the usual answer.
3. **Shopify link UI.** `ShopifyLink` / `ShopifyLocation` rows have no way to be created,
   so `POST /shopify/push` returns `unlinked`.
4. ⚠️ **Verify the serial regex patterns** in `backend/src/serial_intake.ts` against real
   Unitree / BambuLab / XAG labels. They are guesses and they drive OCR auto-correction,
   so a wrong pattern turns a good read into a *confident bad one*. Highest value per
   minute of anything here.
5. **Camera on a real phone.** `getUserMedia` needs hardware, so this path has NO automated
   test.

## The purchase-order status question — read this before scoping it

An earlier ask was "add Billed between Received and Paid". It is **not a status value**.
Verified by review on 2026-09-22 (Fable 5, 25 tool calls):

- **The bill is created when the PO is POSTED, before goods arrive.** Posting books
  `Dr Prepaid Inventory / Cr Accounts Payable` (`purchaseOrders.ts:388`); the receipt
  clears it `Dr Inventory / Cr Prepaid` (`:535`). There is no GRNI account anywhere.
  A conventional three-way match is the opposite order: the *receipt* creates the
  liability, the *bill* clears it. So Billed-after-Received inverts the model and migrates
  live Prepaid balances.
- **`PurchaseOrder.status` is one column carrying two axes.** `purchaseOrders.ts:493`
  writes `PAID` or `DELIVERED` into the same field. Worse: on the receive-then-pay path a
  fully-paid delivered PO is **indistinguishable** from an unpaid delivered one, so
  `?status=DELIVERED` cannot answer "which delivered orders are still unpaid". `SalesOrder`
  already solved this (`schema.prisma:147-149`: `readinessStatus` + `paymentStatus`).
  Mirror that split rather than extending the enum.
- 🔴 **`accounts.ts:76` says the purchase posting rows were "taken verbatim from the
  scope's purchase-order table".** So the current order may be CLIENT-SPECIFIED. **Read the
  governing scope document before treating this as a defect** — if it is specified, this is
  a compliance question, not a design one. Nobody has read that document this session.
- `void-bill` (`purchaseOrders.ts:655-717`) already guards a partial-receipt double-credit
  that drove Prepaid negative once. Any GRNI work reopens that shape.

## GRN aggregation — blocked, do not start casually

A camera scan creates one `GoodsReceipt` per box, so a 200-spool pallet makes 200 receipts.
Aggregating a session is blocked by serials: a serialised product needs one cost layer
**per unit** — `SerialUnit.lotId` is `@unique` (`schema.prisma:699`), `receiveSerials`
refuses a shared layer, `consumeSerials` queries `remainingQty: 1`. One lot of qty N breaks
all three. Reversal also assumes 1:1 receipt-to-entry (`ledger.ts:378-390` uses
`findFirst`), and no session identity exists — `scanSchema` has no batch id.
The `clearedAt` telescoping *does* survive aggregation: it is a pure function of cumulative
units over line quantity, so Prepaid still reaches exactly zero.

Suggested order: sorting → axis split → GRNI and GRN aggregation **together**, since they
touch the same ledger timing and doing them separately means migrating twice.

## Checking the theme — and what no checker can do

```bash
cd backend && npx vitest run test/theme-contract.test.ts   # 28 assertions
```

`backend/test/theme-contract.test.ts` parses `frontend/src/theme.css` and enforces: no
fixed `var(--mantine-color-{gray,dark}-N)` outside the deliberate `--mantine-color-dimmed`
overrides; every colour token present in both light and dark; the `prefers-color-scheme`
fallback matching the attribute block; WCAG AA on declared pairs in both modes.

`frontend/scripts/contrast-sweep.js` sweeps a rendered page. **It is not served by the
build** (`scripts/` is not a Vite asset dir), so paste it into the console rather than
fetching it from the site. Switch scheme the way a user does and **reload** before
sweeping:

```js
localStorage.setItem('mantine-color-scheme-value', 'dark'); location.reload();
// paste the file, then:
contrastSweep();   // needs calibrated:true AND controlCaught:true to mean anything
```

⚠️ **Neither tool can see the defect class that caused the most damage here.** Both compare
text to its own background. Neither can see a chip that is the wrong *lightness* for the
page it sits on — the data-grid status cells passed every contrast check while rendering as
near-white blocks on a dark page. **Open both modes and look at the screen.**

## Traps this project has already sprung

- **A fixed palette shade cannot flip.** `var(--mantine-color-gray-9)` and
  `var(--mantine-color-{hue}-0)` stay put in both schemes. 31 call sites of the first
  shipped a dark mode with 1.14:1 invisible text. Use the semantic ramp
  (`--text-strong`/`--text`/`--text-muted`/`--text-faint`) or Mantine's scheme-aware
  `-light` / `-light-color` / `-filled` variants.
- **You cannot override a Mantine variant colour with a CSS custom property.** Mantine
  computes `--button-color` in JS and writes it inline, so remapping
  `--mantine-color-{hue}-light-color` is dead code. Override `color` on the variant.
- **`getComputedStyle` does not always return `rgb()`.** A `color-mix()` resolves to
  `color(srgb 0.16 0.25 0.59)` — channels 0..1. Any tool scraping numbers reads that as
  near-black and passes it. Adding one `color-mix()` silently blinded the contrast sweep to
  the exact buttons it was added to fix.
- **Do not set `data-mantine-color-scheme` by hand to test both modes.** Mantine's JS owns
  it; you get a mixed state. It reported 3.20:1 for a label that measured 5.38:1.
- **Pin every metric helper to a known answer.** A luminance function missing `srgb()` on
  the blue channel produced eleven impossible failures that looked like real bugs.
- **Prove a check can fail.** Plant a known-bad element and assert it is caught; a sweep
  reporting zero may be measuring itself.
- **Test at the boundary a real caller crosses.** `trackingMode` was readable in six places
  and writable in none (zod drops unknown keys silently) — every test set it via Prisma.
  Then `/receive` shipped a blank page because every endpoint was checked with curl.
- **Response shapes differ between endpoints.** `/warehouses` is paginated
  (`{data, total}`); `/receiving/expected` is a bare array. `Receive.tsx` has a `rows()`
  helper that accepts either.
- **`npm run build` is the only real typecheck** — `tsc --noEmit` alone has missed things.

## Known defects, deliberately unfixed

- **400-vs-409 on a lost FIFO race.** A picker who loses a concurrent race is told "only N
  units are costed", i.e. a retryable failure reported as permanent with misleading advice.
  Documented in `backend/test/fifo-concurrency.test.ts`. Undecided because "out of stock"
  and "lost a race" are indistinguishable from one read. **Matters more once several
  technicians pick at once.**
- **Serialised transfers are refused outright.** A transfer consumes and recreates the cost
  layer, which would sever the serial↔lot link. Operator decision 2026-09-19.
- **The PO list subtitle explains the schema, not the work** — "Saved books incoming stock.
  Posted creates the bill, paid settles it, delivered creates the GRN and the FIFO cost
  layers." An operator asking "did the batteries arrive?" should not need to know that
  Posted means billed-not-arrived.
- **No totals rows on any table.**
- **`LabelScanner` hardcodes `#000` / `#111` / `#12b886`; `Receive` uses
  `rgba(0,128,128,0.10)` and `white`** — off-palette, untouched because the camera surfaces
  were not opened this session.
- **Sidebar parent badges show one child's count, not the total** (Purchases reads 3 while
  Bills 3 + Receipts 1).
- **5 tables undocumented on `/about`**: DocumentCounter, LedgerSetting, StockCount,
  StockCountLine, User.
