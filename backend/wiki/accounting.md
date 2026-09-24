# Accounting

Every stock and money event posts a double-entry journal entry automatically; nobody types debits and credits for normal work.

**Accounting (/ledger)** — three tabs. **Ledger**: the trial balance and the journal. **Chart of accounts**: every account with its type, normal balance, what it holds and its balance today. **Transaction entries**: each kind of transaction (bill, bill payment, goods receipt, checkout payment, goods issue, invoice revenue and cost, customer payment, returns, refunds, opening balance, adjustments, transfers) with its debit and credit and the latest real entry and amounts from this ledger; "Show all" opens the Ledger filtered to it.

**Posting rules (/catalogs/posting)** — which accounts each kind of event posts to. The chart follows the client's sheet: 1000 Bank / Cash, 1100 Accounts Receivable (AR), 1200 Inventory, 1210 Inventory Clearing – Inbound (billed, not yet received), 1220 Inventory Clearing – Outbound (shipped, cost not yet matched to an invoice), 2000 Accounts Payable (AP), 3000 Opening Balance Equity, 4000 Sales Revenue, 4100 Inventory Adjustment Gain, 5000 Cost of Goods Sold, 5100 Inventory Adjustment Loss. ProfitIndex adds 5200 Rounding Variance, 5300 Repair Parts, 5400 Warranty.

How a sale posts: shipping is a goods issue (Dr 1220 / Cr 1200 at FIFO cost); the invoice recognises revenue (Dr 1100 / Cr 4000) and the cost (Dr 5000 / Cr 1220). Anything left in 1220 is goods shipped but not yet invoiced.

**Reports (/reports)** — Sales (by customer, channel, manager, category), Purchases, Stock on hand, Valuation (stock value from FIFO cost layers, reconciled with the Inventory account).

**Period lock** — set by closing a month ([[month-end-close]]).


**Retired 2026-09-24:** 1230 Inventory In Transit and 2100 Customer Deposits. Transfers between warehouses post nothing now (the stock stays in Inventory at cost); checkout payments credit Accounts Receivable, so a prepaid order shows the customer in credit until it ships. Past entries stay on the retired accounts, which disappear from the chart once their balance is zero.
