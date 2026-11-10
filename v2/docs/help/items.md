# Inventory

Open Inventory. Search name, SKU, brand or barcode is the search box. All brands and All categories filter the list; clear filters to widen the results. An item's brand or category badge also filters the list.

Rows show name, SKU, known barcodes, measurements when provided, and on hand quantity. Serial means every unit is tracked by a serial number. Condition labels distinguish non-new items. Awaiting bill is physical stock counted at the dock whose bill has not been posted; it is separate from on hand and is not valued or sellable yet.

Tap the pencil (Edit followed by the item name) to edit an item. The form supports Name, Weight (lb), Length × Width × Height (in), Brand, Category, Default vendor, Reorder minimum and Reorder quantity. Save applies it. The SKU is supplied when adding, not changed in this edit form.

Default vendor is a supplier. Reorder minimum is the on-hand plus still-to-receive level that lists the item on Reports, Purchases, Reorder. Reorder quantity is how many to buy; the order uses that many, or the shortfall if the shortfall is larger. Leave both blank to keep the item off that report. Bundles and serial-tracked items are not listed there.

+ Add item opens Add item; enter SKU and Name, optional measurements and grouping, then Save. Upload CSV previews new items; Download template gives the expected columns. Review the row results. Fix errors in the file and upload again if necessary. Import followed by the item count confirms the import; nothing is added until that confirmation. Existing SKUs must be edited individually.

Stock value under Reports shows quantity, average cost and value across warehouses. The assistant cannot look up a particular SKU or its current quantity; open Inventory to see those records.

## Bundles

A bundle is a sellable item made of a fixed recipe of other items, for example 2 of Part A plus 1 of Part B. It has no stock of its own: Available is how many complete bundles the components on hand can make. Bundles show a Bundle badge in Inventory.

Create bundle asks for Name, SKU, an optional price and the component rows (pick an item, set the quantity; + Add component adds a row). The Can make number updates as you build the recipe. The price is only what you enter; the component cost shown under it is a hint. Serial-tracked items cannot be components yet, and a bundle cannot contain another bundle. Edit on a bundle row changes its name, price or recipe.

Ship on a bundle row asks for Warehouse, How many and a Reference. Shipping takes every component out of that warehouse at its average cost and books the total to Cost of Goods Sold. If any component is short, nothing is shipped and the message names it. Bundles cannot be received or have their stock adjusted; receive and adjust the components instead.
