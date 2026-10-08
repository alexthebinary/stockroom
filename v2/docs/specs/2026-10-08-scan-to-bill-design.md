# ProfitIndex v2 — design spec: mobile-first scan-to-bill WMS + GAAP ledger

## Context
**Why.** The client's two scope PDFs define the target system:
- *WMS Documents Workflow Order*:
  - Purchases run PO → Vendor Bill → Warehouse Receipt; sales run SO → Invoice → Warehouse Issue.
  - Only Bills and Invoices post money.
  - Separate WH-IN and WH-OUT *unit* registers record physical movement.
- *Accounting Policies & Transaction Guide (US GAAP)*:
  - AVCO costing, with inbound freight capitalized by weighted average.
  - Bill-and-hold revenue at invoice, and accrual sales tax.
  - A full journal catalogue and chart of accounts.

The operator's core ask: a warehouse clerk scans incoming goods with a phone camera, the system updates itself, and a PO plus a **draft vendor bill** appear. Admin and accounting then map and edit that bill (shipment/freight cost, payables, vendor, terms) and post it.

**Decisions taken with the user (2026-10-08):**

| Topic | Decision |
|---|---|
| Foundation | **Greenfield** in a new `v2/` folder of this repo, on branch `claude/warehouse-mobile-scanning-8s2d64`. The current app (`backend/`, `frontend/`) stays live and is used as reference only. |
| Platform | Installable **PWA**: one React codebase for phone (clerk) and desktop (accounting). |
| Unbilled stock | Scanned goods with no posted bill are **held ("Received – awaiting bill")**: counted, not sellable, not valued. They land automatically when the bill posts. |
| Onboarding | All three: step-by-step task wizards, first-run company setup, first-use coaching. |
| Roles | No sign-ins and **no passcode** (user, 2026-10-08). A "who's working" profile picker sets the home screen (Clerk / Accounting / Admin) and stamps audit fields. |
| Data | **Fresh install.** The setup wizard creates the company, with **very minimal optional sample data** so the admin can test as a brand-new company (user request). |
| AI reader | Claude API reads packing slips and labels when there is no barcode. |

**What the existing app taught us** (from exploration):
- Bills were born POSTED as copies of the PO, with no lines, no due date or terms, no vendor invoice #, and no edit.
- Receiving required an already-billed PO, so there was no path for a surprise delivery.
- Each scanned box made its own GRN, with no idempotency key.
- One PO status column mixed payment and receipt.
- Barcodes were never matched to items.
- The camera path had no automated test.

Patterns worth porting: single-module balance mutation (`backend/src/inventory.ts`), atomic status claims, versioned AVCO pool (`backend/src/costing.ts:101-134`), admin-editable posting rules with locked control accounts (`backend/src/posting.ts`, `routes/accounting.ts:67-124`), balanced entries and reversal-not-delete (`backend/src/ledger.ts`), and the telescoping clear on partial receipts (`backend/src/goods_receipt.ts:93-119`).

**This also resolves HANDOFF's open "PO status question":** bill-before-receipt is client-specified, and the PO statuses are three independent axes.

## Method ("superpowers" workflow)
The superpowers plugin is not installed in this environment, so the plan follows its method by hand:
1. Brainstorm and clarify (done: two rounds of questions).
2. Design spec (this document).
3. Bite-sized, test-first implementation plan (the Phase 0–1 task list below).
4. Execute task by task, committing after each.

The first implementation commit saves this spec to `v2/docs/specs/2026-10-08-scan-to-bill-design.md` and the task list to `v2/docs/plans/2026-10-08-phase-0-1.md`.

## Architecture

**Repo:** `v2/`, an npm-workspaces TypeScript monorepo.
```
v2/
  packages/domain/   pure TS, no I/O: money (integer cents), AVCO pool math, landed-cost
                     allocation, posting templates, status machines, GTIN check digits.
                     Shared by api + web (live landed-cost preview on the bill desk).
  apps/api/          Fastify + zod type provider, Prisma on Postgres ONLY (dev and tests too:
                     docker compose), @anthropic-ai/sdk.
  apps/web/          React + Vite + Mantine + TanStack Query, vite-plugin-pwa (installable,
                     offline scan queue in IndexedDB), zxing-wasm barcode reader (works on
                     iOS Safari; native BarcodeDetector used when present).
  e2e/               Playwright (Chromium is preinstalled); the camera is fed a fake video of
                     barcodes, so the scan path finally has an automated test.
  docs/specs, docs/plans
```

