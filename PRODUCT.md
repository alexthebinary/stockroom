# ProfitIndex

## Product

ProfitIndex is the inventory, order and accounting system for a small robotics and fabrication retailer with a showroom and warehouse in Newtown, PA. One app keeps stock, sales across channels, purchasing and a real double-entry ledger in step, so the owner can close a month knowing the stock and the books agree.

(The codebase and repository are still named "Stockroom"; ProfitIndex is the product name, confirmed by the operator 2026-09-24.)

## What it sells

- Unitree robots (the full lineup) — high-value, serial-numbered units.
- XAG agricultural drones: P100 Pro and P150 Max — serial-numbered, plus batteries and spares.
- Bambu Lab 3D printers and the filament lineup — printers serial-numbered; filament is fast-moving consumable stock.
- xTool laser cutters (the lineup) — serial-numbered.
- Robot automation software — sold, not stocked. **Open decision:** the app has no non-inventory / service item type yet; software sales need one before they can be sold without a stock layer.

## Users and the work they do

- **Warehouse clerk, on a phone at the dock.** Receives deliveries against purchase orders (camera scan, or the assistant reading a packing slip), moves stock between warehouses, adjusts found or damaged stock. Often gloved, one-handed, interrupted.
- **Owner / accountant, on a desktop.** Orders and bills, customer payments across channels, returns, the month-end close, reports. Reads the numbers to make pricing and buying decisions, so every figure must be right (margin ex-tax, stock value reconciled).
- Showroom counter sales happen too (walk-in clients pay and leave with the goods), run by the owner for now.

## Channels and money

Shopify, Amazon and the showroom are paid at checkout; wholesale and direct orders are invoiced when they ship and due in 30 days. Revenue and cost are recognised at shipment. The client's own chart of accounts and journal entries govern the ledger (`.coa-reference.txt`).

## What matters most

1. **The numbers are right.** Stock value equals the Inventory account; margin excludes tax; the month-end close proves it.
2. **Fast at the dock.** Receiving a delivery on a phone must take seconds, not a form.
3. **Guided, never automatic.** The assistant prepares work; a person approves every change.

## Constraints

- Beta with 2–3 people; runs on Render; no sign-in (the operator opened it to anyone with the URL, admin by default).
- Platform: web, used on phones (clerk) and desktops (owner). Mobile web, not native.
- Accessibility: AA contrast minimum (enforced by `backend/test/theme-contract.test.ts`); touch targets ≥44px on phone flows.

## Voice

Plain, specific, explains the why in one line (the month-end checks are the model: "Goods that left without an invoice are sales missing from the month: the cost is booked and the revenue is not."). No jargon without its meaning next to it.
