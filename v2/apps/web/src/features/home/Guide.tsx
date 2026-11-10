import { Card, List, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { PageHeader } from "../../components/ui";

/** How the system works, in the client's own document order. */
export function Guide() {
  return (
    <Stack gap="lg">
      <PageHeader title="About" subtitle="Purchase Order → Vendor Bill → Warehouse Receipt, and why stock sometimes waits." />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        {[
          ["1. Purchase order", "Commits to buy. Posts nothing — it only tells the dock what to expect. Its three statuses move on their own: billed, paid, received."],
          ["2. Vendor bill", "The only purchase document that posts money: Dr Inventory / Cr Accounts Payable, at landed cost (price, less discounts, plus freight spread over the lines)."],
          ["3. Warehouse receipt", "Records the boxes physically arriving (the WH-IN register). Within Inventory Asset it moves value from in transit to on hand, and it is always triggered by the bill."],
        ].map(([t, d]) => (
          <Card key={t} withBorder>
            <Text fw={600}>{t}</Text>
            <Text size="sm" c="dimmed">
              {d}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
      <Card withBorder className="section">
        <Title order={3} mb="xs">
          When the boxes arrive before the bill
        </Title>
        <Text>
          The clerk scans them anyway. They are counted and visible as <b>awaiting bill</b>, but not sellable and not valued, because only a bill may create the financial entry. A draft bill is made from what arrived; when accounting posts it, the units land in stock at their landed cost — automatically, in the same moment.
        </Text>
      </Card>
      <Card withBorder className="section">
        <Title order={3} mb="xs">
          Average cost
        </Title>
        <List spacing={4}>
          <List.Item>Each item has one average cost across all warehouses. New stock joins it at landed cost.</List.Item>
          <List.Item>A carrier's freight bill raises the cost of the units it carried: units not yet here cost more on arrival, units on the shelf raise the average, units already gone go to cost of goods sold.</List.Item>
          <List.Item>Returns leave at average cost; if the vendor credits a different amount, the difference goes to cost of goods sold.</List.Item>
        </List>
      </Card>
      <Card withBorder className="section">
        <Title order={3} mb="xs">
          Stock: where things are
        </Title>
        <List spacing={4}>
          <List.Item><b>Inventory</b> lists every item and bundle with on hand, awaiting bill and price. Tick rows to export them to CSV, print barcode labels or build a bundle from them.</List.Item>
          <List.Item><b>Warehouse Receipts</b> lists every WH-IN. Open one to see its order, vendor and the items counted.</List.Item>
          <List.Item><b>Stock Adjustments</b> lists opening stock, gains and losses. Open one to see each line it moved.</List.Item>
          <List.Item><b>Stock count</b> (phone): pick the warehouse, scan or search items, type what you counted and Finish. Every difference posts as one adjustment number. Items you did not count are left alone.</List.Item>
        </List>
      </Card>
      <Card withBorder className="section">
        <Title order={3} mb="xs">
          Helpers that suggest, never post
        </Title>
        <List spacing={4}>
          <List.Item><b>Reorder</b> (Reports, Purchases): items at or under their minimum, counting what is already on order. Tick rows and create one draft order per vendor.</List.Item>
          <List.Item><b>Match to order</b> on a vendor bill: ordered, received and billed side by side, with a warning when a price is more than 1% off the order. It never blocks posting.</List.Item>
          <List.Item><b>Unknown items</b> (Bills): the likely items for an unrecognised box are offered as one-tap matches. A person always confirms.</List.Item>
          <List.Item><b>Help</b> answers common questions at once from the help pages, and links to the right screen.</List.Item>
        </List>
      </Card>
      <Card withBorder className="section">
        <Title order={3} mb="xs">
          The books check
        </Title>
        <Text>Four comparisons run on demand (Reports): debits equal credits; inventory on hand equals stock at average cost, item by item; inventory in transit equals billed stock not yet arrived; Accounts Payable equals open bills, vendor by vendor.</Text>
      </Card>
    </Stack>
  );
}
