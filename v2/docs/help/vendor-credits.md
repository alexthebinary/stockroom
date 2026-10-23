# Vendor credits and returns

Open Bills, then the posted inventory bill. Choose Vendor credit. This opens a form with Return units or Price discount and a Line selector.

For Return units, select Line and Units. The switch distinguishes Units we have, going back to the vendor from Billed units that never arrived. Received units leave on-hand stock at the item's average cost; units that never arrived reduce inventory in transit. Serial-tracked returns need Serials going back (comma-separated). Credit amount $ may be left blank for the units' cost on this bill, or filled with the actual amount credited by the vendor. Post credit records it.

The vendor credit reduces Accounts Payable. When its amount differs from the stock cost removed, the difference posts through the vendor return variance role, assigned by default to 6950 Vendor Return Variance. It is not posted to Cost of Goods Sold. Settings → Accounts → Account assignment shows the assignment; a non-inventory role can be reassigned for future entries.

For Price discount, choose Line and enter Credit amount $, then Post credit. It reduces the price without returning units. The allocation reduces the cost of goods still in transit or on hand, or adjusts cost of goods sold for units already gone.

A credit after full payment can leave the bill showing Vendor owes us. Record vendor refund on that bill records the refund when received. A credit is not itself a cash refund. Open Payables or the bill to inspect current balances; the assistant has no company-data access and cannot post a credit, move stock or record a refund.
