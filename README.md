# Stockroom — inventory management demo

A lightweight, Veeqo-flavoured inventory system you can run locally and click
around: products, multi-warehouse stock, sales orders, purchase orders,
transfers and adjustments, with a full stock-movement audit trail.

This is a **beta demo**, not a product. There are no external integrations, no
real authentication, and no pricing or accounting.

---

## Prerequisites

| | |
|---|---|
| Node | 20 or newer (built and tested on 24) |
| npm | 10 or newer |
| Database | SQLite — no server to install, the file is created for you |

> npm 11 blocks package install scripts by default. If `npm install` prints
> `Run npm approve-scripts ...`, run `npm approve-scripts prisma @prisma/engines @prisma/client esbuild`
> then `npm rebuild` in the affected workspace. Prisma cannot generate its query
> engine without this.

## Quick start

```bash
git clone <this repo> && cd inventory-demo

npm install            # root: just the dev runner
npm run setup          # installs both apps, generates Prisma client, migrates, seeds
npm run dev            # starts API on :4000 and web on :5173
```

Open **http://localhost:5173** and sign in with:

```
demo@user.com / password
```

If port 5173 is taken, Vite picks the next free port and prints it — the API
proxy follows automatically.

### Running the two apps separately

```bash
npm run dev:api        # http://localhost:4000
npm run dev:web        # http://localhost:5173
```

### Reseeding

```bash
npm run seed           # wipes demo tables and reloads the sample data
npm run reset          # drops the database, re-runs migrations, then seeds
```

---

## What the seed gives you

- **3 warehouses**: `MAIN`, `SEC`, `WEST`.
- **10 products** across Apparel, Accessories, Homeware and Electronics.
- **17 stock balances**, several deliberately below a sensible reorder point so
  the dashboard's low-stock table has something to show.
- **Opening-balance movements** for every stocked line, so product history pages
  are not blank.
- **2 sales orders** — one `DRAFT`, one `CONFIRMED` (its stock is already
  reserved, so you can hit **Ship** and watch on-hand fall).
- **2 purchase orders** — one `DRAFT`, one `ORDERED` (its quantity shows as
  incoming, so you can hit **Receive**).
- **1 transfer** in `DRAFT`, ready to start and complete.

---

## Manual setup, step by step

If you would rather not use `npm run setup`:

```bash
# Backend
cd backend
npm install
npx prisma generate                 # build the typed client
npx prisma migrate dev              # create dev.db and apply migrations
npm run seed                        # load demo data
npm run dev                         # http://localhost:4000

# Frontend, in a second terminal
cd frontend
npm install
npm run dev                         # http://localhost:5173
```

Backend configuration lives in `backend/.env`:

```
DATABASE_URL="file:./dev.db"
PORT=4000
DEMO_EMAIL=demo@user.com            # optional, both default to the values above
DEMO_PASSWORD=password
```

---

## Domain model

| Entity | What it is |
|---|---|
| `Product` | A SKU: identifiers, category/brand, physical dimensions, active flag. |
| `Warehouse` | A stocking location. Bins and shelf locations are deliberately out of scope. |
| `InventoryBalance` | Current stock for one `[product, warehouse]` pair: `onHandQty`, `reservedQty`, `incomingQty`. |
| `InventoryMovement` | Immutable audit row for every physical stock change. |
| `SalesOrder` + `SalesOrderLine` | Outbound demand. `DRAFT → CONFIRMED → SHIPPED`, or `CANCELED`. |
| `PurchaseOrder` + `PurchaseOrderLine` | Inbound supply. `DRAFT → ORDERED → RECEIVED`, or `CANCELED`. |
| `StockAdjustment` | A manual correction with a mandatory reason. |
| `StockTransfer` | Stock moving between warehouses. `DRAFT → IN_TRANSIT → COMPLETED`. |

### The one derived field

`availableQty` is **never stored**. It is always computed as
`onHandQty - reservedQty`, at the point of reading. This is the single rule that
keeps reservations honest.

### How stock actually moves

| Action | Balance effect | Movement written |
|---|---|---|
| Sales order **confirm** | `reservedQty +qty` | none — nothing physically moved |
| Sales order **ship** | `onHandQty -qty`, `reservedQty -qty` | `SALE_SHIP` |
| Sales order **cancel** (from confirmed) | `reservedQty -qty` | none |
| Purchase order **order** | `incomingQty +qty` | none — nothing has arrived |
| Purchase order **receive** | `incomingQty -qty`, `onHandQty +qty` | `PURCHASE_RECEIPT` |
| Transfer **start** | source `onHandQty -qty` | `TRANSFER_OUT` |
| Transfer **complete** | destination `onHandQty +qty` | `TRANSFER_IN` |
| Adjustment **increase / decrease** | `onHandQty ±qty` | `ADJUSTMENT_IN` / `ADJUSTMENT_OUT` |

