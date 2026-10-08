import { Alert, Button, Card, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconAlertTriangle, IconBarcode, IconCircleCheck, IconFileInvoice, IconPlus, IconTruckDelivery } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { Checklist } from "../../components/Checklist";
import { Coach } from "../../components/Coach";
import { Loading, Money, Stat, usd } from "../../components/ui";
import { get } from "../../lib/api";
import { useProfile } from "../../lib/profile";
import type { Bill, Home, PurchaseOrder, Setup } from "../../lib/types";

const useHome = () => useQuery({ queryKey: ["home"], queryFn: () => get<Home>("/home"), refetchInterval: 30_000 });
const useOrders = () => useQuery({ queryKey: ["orders", "ALL"], queryFn: () => get<PurchaseOrder[]>("/purchase-orders?lifecycle=ALL") });
const useBills = () => useQuery({ queryKey: ["bills"], queryFn: () => get<Bill[]>("/bills") });

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
      <Button component={Link} to="/receive" size="xl" h={88} leftSection={<IconBarcode size={32} />} styles={{ label: { fontSize: 22 } }}>
        Receive a delivery
      </Button>
      {home.data?.clerk.openDeliveries ? (
        <Alert color="blue" icon={<IconTruckDelivery size={18} />}>
          A delivery is still open on {home.data.clerk.openDeliveries === 1 ? "a phone" : `${home.data.clerk.openDeliveries} phones`}. Tap Receive to carry on with yours.
        </Alert>
      ) : null}
      <Stack gap="xs">
        <Text fw={600}>Expected deliveries</Text>
        {(expected.data ?? []).length === 0 ? <Text c="dimmed">Nothing on order right now. Surprise deliveries are fine — just scan them.</Text> : null}
        {(expected.data ?? []).slice(0, 8).map((po) => (
          <Card key={po.id} withBorder padding="sm">
            <Text fw={600}>{po.vendor?.name ?? "Vendor not set"}</Text>
            <Text size="sm" c="dimmed">
              {po.number} · {po.lines.map((l) => `${l.outstanding} × ${l.item.name}`).join(", ")}
            </Text>
          </Card>
        ))}
      </Stack>
      <Checklist
        tasks={[
          { label: "Try a practice scan", done: false, to: "/receive/practice", hint: "Point the camera at the test sheet. Nothing is saved." },
          { label: "Receive your first delivery", done: (sessions.data?.length ?? 0) > 0, to: "/receive" },
        ]}
      />
    </Stack>
  );
}

function AccountingHome() {
  const home = useHome();
  const bills = useBills();
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
          <IconCircleCheck color="var(--mantine-color-lime-7)" />
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
  if (!home.data) return <Loading />;
  const books = home.data.admin;
  return (
    <Stack gap="lg">
      <Greeting />
      <UnstyledButton component={Link} to="/reports">
        <Card withBorder padding="lg">
          <Group wrap="nowrap">
            {books.booksSound ? <IconCircleCheck size={32} color="var(--mantine-color-lime-7)" /> : <IconAlertTriangle size={32} color="var(--mantine-color-orange-7)" />}
            <div>
              <Text fw={600}>{books.booksSound ? "The books are sound" : "The books need a look"}</Text>
              <Text size="sm" c="dimmed">
                {books.booksSound ? "Trial balance balances; stock value, inbound and payables all agree with the ledger." : books.problems[0]}
              </Text>
            </div>
          </Group>
        </Card>
      </UnstyledButton>
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="lg">
        <Stat label="Open orders" value={(orders.data ?? []).filter((o) => o.lifecycle === "OPEN" && o.receivingStatus !== "RECEIVED").length} />
        <Stat label="Bills to review" value={home.data.accounting.draftBills} />
        <Stat label="We owe" value={<Money cents={home.data.accounting.payableCents} />} />
      </SimpleGrid>
      <Group>
        <Button component={Link} to="/orders/new" leftSection={<IconPlus size={18} />}>
          New purchase order
        </Button>
        <Button component={Link} to="/test-sheet" variant="light">
          Test sheet
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
