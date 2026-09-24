# Month-end close

Finance → **Month-end close** (/close). Pick the month. Every check is a plain statement of what "correct" means, with why it matters and a button to fix it.

**Blocking checks** (must pass to close): every journal entry balances and none left the books unexplained; no unposted entries dated in the month; stock value equals the Inventory account; every unit on hand has a cost; no stock count left open; every shipped order is invoiced.

**Carried forward** (listed, do not block): supplier orders not fully arrived, stock in transit, invoices past due, unpaid supplier bills, deliveries not confirmed, checkout payments on unshipped orders, orders invoiced before shipping, stock promised beyond what is held.

**Close <month>** re-runs every check, then locks the books through the last day of the month: nothing dated in it can be posted, changed or deleted afterwards; corrections go in the next month. The close record (who, when, what was carried forward) can be printed. A month can only be closed after it ends.

See also [[accounting]] for Live Audit and the ledger.