**Why these choices:**
- Postgres everywhere removes the old SQLite-dev / Postgres-prod `db push` split.
- A pure domain package makes the GAAP examples unit-testable to the cent.
- zxing-wasm covers iPhones, which have no `BarcodeDetector`.

## Domain model (key entities)
- **Company**: name, address, home state (for tax), fiscal year start, currency USD, `setupCompletedAt`.
- **Item**: SKU, name, `trackingMode` NONE|SERIAL, `conditionOf` (an open-box variant points at its regular item, for the GAAP "Inventory Conversion"), `defaultVendorId`, `lastCostCents`.
  - **ItemBarcode**: unique code, kind GTIN/UPC/EAN/CODE128/VENDOR_SKU, `vendorId`.
- **Vendor**: kind SUPPLIER|CARRIER, `paymentTermsDays`, AP account override (optional). **Warehouse.**
- **PurchaseOrder**: number, vendor (nullable while the vendor is unknown), `source` MANUAL|SCAN, and **three axes**:
  - `billingStatus` NOT_BILLED | DRAFT | BILLED
  - `paymentStatus` UNPAID | PARTIAL | PAID
  - `receivingStatus` NOT_RECEIVED | PARTIAL | RECEIVED

  Plus `lifecycle` OPEN|CLOSED|CANCELED. The WMS doc's statuses map onto these 1:1.
- **PurchaseOrderLine**: item, warehouse, `qtyOrdered`, `unitCostCents`, `qtyReceived`, `qtyHeld`.
- **VendorBill**:
  - `kind` INVENTORY | FREIGHT_IN | FREIGHT_OUT
  - `status` DRAFT | POSTED | VOID
  - vendor, vendor invoice #, bill date, terms, due date, attachment (photo/PDF of the vendor's bill), `poId?`, freight-on-bill amount, allocation basis VALUE (default) | QTY, totals, `postedAt`, `postedBy`
  - **VendorBillLine**: PO line, item, qty, unit cost, discount, allocated freight, landed unit cost.
- **LandedCostAllocation**: freight bill → target bill line, amount, split into `inboundCents` / `onHandCents` / `soldCents`.
- **WarehouseReceipt** (the WH-IN register): `state` PENDING_BILL | POSTED, PO, bill, warehouse, scan session.
  - **ReceiptLine**: item, qty, landed unit cost (set on post).
  - **SerialUnit** (FK to receipt line).
- **ScanSession**: clerk, warehouse, vendor?, PO?, status OPEN|SUBMITTED, packing-slip photo and AI read.
  - **ScanEvent**: client UUID (**idempotency key**), raw code, symbology, matched item, qty delta, source BARCODE|AI|MANUAL, `needsReview`.
- **StockBalance** [item, warehouse]: `onHand`, `held` (awaiting bill), `reserved`. Available = onHand − reserved; held is never available.
- **CostPool** [item]: qty, value, version (AVCO, optimistic lock). **InventoryLot**: physical trail; `remainingQty` is used for freight-after-sale splits and serials.
- **Ledger**:
  - Account (with `parentId` for roll-ups)
  - JournalEntry (source doc ref, reversal-of)
  - JournalLine
  - PostingRule (event+role → account, admin-editable, audited, control accounts locked)
  - PostingRuleChange
- **Payment**: direction OUT/IN, bill links (partial allowed), method, date. **VendorCredit**: purchase return or price discount, against a bill line.
- **AuditEvent**: who (profile), what, when, before/after.

