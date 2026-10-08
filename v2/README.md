# ProfitIndex v2

A mobile-first warehouse and purchasing system with a real US GAAP ledger. A
clerk scans incoming boxes with a phone camera; the system opens the purchase
order, holds the stock and drafts the vendor bill; accounting checks prices,
adds freight, and posts — and the stock lands at its true landed cost with the
books proved sound.

Built from the client's two scope documents: the *WMS Documents Workflow
Order* (PO → Vendor Bill → Warehouse Receipt; only bills post money; WH-IN /
WH-OUT unit registers) and the *Accounting Policies & Transaction Guide (US
GAAP)* (average cost, landed cost by weighted average, the journal catalogue
and chart of accounts). Design spec and plan: [`docs/`](docs/).

This is a greenfield rebuild beside the v1 app in the repository root. It
does not depend on Render or any particular host.

## Run it

You need Node 22+ and Postgres 16.

```bash
cd v2
cp .env.example .env              # points at localhost:5432
docker compose up -d db           # or use any Postgres 16 you have
npm install
npm run fresh                     # empty database, migrations, chart of accounts
npm run dev                       # API on :4100, web app on :5173
```

Open http://localhost:5173. A fresh install opens the **setup wizard**:
company, team, then *Add minimal sample data* (1 warehouse, a supplier, a
freight carrier, 3 items — no stock, no transactions) or *Start empty*. The
**test sheet** (`/test-sheet`) has the sample barcodes, serial labels and a
packing slip to scan off a second screen or a printout.

The phone camera needs HTTPS (or `localhost`). To try it on a real phone,
put the dev server behind any HTTPS tunnel.

`npm run fresh` takes you back to a brand-new company at any time. It refuses
to wipe a non-local database unless `FRESH_CONFIRM=yes`.

## Run it anywhere

```bash
docker compose up -d --build      # app on :4100 + Postgres, migrations applied at start
```

The image is the API serving the built PWA. Set `DATABASE_URL` to use your own
Postgres, and `ANTHROPIC_API_KEY` to turn on the packing-slip reader.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres 16 connection string |
| `PORT` | default 4100 |
| `ANTHROPIC_API_KEY` | optional — Claude reads packing slips and labels when a box has no barcode. Without it the reader is hidden and barcodes plus manual entry still work |
| `TEST_DATABASE_URL` | tests only; its schema is dropped and rebuilt on every run |

## The flow

1. **Clerk, phone** — *Receive a delivery*: where → from whom (an expected PO,
   a supplier, or "not sure") → scan (the camera stays open; a buzz per box;
   serial-tracked items ask for each unit's serial; unknown boxes are set
   aside, never blocking) → check → finish. Scans are saved on the phone first
   and send themselves when there is signal. Finishing prints the WH-IN
   warehouse receipt.
2. **The system** — units the vendor already billed land in stock at once.
   Everything else is **held**: counted, not sellable, not valued, because only
   a bill may post money. A purchase order (opened at the dock if there was
   none) and a **draft bill** are waiting for accounting.
3. **Accounting** — the bill desk: set the vendor and their invoice number,
   check unit costs and discounts, add freight (spread by value or units),
   see the landed cost per unit and the exact journal, **hold to post**.
   Held units land at that landed cost in the same transaction. Carriers'
   freight-in bills spread over the orders they carried; returns, price
   discounts, payments, refunds and voids follow the GAAP guide's entries.
4. **The books check** (Reports) proves four things after every change, item
   by item and vendor by vendor: debits = credits; Inventory – On Hand = stock
   at average cost; Inventory – Inbound = billed stock not yet arrived; AP =
   open bills.

## Tests

```bash
npm test          # domain rules (incl. golden tests of every GAAP-guide purchase entry) + API scenarios on real Postgres
npm run e2e       # Playwright: fresh install → camera scan on a phone → hold-to-post → $550 landed → paid → books sound
```

The e2e feeds Chromium's camera a generated video of the sample barcode, so
the scanner is tested for real; it saves phone/desktop, light/dark screenshots
to `e2e/screenshots/`.

## Layout

```
v2/
  packages/domain   pure rules: money, average cost, landed cost, postings, statuses, barcodes, CSV
  apps/api          Fastify + Prisma (Postgres): ledger, stock, purchasing, setup, reports, Claude reader
  apps/web          React + Mantine PWA: setup wizard, scanner, receive wizard, bill desk, payables, reports
  e2e               Playwright, with a fake camera
  docs              design spec and implementation plan
```

`apps/api/src/stock.ts` is the only code that changes stock; `ledger.ts`
`postEntry()` is the only way money moves. Read those two first.

## Security posture — by decision, for now

There is **no sign-in and no passcode** (operator decision, 2026-10-08): each
person taps their name on their device, and it is stamped on everything they
do. Anyone who can reach the app can read and change the books. Keep it on a
private network or behind your own access layer until real sign-in and roles
(planned) are in.

## Not yet (next phases)

Sales (SO → invoice with bill-and-hold → warehouse issue, accrual sales tax),
inventory counts / transfers / open-box conversions, month-end close and
period lock, real sign-in and roles (the clerk never sees costs), and
Shopify / tax-software integrations. The Claude packing-slip reader is unit
tested with a stubbed client but has not been run against the live API from
this environment (no key here).
