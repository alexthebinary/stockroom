import { Button, Card, Container, Group, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconPrinter } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import wasmUrl from "zxing-wasm/writer/zxing_writer.wasm?url";
import { Loading, usd } from "../../components/ui";
import { get } from "../../lib/api";
import type { Setup } from "../../lib/types";

prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) }, fireImmediately: true });

function Code({ text, format }: { text: string; format: "UPCA" | "Code128" }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    writeBarcode(text, { format, scale: 3, addHRT: true, addQuietZones: true }).then((r) => setSvg(r.svg));
  }, [text, format]);
  return svg ? <div style={{ background: "#fff", padding: 8, borderRadius: 6, maxWidth: 360 }} dangerouslySetInnerHTML={{ __html: svg }} /> : <Loading />;
}

/**
 * Something to scan before the real deliveries come: the sample items'
 * barcodes, two serial labels and a packing slip for the Claude reader.
 * Works off a screen or printed.
 */
export function TestSheet() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  if (!setup.data) return <Loading />;
  const s = setup.data.sample;
  return (
    <Container size={860} py="lg">
      <Group justify="space-between" mb="lg" className="no-print">
        <Title order={1}>Test sheet</Title>
        <Button leftSection={<IconPrinter size={18} />} onClick={() => window.print()}>
          Print
        </Button>
      </Group>
      {!s.loaded ? (
        <Text c="dimmed" mb="md">
          These codes belong to the sample items, which aren't loaded in this company. Load sample data in setup to scan them.
        </Text>
      ) : null}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
        <Card withBorder>
          <Text fw={600}>{s.widget.name}</Text>
          <Text size="sm" c="dimmed" mb="xs">
            UPC-A · counted stock
          </Text>
          <Code text={s.widget.barcode} format="UPCA" />
        </Card>
        <Card withBorder>
          <Text fw={600}>{s.robot.name}</Text>
          <Text size="sm" c="dimmed" mb="xs">
            UPC-A · asks for a serial per unit
          </Text>
          <Code text={s.robot.barcode} format="UPCA" />
        </Card>
        {s.serials.map((serial) => (
          <Card withBorder key={serial}>
            <Text fw={600}>Serial label {serial}</Text>
            <Text size="sm" c="dimmed" mb="xs">
              Scan after the robot's barcode
            </Text>
            <Code text={serial} format="Code128" />
          </Card>
        ))}
        <Card withBorder>
          <Text fw={600}>{s.openBox.name}</Text>
          <Text size="sm" c="dimmed" mb="xs">
            Code 128
          </Text>
          <Code text={s.openBox.barcode} format="Code128" />
        </Card>
        <Card withBorder>
          <Text fw={600}>Not in the catalog</Text>
          <Text size="sm" c="dimmed" mb="xs">
            Shows how an unknown box is set aside
          </Text>
          <Code text="UNKNOWN-BOX-42" format="Code128" />
        </Card>
      </SimpleGrid>

      <Card withBorder mt="xl" padding="xl" style={{ background: "#fff", color: "#111" }}>
        <Stack gap="xs">
          <Group justify="space-between" align="flex-start">
            <div>
              <Text fw={700} size="xl">
                {s.supplier.name}
              </Text>
              <Text size="sm">400 Industrial Way, Newtown, PA 18940</Text>
            </div>
            <div style={{ textAlign: "right" }}>
              <Text fw={700} size="lg">
                PACKING SLIP
              </Text>
              <Text size="sm">Slip no. PS-1001</Text>
              <Text size="sm">Date: {new Date().toLocaleDateString("en-US")}</Text>
            </div>
          </Group>
          <Text size="sm">Ship to: {setup.data.company.name || "Your company"}</Text>
          <Table withTableBorder mt="sm" style={{ color: "#111" }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Item no.</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th ta="right">Qty shipped</Table.Th>
                <Table.Th ta="right">Unit price</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>{s.widget.vendorSku}</Table.Td>
                <Table.Td>{s.widget.name}</Table.Td>
                <Table.Td ta="right">2</Table.Td>
                <Table.Td ta="right">{usd(s.widget.costCents)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>{s.robot.vendorSku}</Table.Td>
                <Table.Td>
                  {s.robot.name}
                  <br />
                  S/N {s.serials[0]}
                </Table.Td>
                <Table.Td ta="right">1</Table.Td>
                <Table.Td ta="right">{usd(s.robot.costCents)}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
          <Text size="xs">Thank you for your business. Report damage within 48 hours.</Text>
        </Stack>
      </Card>
    </Container>
  );
}
