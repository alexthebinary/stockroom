import {
  Anchor,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type Paginated } from "../api";
import { useAuth } from "../auth";
import { PageHeader, QueryState, Stat, formatDate, money, toastErr, toastOk } from "../components/ui";

type Direction = "RECEIPT" | "DISBURSEMENT";
type PaymentRow = {
  id: number;
  paymentNumber: string;
  paidAt: string;
  amountCents: number;
  method: string;
  status: string;
  party: string;
  against: string;
  to: string | null;
};
type OpenItem = {
  kind: "invoice" | "checkout" | "bill";
  id: number;
  payPath: string;
  label: string;
  party: string;
  totalCents: number;
  outstandingCents: number;
};

const METHODS = [
  { value: "BANK", label: "Bank transfer" },
  { value: "CARD", label: "Card" },
  { value: "CASH", label: "Cash" },
  { value: "CHECK", label: "Check" },
];
const METHOD_LABEL: Record<string, string> = {
  ...Object.fromEntries(METHODS.map((m) => [m.value, m.label])),
  CREDIT_NOTE: "Credit note",
};

const COPY: Record<Direction, { title: string; subtitle: string; party: string; open: string; empty: string }> = {
  RECEIPT: {
    title: "Payments received",
    subtitle: "Money in from customers. Register a payment against an invoice, or against an order before it ships.",
    party: "Customer",
    open: "Open to collect",
    empty: "No customer payments yet.",
  },
  DISBURSEMENT: {
    title: "Payments made",
    subtitle: "Money out to suppliers. Register a payment against a vendor bill, in full or in part.",
    party: "Supplier",
    open: "Open to pay",
    empty: "No supplier payments yet.",
  },
};

/**
 * One register per direction (Sales → Payments, Purchases → Payments).
 *
 * Registering posts through the order's own pay route, the same one its page
 * uses, so the guards against overpaying and double-settling are the same.
 */
export default function Payments({ direction }: { direction: Direction }) {
  const copy = COPY[direction];
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);

  const register = useQuery({
    queryKey: ["payments", direction, page],
    queryFn: () => api.get<Paginated<PaymentRow>>(`/payments${qs({ direction, page, pageSize: 25 })}`),
  });
  const openItems = useQuery({
    queryKey: ["payments-open", direction],
    queryFn: () => api.get<{ data: OpenItem[] }>(`/payments/open${qs({ direction })}`),
  });
  const owed = (openItems.data?.data ?? []).reduce((s, r) => s + r.outstandingCents, 0);
  const rows = register.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={copy.title}
        subtitle={copy.subtitle}
        action={
          user?.can?.money && (
            <Button onClick={() => setOpen(true)} disabled={(openItems.data?.data.length ?? 0) === 0}>
              Register payment
            </Button>
          )
        }
      />

      <SimpleGrid cols={{ base: 2, md: 3 }} mb="lg">
        <Stat label={copy.open} value={money(owed)} hint={`${openItems.data?.data.length ?? 0} open`} />
        <Stat label="Payments recorded" value={register.data?.total ?? 0} />
      </SimpleGrid>

      <Card withBorder radius="md" p={0}>
        <QueryState
          isLoading={register.isLoading}
          error={register.error}
          onRetry={register.refetch}
          isEmpty={rows.length === 0}
          emptyMessage={copy.empty}
        >
          <Table.ScrollContainer minWidth={640}>
            <Table className="data-grid" verticalSpacing={8}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Payment</Table.Th>
                  <Table.Th>{copy.party}</Table.Th>
                  <Table.Th>Against</Table.Th>
                  <Table.Th>Method</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((p) => (
                  <Table.Tr key={p.id} style={p.status === "VOID" ? { opacity: 0.55 } : undefined}>
                    <Table.Td>{formatDate(p.paidAt)}</Table.Td>
                    <Table.Td fw={600}>
                      {p.paymentNumber}
                      {p.status === "VOID" && (
                        <Text span size="xs" c="dimmed">
                          {" "}
                          · reversed
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{p.party}</Table.Td>
                    <Table.Td>
                      {p.to ? (
                        <Anchor component={Link} to={p.to} size="sm">
                          {p.against}
                        </Anchor>
                      ) : (
                        p.against
                      )}
                    </Table.Td>
                    <Table.Td>{METHOD_LABEL[p.method] ?? p.method}</Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {money(p.amountCents)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {register.data && register.data.totalPages > 1 && (
            <Group justify="flex-end" p="sm">
              <Pagination value={page} onChange={setPage} total={register.data.totalPages} size="sm" />
            </Group>
          )}
        </QueryState>
      </Card>

      <RegisterPayment direction={direction} opened={open} onClose={() => setOpen(false)} items={openItems.data?.data ?? []} />
    </>
  );
}

function RegisterPayment({
  direction,
  opened,
  onClose,
  items,
}: {
  direction: Direction;
  opened: boolean;
  onClose: () => void;
  items: OpenItem[];
}) {
  const queryClient = useQueryClient();
  const [itemKey, setItemKey] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | string>("");
  const [method, setMethod] = useState<string>(direction === "RECEIPT" ? "CARD" : "BANK");
  const item = items.find((i) => `${i.kind}-${i.id}` === itemKey);

  // Choosing a document fills in what is left on it; a part payment is an edit.
  useEffect(() => {
    if (item) setAmount(item.outstandingCents / 100);
  }, [itemKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const cents = Math.round(Number(amount) * 100);
  const tooMuch = item ? cents > item.outstandingCents : false;

  const save = useMutation({
    mutationFn: () => api.post<{ payment: { paymentNumber: string } }>(item!.payPath, { amountCents: cents, method }),
    onSuccess: (r) => {
      toastOk(`${r.payment.paymentNumber} recorded · ${money(cents)}`);
      queryClient.invalidateQueries();
      setItemKey(null);
      setAmount("");
      onClose();
    },
    onError: toastErr,
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Register payment" size="md">
      <Stack gap="md">
        <Select
          label={direction === "RECEIPT" ? "Invoice or order" : "Vendor bill"}
          placeholder="Choose what this payment is for"
          searchable
          data={items.map((i) => ({
            value: `${i.kind}-${i.id}`,
            label: `${i.label} · ${i.party} · ${money(i.outstandingCents)} left`,
          }))}
          value={itemKey}
          onChange={setItemKey}
          nothingFoundMessage="Nothing open matches"
        />
        {item?.kind === "checkout" && (
          <Text size="sm" c="dimmed">
            Paid before shipping: it sits against the customer's account until the order ships and is invoiced.
          </Text>
        )}
        <Group grow align="flex-start">
          <NumberInput
            label="Amount"
            prefix="$"
            decimalScale={2}
            fixedDecimalScale
            thousandSeparator=","
            min={0}
            value={amount}
            onChange={setAmount}
            error={tooMuch ? `Only ${money(item!.outstandingCents)} is left` : undefined}
          />
          <Select label="Method" data={METHODS} value={method} onChange={(v) => setMethod(v ?? "BANK")} allowDeselect={false} />
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!item || cents <= 0 || tooMuch}>
            Record payment{cents > 0 ? ` · ${money(cents)}` : ""}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