## Chart of accounts (GAAP guide + one sub-account)
| Code | Account |
|---|---|
| 1000 | Bank / Cash |
| 1100 | Accounts Receivable |
| **1200** | **Inventory Asset (parent)** |
| 1201 | Inventory – On Hand |
| 1202 | Inventory – Inbound (billed, not yet received) |
| 2000 | Accounts Payable |
| 2100 | Sales Tax Payable |
| 3000 | Opening Balance Equity |
| 4000 | Sales Revenue |
| 4100 | Shipping & Handling Revenue |
| 4500 | Sales Returns & Allowances |
| 4510 | SR&A – Shipping/Handling |
| 4900 | Inventory Adjustment Gain |
| 5000 | Cost of Goods Sold |
| 6100 | Outbound Shipping Expense |
| 6900 | Inventory Adjustment Loss |

Statements show 1201 and 1202 rolled up as "Inventory Asset", exactly as in the guide. The split exists so stock value reconciles to the GL. The WMS doc's "Dr WH-IN (Inventory Asset) / Cr PO#/Bill#" is precisely the 1202 → 1201 move.

**Invariants, asserted after every test scenario:**
- Trial balance is balanced.
- GL 1201 = Σ CostPool.value.
- GL 1202 = Σ open inbound (billed landed value not yet received).
- Held units carry no value.

