import { Button, Group, NumberInput, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import wasmUrl from "zxing-wasm/writer/zxing_writer.wasm?url";
import { Loading, PageHeader, Problem } from "../../components/ui";
import { get } from "../../lib/api";
import type { Item } from "../../lib/types";
import "./labels.css";

let prepared = false;
/** Load the barcode writer the first time a label is drawn, not when the app starts. */
function prepare() {
  if (prepared) return;
  prepared = true;
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) }, fireImmediately: true });
}

function Code({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    prepare();
    writeBarcode(text, { format: "Code128", scale: 2, addHRT: true, addQuietZones: true }).then((r) => { if (live) setSvg(r.svg); }).catch(() => { if (live) setSvg(""); });
    return () => { live = false; };
  }, [text]);
  if (svg === null) return <div className="label-code" />;
  return svg ? <div className="label-code" data-barcode dangerouslySetInnerHTML={{ __html: svg }} /> : <Text size="sm">{text}</Text>;
}

/** Item labels: SKU, name and a Code 128 barcode (the item's first barcode, or its SKU). Prints on its own. */
export function LabelSheet() {
  const [params] = useSearchParams();
  const ids = (params.get("items") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const [copies, setCopies] = useState<number | string>(1);
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  if (items.error) return <Problem error={items.error} retry={() => items.refetch()} />;
  if (!items.data) return <Loading />;
  const chosen = ids.map((id) => items.data.find((i) => i.id === id)).filter((i): i is Item => Boolean(i));
  const n = Math.min(Math.max(Number(copies) || 1, 1), 50);
  return (
    <Stack gap="md">
      <div className="no-print">
        <PageHeader title="Labels" subtitle={chosen.length ? `${chosen.length} item${chosen.length === 1 ? "" : "s"}, ${chosen.length * n} label${chosen.length * n === 1 ? "" : "s"}` : "Pick items on Stock, tick them and choose Print labels."} />
        <Group>
          <NumberInput label="Copies of each" min={1} max={50} value={copies} onChange={setCopies} w={140} />
          <Button mt={24} onClick={() => window.print()} disabled={chosen.length === 0}>Print</Button>
        </Group>
      </div>
      <div className="label-sheet">
        {chosen.flatMap((i) => Array.from({ length: n }, (_, k) => (
          <div className="label" key={`${i.id}-${k}`}>
            <div className="label-sku">{i.sku}</div>
            <div className="label-name">{i.name}</div>
            <Code text={i.barcodes?.[0]?.raw ?? i.sku} />
          </div>
        )))}
      </div>
    </Stack>
  );
}