Reserving stock and booking incoming stock are **not** movements — no goods have
moved. The six movement types above are the complete set, and they are what the
product history page and the dashboard timeline read.

### Business rules enforced

- `onHandQty` can never go below zero. Shipping, transferring or adjusting past
  the available quantity returns `400` with a message naming the SKU, the
  warehouse and the shortfall.
- Confirming a sales order fails if `availableQty` is short.
- `reservedQty` and `incomingQty` can never go negative either — a release
  larger than what is actually held throws rather than silently clamping to
  zero, which would erase somebody else's reservation.
- Every status transition is **claimed atomically**, so a double-clicked Ship
  button cannot ship the same order twice. The loser gets `409`.
- Every balance write is conditional on the values it was calculated from. If
  another request changed the row in between, the write is rejected with `409`
  rather than applied to stale numbers.
- Deleting a product or warehouse that has any history soft-deletes it
  (`isActive = false`) so the audit trail survives. Only a completely untouched
  record is hard-deleted, the check and the delete run in one transaction, and
  the UI asks for confirmation first.
- An inactive product or warehouse cannot be used on new orders, transfers or
  adjustments — the API rejects it with `400` even if a stale dropdown still
  offers it. Existing history against it stays readable.
- Every line on a new order is validated against real products and warehouses
  before anything is written, so a bad id returns `404` naming the record rather
  than a foreign-key error.

---

## API

All routes are under `/api`. No authentication is required — pass an optional
`X-Demo-User` header and it lands in the `actor` column of any movement or
adjustment the request creates.

List endpoints accept `?page=` and `?pageSize=` and return
`{ data, page, pageSize, total, totalPages }`.

### Products
| | |
|---|---|
| `GET /api/products` | `?search=` (SKU, name, barcode), `?activeOnly=true` |
| `GET /api/products/:id` | includes per-warehouse balances |
| `POST /api/products` | |
| `PUT /api/products/:id` | partial update |
| `DELETE /api/products/:id` | hard-deletes if untouched, otherwise deactivates |

### Warehouses
`GET /api/warehouses` (`?activeOnly=true`) · `GET /api/warehouses/:id` · `POST` ·
`PUT /:id` · `DELETE /:id`

### Inventory
| | |
|---|---|
| `GET /api/inventory` | `?productId=&warehouseId=&search=&lowStockBelow=&sort=&dir=` |
| `GET /api/inventory/:productId/warehouses` | stock for one product, per warehouse |
| `GET /api/inventory-movements` | `?productId=&warehouseId=&movementType=` |

### Sales orders
| | |
|---|---|
| `GET /api/sales-orders` | `?status=&search=` |
| `GET /api/sales-orders/:id` | |
| `POST /api/sales-orders` | creates a `DRAFT` with line items |
| `POST /api/sales-orders/:id/confirm` | reserves stock |
| `POST /api/sales-orders/:id/ship` | decrements on-hand, releases the reservation, writes movements |
| `POST /api/sales-orders/:id/cancel` | releases any reservation |
| `DELETE /api/sales-orders/:id` | `DRAFT` or `CANCELED` only |

### Purchase orders
| | |
|---|---|
| `GET /api/purchase-orders` | `?status=&search=` |
| `GET /api/purchase-orders/:id` | |
| `POST /api/purchase-orders` | creates a `DRAFT` |
| `POST /api/purchase-orders/:id/order` | books incoming stock |
| `POST /api/purchase-orders/:id/receive` | moves incoming to on-hand, writes movements |
| `POST /api/purchase-orders/:id/cancel` | releases incoming stock |
| `DELETE /api/purchase-orders/:id` | `DRAFT` or `CANCELED` only |

### Stock adjustments
`GET /api/stock-adjustments` · `POST /api/stock-adjustments`
(`{ productId, warehouseId, adjustmentType: "INCREASE" | "DECREASE", quantity, reason }`)

### Stock transfers
| | |
|---|---|
| `GET /api/stock-transfers` | `?status=&warehouseId=` |
| `GET /api/stock-transfers/:id` | |
| `POST /api/stock-transfers` | creates a `DRAFT` |
| `POST /api/stock-transfers/:id/start` | pulls stock out of the source |
| `POST /api/stock-transfers/:id/complete` | lands it at the destination |
| `POST /api/stock-transfers/:id/cancel` | returns in-transit stock to the source |

### Other
`GET /api/health` · `GET /api/dashboard?lowStockThreshold=10` ·
`POST /api/auth/login`

Errors come back as `{ "error": "...", "details": ... }` with `400` for a rule
violation or bad input, `404` for a missing record, and `409` for an illegal
state transition, a lost concurrency race, or a busy database. Prisma's own
error codes are mapped explicitly, so a constraint violation never leaks out as
a raw `500`.

### Concurrency, tested

Two requests hitting the same data at once behave correctly, and this is
verified rather than assumed:

