import { Card, List, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { PageHeader } from "../../components/ui";

function Section({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <Card withBorder className="section">
      <Title order={2} mb="xs">
        {title}
      </Title>
      {lead ? <Text mb="sm">{lead}</Text> : null}
      {children}
    </Card>
  );
}

function Flow({ title, steps }: { title: string; steps: [string, string][] }) {
  return (
    <Stack gap="xs">
      <Text fw={600}>{title}</Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {steps.map(([name, detail]) => (
          <Card key={name} withBorder>
            <Text fw={600}>{name}</Text>
            <Text size="sm" c="dimmed">
              {detail}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

/** How the system works, one section per nav area, in nav order. */
export function Guide() {
  return (
    <Stack gap="lg">
      <PageHeader title="About" subtitle="What each screen is for, the main action, and what it posts." />
      <Text>
        ProfitIndex records buying, receiving, selling, and the journal those documents write. A purchase order or a sales order commits to a deal and posts no money. A vendor bill, warehouse receipt, shipment, invoice, payment, or stock adjustment writes the journal. Each item has one average landed cost, shared by every warehouse. Home shows the work waiting for your job and posts nothing. Your job (clerk, accounting, or admin) chooses the menu. On a phone the bottom tabs are the daily tasks, and More opens the rest. You pick your name on Who's working. There is no password.
      </Text>

      <Section title="Document flow" lead="Two chains. The order commits. A later document posts the money. A warehouse document moves the units.">
        <Stack gap="md">
          <Flow
            title="Buying"
            steps={[
              ["1. Purchase order", "Commits to buy. Posts nothing. It tells the dock what to expect. Number PO-00001 and up. Billing, payment, and receiving each move on their own."],
              ["2. Vendor bill", "Posts the money for the goods: Dr Inventory / Cr Accounts Payable, at landed cost (price, less discounts, plus freight spread over the lines). Number BILL-00001 and up."],
              ["3. Warehouse receipt", "Records the boxes that arrived. Number WH-IN-00001 and up. Within Inventory Asset it moves value from in transit to on hand. Boxes that arrive first wait for this bill."],
            ]}
          />
          <Flow
            title="Selling"
            steps={[
              ["1. Sales order", "Commits to sell. Posts nothing. Number SO-00001 and up. Invoicing, payment, and shipping each move on their own."],
              ["2. Sales shipment", "Hold to ship remaining takes the units still to ship out of that warehouse at average cost. Number WH-OUT-00001 and up. Moves the cost within Inventory Asset (1200) from on hand to shipped, not yet invoiced. If the units were already invoiced, the same entry also moves that cost to Cost of Goods Sold. Shipping more than is on hand is refused and posts nothing."],
              ["3. Invoice", "Hold to create invoice bills the quantity not yet invoiced, at the order price. Number INV-00001 and up. Debits Accounts Receivable for the total and credits Sales Revenue, Shipping & Handling Revenue and Sales Tax Payable. For units already shipped it also moves their cost from shipped, not yet invoiced to Cost of Goods Sold. It can come before or after the goods ship."],
              ["4. Customer payment", "On the invoice, enter the amount and hold Record payment. Number CP-00001 and up. Debits Bank / Cash and credits Accounts Receivable, in full or in part, and never more than is still open."],
            ]}
          />
        </Stack>
      </Section>

      <Section title="Sales" lead="Customer orders, invoices, what customers still owe, and the shipments those orders send out.">
        <List spacing={6}>
          <List.Item>
            <b>Sales orders.</b> Open Sales orders and tap New. Choose the customer and the warehouse the goods leave from. Add each item with a quantity and a price, then Create order. You can type a new customer name, a shipping and handling amount, a sales tax rate, and notes. A customer added by name is stored with 30-day terms. Open an order to change lines while it is still open. A line that has shipped or been invoiced cannot drop below that quantity, and an invoiced line keeps its price. Cancel an order only before anything has shipped and before a posted invoice exists. Serial-tracked items and bundles are not on a sales order. Ship a bundle from Stock, or sell its components. Posts nothing. Tick rows to export them to CSV.
          </List.Item>
          <List.Item>
            <b>Invoices.</b> On the order, hold to create invoice. The due date is the invoice date plus the customer's terms. The total is the goods, plus shipping and handling not already billed, plus tax at the order's rate. The total debits Accounts Receivable. The goods credit Sales Revenue (4000), shipping and handling credits Shipping & Handling Revenue (4100), and tax credits Sales Tax Payable (2100). For units that have shipped, the invoice also debits Cost of Goods Sold and credits Inventory Asset (shipped, not yet invoiced). Each entry names the invoice and its sales order. Void… reverses that entry and returns the cost to shipped, not yet invoiced, and only while no payment has been recorded. Voiding does not put the units back into stock. The invoice list shows each invoice's open balance.
          </List.Item>
          <List.Item>
            <b>Receivables.</b> Posted invoices that still have a balance, grouped by customer. Current means not yet past the due date. 1–30, 31–60, 61–90, and 90+ are days late. They owe, Past due, and Customers summarize it. Open an invoice number to record the payment. The list posts nothing.
          </List.Item>
          <List.Item>
            <b>Customer payments.</b> On a posted invoice with a balance, enter Amount $ and hold Record payment. The payment number is CP-00001 and up. It debits Bank / Cash and credits Accounts Receivable. The amount cannot be more than what is still open.
          </List.Item>
          <List.Item>
            <b>Sales shipments.</b> Hold to ship remaining on the order writes the WH-OUT document and moves the units' average cost within Inventory Asset from on hand to shipped, not yet invoiced. Cost of Goods Sold is recognized when the invoice covers those units. The entry names the shipment and its sales order. Stock lists those documents under Sales shipments, with the order and the customer. A bundle ships from its Inventory row. That takes every component out of the chosen warehouse at its average cost and debits Cost of Goods Sold. If any component is short, nothing is shipped.
          </List.Item>
        </List>
      </Section>

      <Section title="Purchases" lead="Orders to vendors, their bills, and what we still owe.">
        <List spacing={6}>
          <List.Item>
            <b>Purchase orders.</b> On Orders, New opens Vendor, Deliver to, Item, Qty, and Unit $. Create order saves it. Number PO-00001 and up. Open an order to see its lines and related documents. Enter the vendor's bill prepares its bill. Billing, payment, and receiving each have their own status. Posts nothing. Tick rows to export them to CSV.
          </List.Item>
          <List.Item>
            <b>Vendor bills.</b> Bills is accounting's inbox. To review lists drafts. Unpaid lists posted bills with an open balance. Unknown items is the dock's unmatched scans. All lists every bill. Open a draft to check the vendor, vendor invoice number, dates, quantities, prices, discounts, and shipping. Save for later saves the draft. Discard draft removes an unposted draft. Hold to post bill posts it. A vendor, an invoice number, and a positive total are required. Posting debits Inventory Asset and credits Accounts Payable at landed cost. Units already counted at the dock move to on hand in the same moment. Billed units not yet received stay in transit. A posted bill with units still outstanding offers Receive these. Number BILL-00001 and up.
          </List.Item>
          <List.Item>
            <b>Freight bills.</b> Freight bill on Bills opens the carrier invoice. Choose Bringing stock in or Shipping to customers. Freight-in adds to the cost of the orders it brought: units not yet here cost more on arrival, units on the shelf raise the average, and units already gone go to cost of goods sold. Freight-out debits Outbound Shipping Expense and credits Accounts Payable. Review the allocation and the posting preview before posting.
          </List.Item>
          <List.Item>
            <b>Unknown items.</b> On Bills, Unknown items, a box may offer Match to an item when it looks like something still on the order, something this vendor has supplied before, or the same brand. One tap matches that item and remembers the barcode. You can choose a different item. A person always confirms.
          </List.Item>
          <List.Item>
            <b>Vendor credits.</b> On a posted inventory bill, choose Vendor credit. Return units, or Price discount. Received units leave on-hand stock at average cost. Units that never arrived reduce inventory in transit. The credit debits Accounts Payable. When its amount differs from the stock cost removed, the difference posts to Vendor Return Variance. A price discount reduces the cost of units still in transit or on hand, or cost of goods sold for units already gone. The credit number is VC-00001 and up. If a credit after payment leaves Vendor owes us, Record vendor refund records the money when it arrives. A credit is not itself a cash refund. Void… on a posted bill reverses the entry and moves landed stock back to awaiting bill with a fresh draft. A bill that is paid, credited, or whose stock was already used cannot be voided.
          </List.Item>
          <List.Item>
            <b>Payables.</b> Posted unsettled bills, grouped by vendor and due date. We owe, Past due, and Vendors summarize it. Aging uses the same buckets as receivables: current, 1–30, 31–60, 61–90, and 90+. Open a bill and tap Record payment. Enter Amount $, a method (ACH, wire, check, card, bank, or cash), and a date. A full or partial payment debits Accounts Payable and credits Bank / Cash. Number PAY-00001 and up. Open on the bill is the total less what is paid and credited.
          </List.Item>
        </List>
      </Section>

      <Section title="When the boxes arrive before the bill">
        <Text>
          The clerk scans them anyway. They are counted and visible as <b>awaiting bill</b>, but not sellable and not valued, because only a bill may create the financial entry. A draft bill is made from what arrived; when accounting posts it, the units land in stock at their landed cost — automatically, in the same moment.
        </Text>
      </Section>

      <Section title="Average cost">
        <List spacing={4}>
          <List.Item>Each item has one average cost across all warehouses. New stock joins it at landed cost.</List.Item>
          <List.Item>A carrier's freight bill raises the cost of the units it carried: units not yet here cost more on arrival, units on the shelf raise the average, units already gone go to cost of goods sold.</List.Item>
          <List.Item>Returns of received units leave at average cost. If the vendor credits a different amount, the difference posts to Vendor Return Variance.</List.Item>
          <List.Item>A price discount, with no units returned, reduces the cost of units still in transit or on hand, or cost of goods sold for units already gone.</List.Item>
        </List>
      </Section>

      <Section title="Stock" lead="What is on the shelf, what arrived, what left for a customer, and what was counted or adjusted.">
        <List spacing={6}>
          <List.Item>
            <b>Inventory.</b> Every item and bundle, with on hand, awaiting bill, and price. Search by name, SKU, brand, or barcode, and filter by brand or category. + Add item asks for a SKU and a name. Upload CSV previews new items. Download template gives the columns. Nothing is added until you confirm the import. Existing SKUs are edited one by one. Edit covers name, weight, size, brand, category, default vendor, reorder minimum, and reorder quantity. The SKU is set when the item is added. Tick rows to export them to CSV, print labels, or, from two or more ordinary items, create a bundle.
          </List.Item>
          <List.Item>
            <b>Warehouse receipts.</b> Every WH-IN. Open one to see its order, vendor, and the items counted. When a bill is already posted, the receipt debits Inventory on hand and credits Inventory in transit for the same amount. Both roles use account 1200 Inventory Asset, so the receipt nets to zero on that account and does not create a second payable. Partial deliveries leave the rest to receive.
          </List.Item>
          <List.Item>
            <b>Sales shipments.</b> The WH-OUT documents sent to customers, newest first, with the order, the customer, and the units. Shipping is done from the sales order, or from Ship on a bundle row. This tab is the register.
          </List.Item>
          <List.Item>
            <b>Stock adjustments.</b> Opening stock, gains, losses, and reclassifications. Open one to see each line. New transaction posts one of four kinds. Opening stock debits Inventory Asset and credits Opening Balance Equity, and it asks for a unit cost. A gain debits Inventory Asset and credits Inventory Adjustment Gain. A loss debits Inventory Adjustment Loss and credits Inventory Asset. A reclassification moves quantity and cost to a new item. The inventory asset total does not change. Posting is final. Fix a mistake with a reversing adjustment. Bundles and serial-tracked items are not adjusted here. Number ADJ-00001 and up.
          </List.Item>
          <List.Item>
            <b>Receive on phone.</b> Receive a delivery. Choose the warehouse when there is more than one. Pick an expected order, or pick the supplier, or choose Not sure so accounting can match the paperwork later. Open scanner reads the box barcode. No barcode? Pick the item. For a serial-tracked item, scan or type each unit's serial. The count must have the matching serials. Check the quantities, then Finish delivery. That writes a WH-IN receipt. Unknown items are set aside for accounting and do not stop finishing. Abandon delivery is available while scanning. With no posted bill, the goods stay awaiting bill and a draft appears under Bills, To review. With a posted bill, receiving moves the value from in transit to on hand.
          </List.Item>
          <List.Item>
            <b>Stock count.</b> Pick the warehouse. With one warehouse it is already selected. The count starts empty. Scan a barcode or search for an item. Type the count, or use minus and plus. Scanning the same item again adds to its count. Review lists only the lines that differ from on hand. Items you did not count are left as they are. A partial count is fine. The reason starts as Stock count and today's date, and it is stored on the adjustment. Finish count posts every difference as one ADJ document. Serial-tracked items and bundles stay in the search list, disabled. Count a bundle by counting its components.
          </List.Item>
          <List.Item>
            <b>Labels and bundles.</b> Tick items and tap Print labels. Each label is 4 by 2 inches and shows the SKU, the name, and a barcode (the item's first barcode, or its SKU). Choose how many copies, then Print. A bundle is a sellable item made of a fixed recipe of other items. It has no stock of its own. Available is how many complete bundles the components on hand can make. Create bundle asks for a name, a SKU, an optional price, and the component rows. The price is only what you type. Serial-tracked items cannot be components, and a bundle cannot contain another bundle. A bundle cannot be received. Receive and adjust its components.
          </List.Item>
        </List>
      </Section>

      <Section title="Reports" lead="Read the books and the stock. Nothing on this screen posts.">
        <List spacing={6}>
          <List.Item>
            <b>Books check.</b> Four comparisons run on demand: debits equal credits; inventory on hand equals stock at average cost, item by item; inventory in transit equals billed stock not yet arrived; Accounts Payable equals open bills, vendor by vendor. Read the lines that do not agree.
          </List.Item>
          <List.Item>
            <b>Trial balance</b> lists each account balance and the debit and credit totals.
          </List.Item>
          <List.Item>
            <b>Journal</b> entries lists every financial entry, newest first, with its debit and credit lines. Filter by event, text, and dates, and load more. Numbers run JE-000001 and up.
          </List.Item>
          <List.Item>
            <b>Awaiting bill</b> shows goods counted at the dock that still need a posted bill, oldest first. The amounts there are estimates. They are not booked inventory value. <b>To receive</b> lists open orders with units still outstanding, their warehouse, vendor, and age. Billed units not yet received are inventory in transit. Unbilled expected units have no posted inventory value.
          </List.Item>
          <List.Item>
            <b>Reorder</b> lists items at or under their minimum, counting what is already on order. <b>Stock value</b> shows on-hand quantity, awaiting bill, average cost, stock value, and the ledger's on-hand value. <b>Bundles</b> lists each bundle and its components. <b>Inventory movement</b> lists stock movements. The Sales group has no reports.
          </List.Item>
          <List.Item>
            Aging of what customers owe is on Receivables. Aging of what we owe vendors is on Payables. Reports does not have its own aging tab.
          </List.Item>
          <List.Item>
            <b>CSV exports.</b> Trial balance, Journal entries, Stock value, Bundles, and Inventory movement each have Export to CSV file for the rows on screen. Reorder exports the rows you tick. Books check, Awaiting bill, and To receive do not.
          </List.Item>
        </List>
      </Section>

      <Section title="Settings" lead="Company, people, places, and which account each posting uses. Changing an assignment does not rewrite entries already posted.">
        <List spacing={6}>
          <List.Item>
            <b>First setup.</b> A new company asks for company details and people, then how to start. Sample data adds a warehouse, a supplier, a carrier, and three items, with no stock and no transactions. Starting empty also asks for warehouses, vendors, items, and opening stock. Opening stock debits Inventory Asset and credits Opening Balance Equity.
          </List.Item>
          <List.Item>
            <b>Team.</b> People and their jobs: clerk, accounting, or admin. Remove deactivates a profile. People add themselves from Who's working. The avatar menu has Switch person, Appearance (Match this device, Light, or Dark), and Show tips again. An admin also has Switch company… there.
          </List.Item>
          <List.Item>
            <b>Warehouses and vendors.</b> Add a warehouse with a short code and a name. Vendors are suppliers or carriers, with payment terms. Those terms set a vendor bill's due date. More vendors are added from the setup link on this tab.
          </List.Item>
          <List.Item>
            <b>Chart of accounts and account assignment.</b> Accounts has both. Code, name, and type add a posting account. A header account only totals its children. Entries use active accounts that are not headers. Account assignment maps each posting role to an account. Inventory on hand and Inventory billed, in transit are locked to 1200 Inventory Asset. Other roles can be pointed at a different account. The change affects new entries only. The chart also includes accounts the screens do not post to, including sales tax payable, shipping and handling revenue, and sales returns. An invoice's shipping and tax stay inside the Sales Revenue credit.
          </List.Item>
          <List.Item>
            <b>Company.</b> Company settings, including the Beta feedback tab on the edge of each screen. Test companies: type a name and choose Create and open, or use Switch company… in the avatar menu. A test company starts empty and runs setup. The main company's books stay as they are. While you are in one, a Test company button at the bottom of every screen switches you back. Switching asks who's working again. Deleting a test company removes everything in it. The main company cannot be deleted.
          </List.Item>
        </List>
      </Section>

      <Section title="Helpers that suggest, never post">
        <List spacing={4}>
          <List.Item><b>Reorder</b> (Reports): items at or under their minimum, counting what is already on order. Tick rows and create one draft purchase order per default vendor. A row with no default vendor is skipped and named.</List.Item>
          <List.Item><b>Match to order</b> on a vendor bill: ordered, received and billed side by side, with a warning when a price is more than 1% off the order. It never blocks posting. Freight bills and bills with no purchase order do not show it.</List.Item>
          <List.Item><b>Unknown items</b> (Bills): the likely items for an unrecognised box are offered as one-tap matches. A person always confirms.</List.Item>
          <List.Item><b>Help</b> answers from the help pages and can link to the right screen. It does not read your company records, and it does not post.</List.Item>
        </List>
      </Section>

      <Section title="Feedback and Help" lead="Notes about the app, and answers about how it works. Neither one posts to the books.">
        <List spacing={6}>
          <List.Item>
            <b>Feedback.</b> The Feedback tab on the right edge of a screen lets a tester pin a note on what they see. Settings, Company, turns that tab on or off. The Feedback page lists the notes. Needs attention, Questions for Serhii, Open, Done, and Won't fix are the views. Needs attention is an open note still waiting on an answer or a confirmed spec. Questions for Serhii are follow-ups from the build team; an open one has a box for the answer. Copy open as Markdown, or Download. Open page returns to the screen the note was pinned on. Done, Won't fix, and Reopen change the note. When clarify is available, Clarify asks the questions that turn the note into a spec.
          </List.Item>
          <List.Item>
            <b>Help.</b> The help button in the header opens a panel for the screen you are on. It answers from the help pages and can offer Take me there. It is shown when help is configured. It does not count stock, post a document, or look up a balance.
          </List.Item>
        </List>
      </Section>
    </Stack>
  );
}
