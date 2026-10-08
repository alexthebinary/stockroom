import { barcodeKey, parseGs1 } from "@pi/domain";
import { Button, Card, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconBarcode } from "@tabler/icons-react";
import { useState } from "react";
import { Coach } from "../../components/Coach";
import { PageHeader } from "../../components/ui";
import { get } from "../../lib/api";
import type { Item } from "../../lib/types";
import { Scanner } from "./Scanner";

/** Point the camera at the test sheet and see what it reads. Nothing is saved. */
export function Practice() {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const [open, setOpen] = useState(false);
  const [reads, setReads] = useState<{ code: string; what: string }[]>([]);
  const lookup = (code: string) => {
    const key = barcodeKey(code);
    const item = (items.data ?? []).find((i) => i.barcodes?.some((b) => b.code === key) || i.sku.toUpperCase() === key);
    const serial = parseGs1(code)?.serial;
    return item ? `${item.name}${serial ? ` · serial ${serial}` : ""}` : "Not in the catalog (it would be set aside for accounting)";
  };
  return (
    <Stack>
      <PageHeader title="Practice scan" subtitle="Nothing you scan here is saved." />
      <Coach id="practice" title="Try the test sheet">
        Open the test sheet on another screen (or print it) and aim at each barcode. Hold steady about a hand's width away; good light helps more than getting closer.
      </Coach>
      <Button size="xl" h={72} leftSection={<IconBarcode size={28} />} onClick={() => setOpen(true)}>
        Open scanner
      </Button>
      {reads.map((r, i) => (
        <Card key={i} withBorder padding="sm">
          <Text fw={600}>{r.what}</Text>
          <Text size="sm" c="dimmed">
            {r.code}
          </Text>
        </Card>
      ))}
      {open ? (
        <Scanner
          onScan={(code) => {
            const what = lookup(code);
            setReads((r) => [{ code, what }, ...r].slice(0, 20));
            return what.startsWith("Not") ? "warn" : "ok";
          }}
          onClose={() => setOpen(false)}
        >
          <Text c="white">{reads[0]?.what ?? "Aim at a barcode"}</Text>
        </Scanner>
      ) : null}
    </Stack>
  );
}
