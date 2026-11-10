import { Alert, Button, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconAlertTriangle, IconBarcode, IconCircleCheck, IconFileInvoice, IconPlus, IconTruckDelivery } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { Checklist } from "../../components/Checklist";
import { TactileButton } from "../../components/kitchen/TactileButton";
import { Ruled, RuledRow } from "../../components/Ruled";
import { Coach } from "../../components/Coach";
import { Loading, Money, Problem, Stat, usd } from "../../components/ui";
import { get } from "../../lib/api";
import { useProfile } from "../../lib/profile";
import type { Bill, Home, PurchaseOrder, Setup } from "../../lib/types";

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
  const home = useHome();
  const sessions = useQuery({ queryKey: ["sessions", "SUBMITTED"], queryFn: () => get<unknown[]>("/scan-sessions?status=SUBMITTED") });
  const expected = useQuery({ queryKey: ["expected", "all"], queryFn: () => get<{ id: number; number: string; vendor: { name: string } | null; lines: { outstanding: number; item: { name: string } }[] }[]>("/receiving/expected") });
  return (
    <Stack gap="lg">
      <Greeting />
      <Coach id="clerk-home" title="Your job here is short">
        When a truck arrives: tap Receive, scan every box, finish. You never deal with prices or bills — accounting does that from what you scanned.
      </Coach>
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
      <Checklist
        tasks={[
          { label: "Try a practice scan", done: false, to: "/receive/practice", hint: "Point the camera at any barcode. Nothing is saved." },
          { label: "Receive your first delivery", done: (sessions.data?.length ?? 0) > 0, to: "/receive" },
        ]}
      />
    </Stack>
  );
}

function AccountingHome() {
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
        <Group>
          <IconCircleCheck color="var(--ok-fg)" />
          <Text>No bills waiting for review.</Text>
        </Group>
      )}
      <Coach id="accounting-home" title="Where bills come from">
        When the dock scans a delivery that hasn't been billed, a draft bill appears here with what arrived. Set the vendor's invoice number, check prices, add freight, post. Posting turns the waiting units into stock at their landed cost.
      </Coach>
      <Checklist
        tasks={[
          { label: "Post your first bill", done: posted.some((b) => b.kind === "INVENTORY"), to: "/bills" },
          { label: "Add a freight bill from a carrier", done: posted.some((b) => b.kind !== "INVENTORY"), to: "/bills/freight/new" },
          { label: "Pay a bill", done: posted.some((b) => b.paidCents > 0), to: "/payables" },
        ]}
      />
    </Stack>
  );
}

function AdminHome() {
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
      <Group>
        <Button component={Link} to="/orders/new" leftSection={<IconPlus size={18} />}>
          New purchase order
        </Button>
      </Group>
      <Checklist
        tasks={[
          { label: "Finish setup", done: setup.data?.company.setupCompletedAt != null, to: "/setup" },
          { label: "Place a purchase order", done: (orders.data ?? []).some((o) => o.source === "MANUAL"), to: "/orders/new", hint: "Or let the dock create one by scanning a surprise delivery." },
          { label: "See a delivery received", done: (orders.data ?? []).some((o) => o.receivingStatus !== "NOT_RECEIVED"), to: "/receive" },
          { label: "See a bill posted", done: (bills.data ?? []).some((b) => b.status === "POSTED"), to: "/bills" },
        ]}
      />
    </Stack>
  );
}
