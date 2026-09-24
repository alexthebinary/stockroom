# Sales orders

**Channels decide when the customer pays.** Shopify, Amazon and Showroom are paid at checkout. Wholesale and Direct orders are invoiced when they ship and are due in 30 days. The channel is chosen on the new-order form and its payment rule is shown under it.

**The flow:** Sales → Orders → **New sales order** (customer, channel, lines).
1. **Pack (reserve)** — reserves the stock so nothing else can take it.
2. **Take payment** — for checkout channels, record the payment now; it is held as a customer deposit until the goods ship.
3. **Ship** — stock leaves, its FIFO cost is booked, and the invoice is raised automatically; a checkout payment is applied to it, so a prepaid order becomes Paid.
4. **Record payment** — for terms orders, when the customer pays (part payments allowed).
5. Delivery — on the order, under Delivery, add carrier and tracking and tick **Customer has confirmed delivery**; the order becomes Delivered.

**Invoice before shipping** exists for billing a wholesale buyer in advance; normally shipping does it. **Cancel** an order that has not shipped; if it holds a checkout payment, reverse (refund) that first. Invoices (/invoices), Deliveries (/deliveries) and Customers (/catalogs/customers) are under Sales. PDFs: invoice, packing slip, 4×6 label.

Goods coming back: [[returns]]. Selling to someone in the showroom: [[showroom]].