## Posting engine (purchase side) — what each event books
| Event | Units (WH-IN register) | Journal |
|---|---|---|
| PO created / edited | none | none (the doc says POs create no transactions) |
| Clerk submits scan session, **no posted bill** | `held += qty` (PENDING_BILL receipt) | none |
| Clerk submits scan, **PO already billed** | `onHand += qty`, lot created | Dr 1201 / Cr 1202 at landed unit cost (the last receipt clears the remainder) |
| **Bill posted** (inventory kind, freight on bill allocated by value) | Pending receipts for this PO auto-post: `held → onHand` | Dr 1202 landed total / Cr 2000 AP; then for the held units Dr 1201 / Cr 1202 |
| **Freight-In bill posted** (carrier vendor, allocated to PO/bill lines) | none | Cr 2000 AP. Per target line: Dr 1202 for the unreceived share; Dr 1201 (pool value +) for the share still on hand (by lot `remainingQty`); **Dr 5000 COGS for the share already sold** |
| Price discount on a line (guide #8) | none | Dr 2000. Credits mirror freight: Cr 1202 / 1201 / 5000 |
| Purchase return, received goods (guide #3/#4/#6/#7) | `onHand −= qty` (WH-OUT) | Dr 2000 at the vendor's credit amount (default = the bill line's landed unit cost × qty) / Cr 1201 at **average cost** of the units returned; any difference goes to 5000 COGS (`returnVariance` role). In the guide's examples credit = average, so the entry is exactly Dr AP / Cr Inventory |
| Return of goods never received | open qty reduced | Dr 2000 / Cr 1202 |
| Payment / vendor refund | none | Dr 2000 / Cr 1000; refund Dr 1000 / Cr 2000 |
| Void bill | landed units go back to `held` | Mirror reversal of the bill entry and its landings. Refused while a payment or credit is applied, or once any of its landed units have left stock (use a vendor credit instead) |
| Opening stock (setup wizard) | `onHand += qty` | Dr 1201 / Cr 3000 |

The guide's examples become golden tests:
- Bill $1,000 → Dr Inv 1,000 / Cr AP 1,000.
- With $100 freight → $550 landed unit, $1,100 total.
- Partial return → $550.
- Discount → $200.
- Freight-In → $100.

## Scan-to-bill flow (the core ask)
**Clerk, on a phone, in the "Receive delivery" wizard** (one question per screen, progress dots, ≥48px thumb targets, works one-handed):
1. **Where?** Warehouse, remembered per device.
2. **From whom?** "Scan the packing slip" sends it to Claude, which reads vendor, PO#, SKUs, quantities and prices. The alternatives are picking an expected PO / vendor, or "Not sure", which accounting resolves later.
3. **Scan items.** The camera is continuous:
   - A barcode becomes an ItemBarcode match, with a buzz, a green flash and a running tally per item; ± steppers fix counts.
   - Serial items ask for each unit's serial (scan it, or Claude reads the label).
   - An unknown barcode triggers a quick capture (photo + name). It is flagged for admin to map and never blocks the clerk.
4. **Check.** Expected vs scanned: short, over and unexpected lines are highlighted, with an optional note or photo of any damage.
5. **Done.** Submitting the session runs the server-side matcher:
   - **PO matched and BILLED:** matched units post immediately; the screen says "Stock is live". Any extras go to a new PO with a draft bill and are held.
   - **PO matched, not yet billed:** units are held. If no draft bill exists, one is created with qty = received. If accounting already started one, it is never overwritten; the received-vs-billed variance is flagged on the Bill desk instead.
   - **No PO:** a PO (`source=SCAN`) + DRAFT bill + PENDING_BILL receipt are created. Prices come from the slip, then vendor last cost, then item last cost.
   - The confirmation screen reads "12 items received — waiting for accounting to post the bill".

**Reliability:**
- Every ScanEvent carries a client UUID, so replays are no-ops.
- Events queue in IndexedDB offline and sync on reconnect.
- Submit is an atomic status claim, so a double tap gets 409.
- A lost AVCO race returns **409 retry** (distinct from 400 "not enough stock"), which fixes a known defect of the old app.

**Accounting, on desktop or tablet: the "Bill desk"** (wizard-style review, with a responsive card layout on phones):
- An inbox of draft bills from the dock, oldest first, with held units and their age.
- Review steps:
  1. Vendor and vendor invoice #, plus an attachment photo of their bill.
  2. Bill date, terms and due date.
  3. Lines: unit cost, qty billed vs received (variance shown), per-line discount.
  4. Freight: on-bill freight with a **live landed-cost preview per line**, computed by the shared domain package.
  5. Accounts: the GL mapping preview (the journal it will post, with per-bill account override where the rules allow).
  6. Post.
- **Add freight bill:** carrier vendor and amount, then pick the POs/bills it covers. An allocation preview shows the inbound / on-hand / sold split before posting.
- **Payables:** AP list and aging by due date; pay in full or in part; vendor refunds; vendor credits (returns, discounts).

## Onboarding
- **First-run setup wizard (admin).** It opens automatically when `Company.setupCompletedAt` is null and is resumable, with a progress rail. Steps:
  1. Company: name, address, state, fiscal year.
  2. Team profiles (name + job).
  3. Warehouses.
  4. Chart of accounts: the GAAP set is preloaded; review or rename.
  5. Vendors.
  6. Items with barcodes.
  7. Opening stock (or skip).
  8. Choose **"Start empty"** or **"Add sample data"**.

  Steps 5–7 accept manual entry or CSV import.
- **Minimal sample data** (optional, removable via "Clear sample data" while no real transactions exist):
  - 1 warehouse "Main"
  - 2 vendors: one supplier, one freight carrier
  - 3 items: one regular with a UPC, one serial-tracked, one open-box variant of the regular item
  - zero transactions and zero stock

  So the admin runs the very first PO → scan → bill → post → pay cycle themselves. To make that possible without real goods, it adds a **printable test sheet** (an in-app page): the 3 items' barcodes, 2 sample serial labels, and a sample packing slip to test the Claude reader.
- **Fresh install / reset:** `npm run fresh` (from `v2/`) drops and recreates the database. The next launch shows the setup wizard. There are no demo orders anywhere.
- **First-use coaching:** dismissible coach marks, stored per device, the first time each wizard or the scanner opens (aiming, what green / amber / grey mean, haptics). There is also a "Practice scan" mode against the test sheet that writes nothing. Each home screen has a "Getting started" checklist (e.g. Accounting: "Post your first bill") until done.

## Claude reader (packing slips and labels)
- Implemented in `apps/api/src/ai/reader.ts` with `@anthropic-ai/sdk`.
- Calls `client.messages.parse({ model: "claude-opus-5-5", output_config: { format: zodOutputFormat(PackingSlipSchema), effort: <set explicitly, tuned on an eval set> }, messages: [image (base64 JPEG, resized ≤1600px) + instructions] })`.
- Schema fields: vendorName, poNumber, documentDate, and lines `[{ vendorSku, description, qty, unitPrice? }]`, plus `serials[]`, each field with confidence.
- **Server-side refusal fallback** (`fallbacks: "default"`) is enabled by default, per current API guidance; it can be dropped if unwanted.
- `parsed_output` null, refusal, or an API error degrade to manual entry. They never block receiving.
- Output is only a **proposal**: the clerk confirms every line ("guided, never automatic").
- `ANTHROPIC_API_KEY` comes from env. Without it, the reader is hidden and barcodes plus manual entry still work.
- A small eval set (10–20 real slip photos with expected JSON) runs in `apps/api/test/ai/` behind an env flag.

## Phased roadmap
- **Phase 0 — Foundations:** monorepo, Postgres compose, CI scripts, domain package, ledger + posting rules + invariants, AVCO pool, PWA shell + design tokens (port the ProfitIndex "machine-shop" tokens from `frontend/src/theme.css` / `DESIGN.md`), profile picker, fresh-install + setup wizard + sample data.
- **Phase 1 — Scan-to-bill MVP (the core ask):** items/barcodes/vendors, scanner, scan sessions + offline queue + matcher, PO three axes, Bill desk + post, held → on-hand, receipts against billed POs, freight-in bills + allocation, payments + AP aging, purchase returns + discounts, Claude reader, coaching, trial balance + inventory valuation reconciliation report, Playwright e2e with fake camera.
- **Phase 2 — Sales cycle:** SO → Invoice (bill-and-hold four-criteria checklist) → payment → unpaid-shipment approval gate → Warehouse Issue (scan out), accrual sales tax with state matrix (AK, DE, MT, NH, OR none; S&H taxable flag), returns and allowances, freight-out bills.
- **Phase 3 — Inventory ops and close:** adjustments (gain/loss), conversions (open-box), scan-based cycle counts, transfers, month-end checks (held-awaiting-bill aging, 1202 reconciliation, unpaid bills due), reports.
- **Phase 4:** real sign-in + roles (clerk never sees costs), Shopify/Amazon, tax software (Avalara/TaxJar), cutover from the old app.

## Client questions — resolved: **follow the PDFs** (user, 2026-10-08)
1. **Sales tax basis.** The PDF says accrual; the current app moved to cash basis on the client's 2026-09-28 revision. Which governs?
2. **Revenue timing.** The PDF says bill-and-hold (at invoice); the current app recognizes revenue at shipment.
3. **Freight that arrives after units are sold:** confirm the sold share goes to COGS (the guide is silent).
4. **Sales tax charged on vendor bills:** capitalize into landed cost (default) or treat as recoverable?

## Hosting
v2 is host-agnostic: one Docker image plus any Postgres 16. Per the user (2026-10-08), the old Render deployment may expire; v2 does not depend on it.

## Design review amendments (2026-10-08)
An independent architecture review of this spec was folded in:
- **Unit registers are real.** `StockMovement` is the append-only WH-IN / WH-OUT / ADJ register: item, warehouse, bucket ON_HAND|HELD, signed qty, document number and its counter-document (BILL, VENDOR_CREDIT, OPENING, or PO for held stock). Invariant: StockBalance == Σ movements per bucket.
- **Journal lines carry dimensions** (itemId, vendorId, poLineId), so the inventory invariant holds **per item** (GL 1201 by item == that item's pool value) and AP reconciles per vendor.
- **Vendor items:** `VendorItem` (vendor SKU, last cost) replaces the barcode kind VENDOR_SKU. `ItemBarcode.packQty` lets a case barcode count 12.
- **Bills:** duplicate vendor invoice # per vendor is refused at post. The bill entry is dated the bill date; a landing is dated the later of bill date and receipt date.
- **Freight / discount split** uses expected units E = max(ordered, billed, received) on the line.
- **Session close** carries `expectedEventCount`; if the server holds fewer events, the device re-flushes its outbox first.
- **Later phases noted:** a period-end reversing accrual for held stock (received, not billed) if the client wants it; held-stock aging with "accept at estimate" / "reject"; period lock date.
- **Risk accepted by the operator:** no sign-in and no passcode for now. The README says so plainly.
