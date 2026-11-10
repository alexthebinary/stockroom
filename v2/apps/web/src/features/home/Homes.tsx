import { Alert, Button, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconAlertTriangle, IconBarcode, IconCircleCheck, IconFileInvoice, IconPlus, IconTruckDelivery } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { GuidedPath } from "./GuidedPath";
import { AskHelp } from "./AskHelp";
import { TactileButton } from "../../components/kitchen/TactileButton";
import { Ruled, RuledRow } from "../../components/Ruled";
import { Loading, Money, Problem, Stat, usd } from "../../components/ui";
import { get } from "../../lib/api";
import { useProfile } from "../../lib/profile";
import type { Bill, Home, PurchaseOrder, Setup } from "../../lib/types";

const practiced = () => { try { return localStorage.getItem("pi.practiced") === "1"; } catch { return false; } };
const useHome = () => useQuery({ queryKey: ["home"], queryFn: () => get<Home>("/home"), refetchInterval: 30_000 });
const useOrders = () => useQuery({ queryKey: ["orders", "ALL"], queryFn: () => get<PurchaseOrder[]>("/purchase-orders?lifecycle=ALL") });
const useBills = () => useQuery({ queryKey: ["bills"], queryFn: () => get<Bill[]>("/bills"), refetchInterval: 30_000 });

function Greeting() {
  const { profile } = useProfile();
  const hour = new Date().getHours();
  return <Title order={1}>{`Good ${hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}, ${profile?.name.split(" ")[0] ?? ""}`}</Title>;
}

export function HomePage() {
  const { profile } = useProfile();
  if (profile?.job === "ACCOUNTING") return <AccountingHome />;
  if (profile?.job === "ADMIN") return <AdminHome />;
  return <ClerkHome />;
}

function ClerkHome() {
  const { profile } = useProfile();
  const name = profile?.name.split(" ")[0] ?? "";
  const home = useHome();
  const sessions = useQuery({ queryKey: ["sessions", "SUBMITTED"], queryFn: () => get<unknown[]>("/scan-sessions?status=SUBMITTED") });
  const expected = useQuery({ queryKey: ["expected", "all"], queryFn: () => get<{ id: number; number: string; vendor: { name: string } | null; lines: { outstanding: number; item: { name: string } }[] }[]>("/receiving/expected") });
  return (
    <Stack gap="lg">
      <Greeting />
      <GuidedPath name={name} intro="Your job is short: when a truck arrives, scan every box and finish. Accounting handles prices and bills from what you scanned." steps={[
        { label: "Try a practice scan", why: "Point the camera at any barcode. Nothing is saved.", to: "/receive/practice", done: practiced(), cta: "Practice" },
        { label: "Receive your first delivery", why: "Choose the warehouse and the order, scan each box, check the count, finish.", to: "/receive", done: (sessions.data?.length ?? 0) > 0, cta: "Receive a delivery" },
      ]} />
      <TactileButton to="/receive" size="xl" fullWidth>
        <IconBarcode size={30} aria-hidden="true" />
        Receive a delivery
      </TactileButton>
      {home.data?.clerk.openDeliveries ? (
        <Group gap="xs" wrap="nowrap" role="status">
          <IconTruckDelivery size={18} aria-hidden="true" />
          <Text size="sm">A delivery is still open on {home.data.clerk.openDeliveries === 1 ? "a phone" : `${home.data.clerk.openDeliveries} phones`}. Tap Receive to carry on.</Text>
        </Group>
      ) : null}
      <Stack gap="xs">
        <Text fw={600}>Expected deliveries</Text>
        {expected.error ? <Problem error={expected.error} retry={() => expected.refetch()} /> : null}
        <Ruled label="Expected deliveries" empty={expected.error ? "" : "Nothing on order right now. Surprise deliveries are fine — just scan them."}>
          {(expected.data ?? []).slice(0, 8).map((po) => (
            <RuledRow key={po.id} to={`/receive?po=${po.id}`} title={po.vendor?.name ?? "Vendor not set"} meta={`${po.number} · ${po.lines.map((l) => `${l.outstanding} × ${l.item.name}`).join(", ")}`} />
          ))}
          {(expected.data?.length ?? 0) > 8 ? <RuledRow key="more" to="/reports" title={`and ${expected.data!.length - 8} more`} /> : null}
        </Ruled>
      </Stack>
      <AskHelp />
    </Stack>
  );
}