- Two parallel **confirms of the same order**: one returns `200`, the other
  `409`, and the reservation is counted once.
- A **shipment and a receipt of the same SKU** fired in parallel both succeed —
  they touch different columns, and the optimistic guard only pins the columns
  the change actually touches.
- Two parallel **adjustments on the same balance** both apply, with no lost
  update.

---

## Frontend tour

| Page | What you can do |
|---|---|
| **Dashboard** | Total SKUs, on-hand, reserved and incoming units; low-stock table with an adjustable threshold; the last ten movements. |
| **Products** | Search, create, delete. Click a SKU for detail. |
| **Product detail** | Attributes, stock per warehouse, and the full movement history for that SKU. |
| **Warehouses** | List with stock totals; detail shows everything stocked there and links to a pre-filled transfer. |
| **Inventory** | Every `[product, warehouse]` row, filterable by product and warehouse, sortable by SKU, product, warehouse and each stock figure. |
| **Sales orders** | List, filter, create with multi-line items, then Confirm and Ship from the detail page. |
| **Purchase orders** | Same shape: create, Mark as ordered, Receive. |
| **Transfers** | Create, Start, Complete, Cancel — all inline in the table. |
| **Adjustments** | Adjust a SKU up or down with a reason; recent adjustments listed below. |

Server state is TanStack Query; forms use local `useState`. Anything that moves
stock invalidates the whole query cache, because a single shipment changes
balances, movements and the dashboard at once.

### Interface decisions worth knowing

The UI went through a Human Interface Guidelines review, and these are the
choices that came out of it rather than out of Mantine's defaults:

- **Status colors mean four things, not seven.** Every status and movement type
  reduces to *nothing yet* (gray), *in flight* (blue), *stock in* (teal), *stock
  out* (grape), plus *stopped* (red). `TRANSFER_IN` and `ADJUSTMENT_IN` are the
  same color because they are the same event to a warehouse.
- **Contrast is measured, not eyeballed.** Badges render shade 9 on shade 0,
  which clears 4.5:1 for every hue used (gray 14.6, blue 5.5, teal 4.7, grape
  6.5, red 5.1). The primary color is `indigo.7` (4.98:1) rather than Mantine's
  default `indigo.6` (4.32:1), and `--mantine-color-dimmed` is remapped from
  gray-6 (3.32:1) to gray-7 (8.18:1).
- **Search is debounced 250ms and the table keeps its rows while refetching**,
  so typing a SKU does not tear the page down to a spinner once per keystroke.
- **Every create form submits on Enter.** This is data-entry work; leaving the
  keyboard for each record is the wrong cost.
- **Disabled actions say why.** Ship, Receive, Confirm and Cancel stay focusable
  and carry a tooltip naming the rule, instead of going dark and dropping out of
  the tab order.
- **A hover highlight means the row is clickable.** Tables where the row has an
  obvious destination navigate on click; read-only tables lost the highlight
  rather than keeping a promise they could not honour.
- **`availableQty` is the number the warehouse runs on**, so it is the emphasised
  column. It is also the one column that cannot be sorted server-side — it is
  derived, so sorting it would need the whole table in memory.

---

## Project layout

```
inventory-demo/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       # all 8 entities
│   │   ├── seed.ts             # demo data
│   │   └── migrations/
│   └── src/
│       ├── index.ts            # express app, route mounting
│       ├── db.ts               # prisma client
│       ├── domain.ts           # movement types, statuses, thresholds
│       ├── errors.ts           # ApiError + helpers
│       ├── http.ts             # async wrapper, validation, pagination, error middleware
│       ├── inventory.ts        # ALL balance mutation lives here
│       └── routes/             # one module per resource
└── frontend/
    └── src/
        ├── api.ts              # typed fetch client
        ├── auth.tsx            # demo login context
        ├── hooks.ts            # shared product/warehouse option lists
        ├── components/         # shared UI + order line editor
        └── pages/              # one file per screen
```

`backend/src/inventory.ts` is the file to read first — every balance change in
the app goes through it, which is what makes the invariants enforceable in one
place.

---

## Security posture — read before showing anyone

This is a demo, and its security model is deliberately close to nothing:

- The login is a **hard-coded email and password** compared in plain text. There
  is no token, no session, and no password reset.
- **Every API route is unauthenticated.** The frontend login gates the UI only;
  anyone who can reach port 4000 can read and change everything.
- `X-Demo-User` is trusted as-is for audit fields. It is a label, not an
  identity.
- CORS is wide open.

Run it on localhost. Do not put it on a public address, and do not put real
data in it.

---

## Deliberately out of scope

No Shopify/Amazon/marketplace sync, no carrier or shipping-rate integrations, no
accounting, GL or COGS, no RBAC/MFA/OAuth, no bin or shelf locations, no
forecasting or reorder automation, no barcode scanning hardware, and no pricing
anywhere — quantities only.
