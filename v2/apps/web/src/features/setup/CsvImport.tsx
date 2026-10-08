import { Alert, Button, FileButton, Group, Stack, Table, Text, Textarea } from "@mantine/core";
import { useState } from "react";
import { toastErr, toastOk } from "../../components/ui";
import { post } from "../../lib/api";

type Row = { row: number; ok: boolean; error?: string; data?: Record<string, unknown> };

/** Paste or pick a CSV, see every row checked, then import — nothing is saved until every row is good. */
export function CsvImport({ kind, columns, example, onDone }: { kind: "vendors" | "items"; columns: string; example: string; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (commit: boolean) => {
    setBusy(true);
    try {
      const result = await post<{ commit: boolean; results: Row[] }>(`/import/${kind}`, { csv, commit });
      setRows(result.results);
      if (result.commit) {
        toastOk(`Imported ${result.results.length} ${kind}`);
        setCsv("");
        setRows(null);
        onDone();
      }
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const bad = rows?.filter((r) => !r.ok) ?? [];

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Columns: <code>{columns}</code>. Save your spreadsheet as CSV, then pick it or paste it here.
      </Text>
      <Group>
        <FileButton accept=".csv,text/csv" onChange={async (file) => file && setCsv(await file.text())}>
          {(props) => (
            <Button variant="light" {...props}>
              Pick a CSV file
            </Button>
          )}
        </FileButton>
        <Button variant="subtle" onClick={() => setCsv(example)}>
          Use an example
        </Button>
      </Group>
      <Textarea value={csv} onChange={(e) => setCsv(e.currentTarget.value)} autosize minRows={3} maxRows={10} placeholder={example} styles={{ input: { fontFamily: "monospace", fontSize: 13 } }} />
      {rows && bad.length > 0 ? (
        <Alert color="orange" title={`${bad.length} row(s) need fixing`}>
          <Table>
            <Table.Tbody>
              {bad.map((r) => (
                <Table.Tr key={r.row}>
                  <Table.Td>Row {r.row}</Table.Td>
                  <Table.Td>{r.error}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Alert>
      ) : null}
      {rows && bad.length === 0 ? <Text size="sm">All {rows.length} rows look right.</Text> : null}
      <Group>
        <Button variant="light" onClick={() => check(false)} loading={busy} disabled={!csv.trim()}>
          Check
        </Button>
        <Button onClick={() => check(true)} loading={busy} disabled={!rows || bad.length > 0}>
          Import
        </Button>
      </Group>
    </Stack>
  );
}
