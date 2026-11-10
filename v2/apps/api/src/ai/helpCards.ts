import type { SCREENS } from "./help";

/**
 * Short plain-text answers for the questions the help pages cover. Jev picks one card per question
 * (see jev.ts); anything it cannot place goes to the help model. Wording comes from docs/help/*.md:
 * when a help page changes, change its card here too.
 */
export type HelpCard = {
  id: string;
  /** What the user is asking, in the words Jev reads to decide. */
  when: string;
  answer: string;
  screen?: keyof typeof SCREENS;
};

export const HELP_CARDS: HelpCard[] = [
  { id: "purchase_flow", when: "How the buying process works: purchase order, vendor bill, warehouse receipt, and what order things happen in.",
    answer: "The flow is purchase order, then vendor bill, then warehouse receipt. An order commits to buy and posts no money. The bill posts the cost. The receipt records the boxes arriving.", screen: "guide" },
  { id: "new_order", when: "How to create or place a new purchase order.",
    answer: "Open Orders and tap New. Pick the Vendor and Deliver to, add each Item with Qty and Unit $, then tap Create order. An order posts nothing until its bill is posted.", screen: "new_order" },
  { id: "who_working", when: "How to change the person or job (clerk, accounting, admin), switch profile, or log out.",
    answer: "Open the avatar menu at the top right and choose Switch person. Your job picks your Home screen and the main navigation. There are no passwords, only a profile choice.", screen: "home" },
  { id: "add_item", when: "How to add a new item or product.",
    answer: "Open Inventory and tap + Add item. Enter the SKU and Name, add optional measurements, brand, category, default vendor, reorder minimum and reorder quantity, then Save. The SKU can't be changed later.", screen: "items" },
  { id: "edit_item", when: "How to edit or change an existing item's name, brand, category, measurements, vendor or reorder quantities.",
    answer: "Open Inventory and tap the pencil on the item. Change Name, measurements, Brand, Category, Default vendor, Reorder minimum or Reorder quantity, then Save. The SKU can't be edited there.", screen: "items" },
  { id: "csv_import", when: "How to import items from a CSV or spreadsheet file.",
    answer: "On Stock tap Upload CSV. Download template gives the columns. Review the row results, fix errors in the file and upload again. Nothing is added until you confirm Import. Existing SKUs must be edited one by one.", screen: "items" },
  { id: "find_items", when: "How to search or filter the list of items by name, SKU, brand, category or barcode.",
    answer: "On Stock use the search box for name, SKU, brand or barcode. The All brands and All categories filters narrow the list. Clear a filter to widen the results.", screen: "items" },
  { id: "on_hand_vs_awaiting", when: "What on hand and awaiting bill mean on an item, or why counted stock is not sellable or valued yet.",
    answer: "On hand is stock that has a posted bill and can be sold. Awaiting bill is stock counted at the dock whose bill is not posted yet. It is not valued or sellable until accounting posts the bill.", screen: "items" },
  { id: "bundles", when: "What a bundle is, how to create or edit a bundle, or what Available means on a bundle.",
    answer: "A bundle is an item made of a fixed recipe of other items. It has no stock of its own: Available is how many complete bundles your components can make. On Stock tap Create bundle, enter Name, SKU, optional price and the components. Serial-tracked items and other bundles can't be components.", screen: "items" },
  { id: "stocktake", when: "How to count stock, do a stocktake, or post counted differences as one adjustment.",
    answer: "Open Stocktake under Stock. Choose the warehouse, unless there is only one. Scan a barcode or search for an item and type how many you counted. The line shows short, over, or ok against on hand. Counting the same item again adds to its line. Review posts only the differences as one ADJ document. Items you did not count stay as they are. Serial-tracked items and bundles cannot be counted.", screen: "stocktake" },
  { id: "ship_bundle", when: "How to ship a bundle, or what happens to stock and cost when a bundle ships.",
    answer: "On the bundle's row tap Ship, then choose the Warehouse, How many and a Reference. Every component leaves that warehouse at its average cost and the total goes to Cost of Goods Sold. If a component is short, nothing ships and the message names it.", screen: "items" },
  { id: "receive_delivery", when: "How to receive or count a delivery at the dock, scan boxes and finish.",
    answer: "Open Receive, choose the warehouse, then pick the expected order or the supplier. Tap Open scanner and aim at each box barcode. Check the counts, then tap Finish delivery to print the WH-IN receipt.", screen: "receive" },
  { id: "scanner_help", when: "How the barcode scanner works, what the colors mean, or what to do when a barcode won't scan.",
    answer: "Aim the box barcode into the white frame. A buzz and a lime frame mean it counted. Orange means check the screen. If there is no barcode, tap No barcode? Pick the item and choose it by hand.", screen: "receive" },
  { id: "serials", when: "How serial numbers work when receiving serial-tracked items.",
    answer: "For serial-tracked items, scan or type each unit's serial label. The count must match the number of serials. A unit's serial can't be entered twice.", screen: "receive" },
  { id: "unknown_items", when: "What happens to unknown items or barcodes that aren't in the catalog, and how to match them.",
    answer: "Unknown items are set aside for accounting and don't stop you finishing the delivery. Accounting opens Bills, then Unknown items, and taps Match to an item.", screen: "bills" },
  { id: "abandon_delivery", when: "How to cancel or abandon a delivery that is being scanned.",
    answer: "While you are scanning, tap Abandon delivery. Nothing is submitted. Offline scans wait on the phone and send when you are back online, so wait for pending scans to send before finishing.", screen: "receive" },
  { id: "warehouse_receipt", when: "What a warehouse receipt (WH-IN) is and what it does to the books, including why it nets to zero or looks like a double entry.",
    answer: "A WH-IN receipt records boxes arriving. It debits Inventory on hand and credits Inventory in transit, both on account 1200, so it nets to zero on 1200 and only moves where the value sits. It is not a second payable and not a duplicate.", screen: "guide" },
  { id: "bill_before_receipt", when: "What happens if the bill is posted before or after the goods arrive; in transit versus awaiting bill.",
    answer: "If goods arrive first they wait as awaiting bill, unvalued and unsellable. Posting the draft bill then lands them automatically. If the bill is posted first, the stock sits in transit until the delivery is received.", screen: "bills" },
  { id: "review_post_bill", when: "How accounting reviews and posts a draft vendor bill.",
    answer: "Open Bills, To review, then a draft. Check the vendor, vendor invoice number, dates, quantities, prices and freight. Press and hold Hold to post bill. Posting needs a vendor, an invoice number and a positive total.", screen: "bills" },
  { id: "bill_match", when: "What Match to order means on a vendor bill, or why a line says the price differs or that billing is more than ordered or received.",
    answer: "Match to order lists ordered, received, billed on this bill, billed on all bills, and both unit costs. Matches means quantity within the order and what arrived, and unit cost within 1 percent. Price differs by a signed percent. Billing more than ordered means the bills exceed the order. Billing more than received is allowed before arrival. It never blocks save or post. No panel on freight or without an order.", screen: "bills" },
  { id: "bill_accounting", when: "What accounts a vendor bill posts to and how landed cost is worked out.",
    answer: "Posting an inventory bill debits Inventory Asset and credits Accounts Payable at landed cost: price less discounts plus allocated freight. Units already counted move to on hand automatically.", screen: "bills" },
  { id: "freight_bill", when: "How to enter a freight or carrier invoice, and what freight-in versus freight-out means.",
    answer: "On Bills tap Freight bill and fill in the carrier invoice. Freight-in adds to the cost of the orders it brought in. Freight-out is shipping to customers and is an expense. Check the allocation preview before posting.", screen: "freight_bill" },
  { id: "pay_bill", when: "How to pay a vendor bill or record a full or partial payment.",
    answer: "Open Payables, then the bill number, and tap Record payment. Enter Amount, Method and Date. A partial payment is fine. The bill's Open figure is the total less paid and credited.", screen: "payables" },
  { id: "overdue_payables", when: "What the Payables screen shows: what we owe, past due, due dates and vendors.",
    answer: "Payables lists posted, unsettled bills grouped by vendor and due date. We owe is the total, Past due is what is late. Open a bill number to record a payment.", screen: "payables" },
  { id: "void_bill", when: "How to void or undo a posted bill, and why a bill can't be voided.",
    answer: "On a posted bill choose Void and hold to confirm. It reverses the entry and moves the stock back to awaiting bill with a new draft. Paid, credited or already-used stock blocks it. Use a vendor credit instead.", screen: "bills" },
  { id: "vendor_credit", when: "How to return units to a vendor or record a vendor credit or price discount.",
    answer: "Open the posted bill and choose Vendor credit. Pick Return units or Price discount, choose the line, and enter units or the credit amount. Then tap Post credit. A credit lowers Accounts Payable and is not a cash refund.", screen: "bills" },
  { id: "vendor_refund", when: "How to record a refund from a vendor, or why a bill says Vendor owes us.",
    answer: "A credit after full payment can leave the bill showing Vendor owes us. When the vendor sends the money, open that bill and tap Record vendor refund.", screen: "payables" },
  { id: "return_variance", when: "Which account the difference posts to when a vendor credit differs from the stock cost, or why it doesn't hit cost of goods sold.",
    answer: "The difference between the credit and the stock cost removed posts to 6950 Vendor Return Variance, not Cost of Goods Sold. Settings, Accounts, Account assignment shows the assignment.", screen: "settings" },
  { id: "books_check", when: "What the Books check report is or how to read it.",
    answer: "Books check compares debits with credits, inventory on hand with the stock records, inventory in transit with billed units not landed, and Accounts Payable with open bills. Read the problems it lists instead of assuming the books balance.", screen: "reports" },
  { id: "reports_overview", when: "What reports exist, where to find the trial balance, journal entries, stock value, awaiting bill, to receive or reorder.",
    answer: "Reports has Accounting (Books check, Trial balance, Journal entries), Purchases (Awaiting bill, To receive, Reorder) and Inventory (Stock value, Bundles, Inventory movement). There are no sales reports yet.", screen: "reports" },
  { id: "reorder", when: "How to set a reorder minimum or quantity, or create purchase orders for items that are low.",
    answer: "Set a default vendor, reorder minimum and reorder quantity on the item. Reports, Purchases, Reorder lists items at or under that minimum, counting on hand plus units still to receive. Bundles and serial items are left out. Create purchase orders makes one draft order per vendor, for the reorder quantity or the shortfall if larger, at last cost. Items with no vendor are skipped and named.", screen: "reports" },
  { id: "stock_value", when: "How stock value, average cost or the ledger value variance is calculated.",
    answer: "Stock value shows on-hand quantity, average cost, value and any variance from the ledger. Average cost is shared across all warehouses for each item. Units awaiting a bill are held outside the valued pool.", screen: "reports" },
  { id: "team_settings", when: "How to add or remove people, manage the team, warehouses or vendors in settings.",
    answer: "Settings has Team, Warehouses & vendors, Accounts and Company. People add themselves from Who's working? Remove deactivates a profile. The setup link on Warehouses & vendors is where more are added.", screen: "settings" },
  { id: "chart_of_accounts", when: "How to add an account, change account assignment, or what the default accounts are.",
    answer: "Settings, Accounts has Account assignment and the Chart of accounts. Enter Code, Name and type to add a posting account. Changing an unlocked assignment affects new entries only. Inventory 1200 has two locked roles, on hand and in transit.", screen: "settings" },
  { id: "test_company", when: "How to try the app with a test company or fake data.",
    answer: "Open Settings, Company, Test companies, type a name and choose Create and open. A test company starts empty and doesn't touch your main books. An orange button at the bottom takes you back. Deleting a test company can't be undone.", screen: "settings" },
  { id: "help_limits", when: "What the help assistant can and cannot do.",
    answer: "I can explain how ProfitIndex works and offer links to screens. I can't see your company records, post documents or change anything. Open the screen to look at your own data.", screen: "guide" },
];
