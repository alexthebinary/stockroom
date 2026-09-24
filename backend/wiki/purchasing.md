# Purchasing

**Create** a purchase order: Purchases → Orders → **New purchase order**: vendor, lines (product, warehouse it will arrive at, quantity, unit cost), tax and shipping.

**Post (create bill)** commits the order to the vendor: it records the vendor's bill for the full amount (Dr Inventory Clearing – Inbound 1210 / Cr Accounts Payable 2000). Goods then arrive against it — see [[receiving]].

**Pay vendor** records payment against the bill; part payments are allowed. **Void bill** reverses a bill with no payment on it. **Cancel** an order that has not been received.

Bills (/bills) lists every vendor bill with what is outstanding. Vendors are kept under Purchases → Vendors (/catalogs/vendors).

A PO shows as short on Home until everything ordered has been received.
