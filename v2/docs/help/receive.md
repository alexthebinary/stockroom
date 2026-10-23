# Receive and warehouse receipts

Open Receive (Receive a delivery). Choose Where is it arriving? if there is more than one warehouse; a single warehouse is selected automatically. At Who is it from?, select an expected order, or use Or pick the supplier and Start scanning. Not sure lets accounting match the paperwork later.

Open scanner starts the barcode camera. Aim the box barcode into the white frame. A buzz and lime frame mean it counted; orange means check the screen. Scan more reopens it. No barcode? Pick the item supports manual entry. For serial-tracked items, scan or type each unit's serial label; the count must have the matching serials. When enabled, the packing-slip photo reader can help enter lines, which you still review.

Check & finish shows Does this match what's in front of you? Check the quantities; Back to scanning returns to the count. Finish delivery submits the delivery and prints a WH-IN warehouse receipt. Unknown items are set aside for accounting and do not stop finishing; Bills → Unknown items → Match to an item resolves them. Abandon delivery is available while scanning.

The receipt shows In stock now and Awaiting the bill. Without a posted vendor bill, the counted goods wait unvalued and unsellable. A draft bill appears in Bills → To review. Posting it lands the held units automatically. With a posted bill, receiving moves its inventory value from in transit to on hand.

Both roles use account 1200 Inventory Asset. The warehouse receipt debits 1200 for inventoryOnHand and credits 1200 for inventoryInbound for the same amount: it nets to zero on 1200, while changing where the value sits. It does not create a second payable. Partial deliveries leave the remaining units to receive. Reports → Purchases → To receive lists outstanding units; Awaiting bill lists counted goods waiting on accounting.

Offline scans queue on the phone and send when back online. Wait for pending scans to send before finishing. The help assistant cannot count or submit a receipt for you.
