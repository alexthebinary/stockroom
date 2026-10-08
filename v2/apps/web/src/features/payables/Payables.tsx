import { Card, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Coach } from "../../components/Coach";
import { formatDate, Loading, Money, PageHeader, Stat, usd } from "../../components/ui";
import { get } from "../../lib/api";

type Aging = {
  buckets: string[];
  vendors: { vendor: { id: number; name: string }; totalCents: number; bills: { id: number; number: string; vendorInvoiceNumber: string | null; dueDate: string; openCents: number; bucket: string }[] } & Record<string, unknown>[];
};

/** What we owe, oldest due first, by vendor. Tap a bill to pay it. */
export function Payables() {
  const aging = useQuery({ queryKey: ["ap-aging"], queryFn: () => get<Aging>("/reports/ap-aging") });
  if (!aging.data) return <Loading />;
  const vendors = aging.data.vendors as unknown as { vendor: { id: number; name: string }; totalCents: number; bills: { id: number; number: string; vendorInvoiceNumber: string | null; dueDate: string; openCents: number; bucket: string }[]; [k: string]: unknown }[];
  const total = vendors.reduce((s, v) => s + v.totalCents, 0);
  const late = vendors.reduce((s, v) => s + v.bills.filter((b) => b.bucket !== "current").reduce((x, b) => x + b.openCents, 0), 0);
  return (
    <>
      <PageHeader title="Payables" subtitle="Posted bills not yet settled, by due date." />
      <Coach id="payables" title="Paying a bill">
        Open a bill and tap Record payment — in full or in part. A vendor credit after you've paid leaves them owing you; record their refund the same way.
      </Coach>
      <SimpleGrid cols={{ base: 2, sm: 3 }} mb="lg" spacing="lg">
        <Stat label="We owe" value={usd(total)} />
        <Stat label="Past due" value={usd(late)} />
        <Stat label="Vendors" value={vendors.length} />
      </SimpleGrid>
      {vendors.length === 0 ? <Text c="dimmed">Nothing owed.</Text> : null}
      <Stack>
        {vendors.map((v) => (
          <Card key={v.vendor.id} withBorder>
            <Group justify="space-between" mb="xs">
              <Text fw={600}>{v.vendor.name}</Text>
              <Text fw={600}>
                <Money cents={v.totalCents} />
              </Text>
            </Group>
            <Table.ScrollContainer minWidth={420}>
              <Table>
                <Table.Tbody>
                  {v.bills.map((b) => (
                    <Table.Tr key={b.id}>
                      <Table.Td>
                        <Text component={Link} to={`/bills/${b.id}`} td="underline" inherit>
                          {b.number}
                        </Text>
                        {b.vendorInvoiceNumber ? (
                          <Text span c="dimmed" size="sm">
                            {" "}
                            · {b.vendorInvoiceNumber}
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td c={b.bucket === "current" ? undefined : "orange"}>{b.bucket === "current" ? `due ${formatDate(b.dueDate)}` : `${b.bucket} days late`}</Table.Td>
                      <Table.Td ta="right">
                        <Money cents={b.openCents} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        ))}
      </Stack>
    </>
  );
}
