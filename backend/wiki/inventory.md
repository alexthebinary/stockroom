# Inventory

**Stock on hand (/inventory)** — per product per warehouse: On hand, Reserved (packed for orders), Available (on hand minus reserved), Incoming (on posted purchase orders).

**Products (/products)** — **New product**: SKU, name, category, cost and price. Tracking mode "serial" means every unit carries its own serial number (see [[receiving]]).

**Warehouses (/warehouses)** — each location stock lives in.

**Transfers (/transfers)** — moving stock between warehouses: **Create transfer**, **Start** when it leaves (it is then in transit, owned but in neither warehouse), **Complete** when it arrives. A transfer posts no journal entry: no value moves, because the weighted average cost is one figure per product across all warehouses.

**Adjustments (/adjustments)** — correct stock with a reason: **Increase** (found, opening stock — give a unit cost, or leave it blank to use the current average) or **Decrease** (damaged, lost — valued at the weighted average cost). Every adjustment is posted to the ledger. **Apply adjustment**.

Stock counts (a full count session) exist in the system but have no screen yet; use adjustments. Low stock: set a reorder point; Home shows anything below it.
