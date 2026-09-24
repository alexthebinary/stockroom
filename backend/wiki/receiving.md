# Receiving goods

Goods arrive against a purchase order (see [[purchasing]]). Two ways to book them in:

**1. On the purchase order (fastest for a whole delivery).** Open Purchases → Orders → the PO → press **Receive**. Enter the quantity that actually arrived on each line ("Arriving now"; "Outstanding" shows what is still due) → **Post receipt**. Anything not received stays outstanding, so a short shipment is just a partial receipt; receive the rest when it comes.

**2. The Receive screen (/receive), box by box with the camera.** Pick the warehouse, tap the arriving PO line, **Open scanner**, aim at the label, **Scan**. A buzz and a green line mean it booked; amber means it booked and wants a second look later; grey means try another angle. Boxes with a barcode read instantly. Needs HTTPS and camera permission on the phone.

**Serial-tracked products** (robots, printers, drones with a serial per unit) must be received on the Receive screen, box by box, so each unit's serial is recorded. The PO's Receive button refuses them on purpose.

**With the assistant:** attach a photo of the packing slip. It reads the PO number, SKUs and quantities, looks up the PO, and proposes one receipt for what arrived, saying what is short or unexpected. Check the card and press Approve.

**What receiving does to the books:** stock goes up at the warehouse on the line, a cost layer is created at the landed unit cost, and Prepaid Inventory moves into Inventory. Every receipt is listed under Purchases → Receipts (/receipts), each with a printable goods-received note.

Short, over or wrong items: receive what really arrived; tell the vendor about the rest. Damaged on arrival: receive it, then decrease it with a reason — see [[inventory]].
