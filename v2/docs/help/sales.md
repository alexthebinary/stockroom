# Sales

Sales sits above Purchases. It has three screens: Sales orders, Invoices and Receivables.

A sales order commits to sell and posts no money by itself. Open Sales orders and tap New. Choose the customer and the warehouse the goods leave from, add each item with a quantity and a price, then Create order. Numbers run SO-00001, SO-00002, and so on. The list has the same tools as purchase orders: search, filters, saved views, a column chooser, row checkboxes and a CSV of the rows you tick.

Each order shows three statuses. Invoicing is not invoiced, part invoiced or invoiced. Payment is unpaid, part paid or paid. Shipping is not shipped, part shipped or shipped. Open an order to change lines while it is still open. A line that has shipped or been invoiced cannot drop below that quantity, and an invoiced line keeps its price.

Ship remaining takes the units still to ship out of that warehouse at the item's average cost. It debits Inventory Asset (shipped, not yet invoiced) and credits Inventory Asset (on hand), and writes a WH-OUT movement. For units already invoiced, a separate Customer invoice costing entry on each affected invoice debits Cost of Goods Sold and credits Inventory Asset (shipped, not yet invoiced). Shipping more than is on hand is refused and posts nothing. Serial-tracked items and bundles are not sold on a sales order; sell a bundle's components, or ship the bundle from stock.

Create invoice bills the quantity that is not yet invoiced, at the order price. The invoice number is INV-00001 and up. Posting debits Accounts Receivable for the total, credits Sales Revenue for the product subtotal, credits Shipping & Handling Revenue for shipping when it is not zero, and credits Sales Tax Payable for sales tax when it is not zero. It also debits Cost of Goods Sold and credits Inventory Asset (shipped, not yet invoiced) for the cost of the shipped units that invoice covers. The due date is the invoice date plus the customer's terms. An invoice can be created before or after the goods ship. Void invoice reverses the invoice posting and its costing entries while no payment has been recorded. The reversed cost returns to Inventory Asset (shipped, not yet invoiced), and the units stay shipped.

On the invoice, enter the amount and hold Record payment. A payment number is CP-00001 and up. It debits cash and credits Accounts Receivable, in full or in part, and never more than is still open.

Receivables lists posted invoices that still have a balance, grouped by customer. Current means not yet past the due date. 1–30, 31–60, 61–90 and 90+ are days late. Open an invoice number to record the payment.

Cancel an order only before anything has shipped and before a posted invoice exists. Cancelling again leaves it cancelled. The assistant can explain these steps but cannot ship, invoice, take a payment or read a customer's balance.