function AccountingHome() {
  const { profile } = useProfile();
  const name = profile?.name.split(" ")[0] ?? "";
  const home = useHome();
  const bills = useBills();
  if (home.error) return <Problem error={home.error} retry={() => home.refetch()} />;
  if (!home.data) return <Loading />;
  const a = home.data.accounting;
  const drafts = (bills.data ?? []).filter((b) => b.status === "DRAFT");
  const posted = (bills.data ?? []).filter((b) => b.status === "POSTED");
  return (
    <Stack gap="lg">
      <Greeting />
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="lg">
        <Stat label="Bills to review" value={a.draftBills} />
        <Stat label="Units awaiting a bill" value={a.heldUnits} hint={a.heldUnits ? "Counted at the dock, not yet sellable" : undefined} />
        <Stat label="Unknown items" value={a.unknownItems} />
        <Stat label="We owe" value={usd(a.payableCents)} />
        <Stat label="Due in 7 days" value={usd(a.dueThisWeekCents)} />
        <Stat label="Overdue" value={usd(a.overdueCents)} />
      </SimpleGrid>
      {drafts.length > 0 ? (
        <Button component={Link} to={`/bills/${drafts[0]!.id}`} size="lg" leftSection={<IconFileInvoice />}>
          Review the next bill ({drafts[0]!.number})
        </Button>
      ) : (
        <Group gap="xs">
          <IconCircleCheck color="var(--ok-fg)" aria-hidden="true" />
          <Text>Nothing needs you right now.{a.dueThisWeekCents > 0 ? " Bills are due this week." : ""}</Text>
          {a.dueThisWeekCents > 0 ? <Button component={Link} to="/payables" variant="light" size="compact-md">Open Payables</Button> : null}
        </Group>
      )}
      <GuidedPath name={name} intro="You turn what the dock counted into stock and money: review each draft bill, post it, then pay it when it is due." steps={[
        { label: "Review and post your first bill", why: "A draft bill appears when the dock scans a delivery. Check the invoice number, prices and freight, then hold to post. The waiting units become stock at landed cost.", to: drafts[0] ? `/bills/${drafts[0].id}` : "/bills", done: posted.some((b) => b.kind === "INVENTORY"), cta: drafts[0] ? "Open the draft" : "Open Bills" },
        { label: "Add a freight bill", why: "A carrier's invoice spreads its cost over the units it carried.", to: "/bills/freight/new", done: posted.some((b) => b.kind !== "INVENTORY"), cta: "New freight bill" },
        { label: "Pay a bill", why: "Open a posted bill and record a full or part payment.", to: "/payables", done: posted.some((b) => b.paidCents > 0), cta: "Open Payables" },
      ]} />
      <AskHelp />
    </Stack>
  );
}

function AdminHome() {
  const { profile } = useProfile();
  const name = profile?.name.split(" ")[0] ?? "";
  const reorder = useQuery({ queryKey: ["reorder-count"], queryFn: () => get<unknown[]>("/reports/reorder"), retry: false });
  const home = useHome();
  const orders = useOrders();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const bills = useBills();
  if (home.error) return <Problem error={home.error} retry={() => home.refetch()} />;
  if (!home.data) return <Loading />;
  const books = home.data.admin;
  return (
    <Stack gap="lg">
      <Greeting />
      <Ruled label="Books status">
        <RuledRow
          to="/reports"
          title={
            <Group gap="sm" wrap="nowrap">
              {books.booksSound ? <IconCircleCheck size={24} color="var(--ok-fg)" aria-hidden /> : <IconAlertTriangle size={24} color="var(--warn-fg)" aria-hidden />}
              <span>{books.booksSound ? "The books are sound" : "The books need a look"}</span>
            </Group>
          }
          meta={books.booksSound ? "Trial balance balances; stock value, inbound and payables all agree with the ledger." : books.problems[0]}
        />
      </Ruled>
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="lg">
        <Stat label="Open orders" value={(orders.data ?? []).filter((o) => o.lifecycle === "OPEN" && o.receivingStatus !== "RECEIVED").length} />
        <Stat label="Bills to review" value={home.data.accounting.draftBills} />
        <Stat label="We owe" value={<Money cents={home.data.accounting.payableCents} />} />
      </SimpleGrid>
      <Ruled label="Needs attention" empty="Nothing needs you right now.">
        {[
          home.data.accounting.draftBills > 0 ? <RuledRow key="d" to="/bills" title={`${home.data.accounting.draftBills} bill${home.data.accounting.draftBills === 1 ? "" : "s"} to review`} meta="Drafts from the dock are waiting for accounting" /> : null,
          home.data.accounting.heldUnits > 0 ? <RuledRow key="h" to="/reports" title={`${home.data.accounting.heldUnits} unit${home.data.accounting.heldUnits === 1 ? "" : "s"} awaiting a bill`} meta="Counted at the dock, not yet sellable" /> : null,
          home.data.accounting.overdueCents > 0 ? <RuledRow key="o" to="/payables" title="Payables are overdue" aside={<Money cents={home.data.accounting.overdueCents} />} /> : null,
          (reorder.data?.length ?? 0) > 0 ? <RuledRow key="r" to="/reports" title={`${reorder.data!.length} item${reorder.data!.length === 1 ? "" : "s"} at or under the reorder minimum`} meta="Open Reports, Purchases, Reorder" /> : null,
        ]}
      </Ruled>
      <Group>
        <Button component={Link} to="/orders/new" leftSection={<IconPlus size={18} />}>
          New purchase order
        </Button>
      </Group>
      <GuidedPath name={name} intro="You set the business up and watch it run. Four steps take you from an empty company to a posted bill." steps={[
        { label: "Finish setup", why: "Company details, people, warehouses, vendors and items.", to: "/setup", done: setup.data?.company.setupCompletedAt != null, cta: "Continue setup" },
        { label: "Place a purchase order", why: "An order commits to buy and posts no money. The dock can also create one by scanning a surprise delivery.", to: "/orders/new", done: (orders.data ?? []).some((o) => o.source === "MANUAL"), cta: "New purchase order" },
        { label: "See a delivery received", why: "On a phone, open Receive, scan the boxes and finish.", to: "/receive", done: (orders.data ?? []).some((o) => o.receivingStatus !== "NOT_RECEIVED"), cta: "Open Receive" },
        { label: "See a bill posted", why: "Accounting posts the draft bill and the units land in stock at landed cost.", to: "/bills", done: (bills.data ?? []).some((b) => b.status === "POSTED"), cta: "Open Bills" },
      ]} />
      <AskHelp />
    </Stack>
  );
}
