import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  NumberInput,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconDatabase, IconSparkles } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toastErr, toastOk, usd } from "../../components/ui";
import { get, type Job, post, type Profile, put } from "../../lib/api";
import { JOB_LABEL, useProfile } from "../../lib/profile";
import type { Item, Setup, Vendor, Warehouse } from "../../lib/types";
import { CsvImport } from "./CsvImport";

const STEPS = ["Welcome", "Company", "Team", "Start", "Warehouses", "Accounts", "Vendors", "Items", "Opening stock", "Done"] as const;

/**
 * First-run setup for a brand-new company. One question per screen, a
 * progress bar, and it remembers where you were — close the tab and pick up
 * at the same step.
 */
export function SetupWizard() {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const [step, setStepState] = useState<number | null>(null);
  useEffect(() => {
    if (setup.data && step === null) setStepState(setup.data.company.setupStep);
  }, [setup.data, step]);
  const refresh = () => queryClient.invalidateQueries();
  const go = (n: number) => {
    setStepState(n);
    put("/setup/step", { step: n }).catch(() => {});
    window.scrollTo({ top: 0 });
  };
  if (!setup.data || step === null) return null;
  const s = setup.data;
  const next = () => go(step + 1);
  const back = () => go(Math.max(0, step - 1));

  return (
    <Container size={720} py="lg">
      <Stack gap="xs" mb="lg">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            Setting up · step {step + 1} of {STEPS.length}
          </Text>
          <Text size="sm" fw={600}>
            {STEPS[step]}
          </Text>
        </Group>
        <Progress value={((step + 1) / STEPS.length) * 100} color="lime.4" size="sm" />
      </Stack>
      {step === 0 && <Welcome onNext={next} />}
      {step === 1 && <CompanyStep setup={s} onNext={next} refresh={refresh} />}
      {step === 2 && <TeamStep onNext={next} onBack={back} />}
      {step === 3 && <StartStep setup={s} onNext={next} onBack={back} refresh={refresh} />}
      {step === 4 && <WarehousesStep onNext={next} onBack={back} />}
      {step === 5 && <AccountsStep onNext={next} onBack={back} />}
      {step === 6 && <VendorsStep onNext={next} onBack={back} />}
      {step === 7 && <ItemsStep onNext={next} onBack={back} />}
      {step === 8 && <OpeningStep onNext={next} onBack={back} />}
      {step === 9 && <DoneStep setup={s} onBack={back} refresh={refresh} />}
    </Container>
  );
}

function Nav({ onBack, onNext, nextLabel = "Continue", disabled }: { onBack?: () => void; onNext: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <Group justify="space-between" mt="xl">
      {onBack ? (
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button size="md" onClick={onNext} disabled={disabled}>
        {nextLabel}
      </Button>
    </Group>
  );
}

function StepCard({ title, intro, children }: { title: string; intro: ReactNode; children?: ReactNode }) {
  return (
    <Stack gap="md">
      <Title order={2}>{title}</Title>
      <Text c="dimmed">{intro}</Text>
      {children}
    </Stack>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <StepCard
      title="Welcome to ProfitIndex"
      intro="Your warehouse and your books in one place: the dock scans what arrives, accounting turns it into a bill, and every number stays proved against the ledger. Setup takes about ten minutes; you can stop and come back at any step."
    >
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        {[
          ["Scan", "A clerk scans incoming boxes with a phone camera."],
          ["Bill", "Accounting checks the draft bill, adds freight, posts."],
          ["Pay", "Bills are paid on time; stock carries its true landed cost."],
        ].map(([t, d]) => (
          <Card key={t} withBorder>
            <Text fw={600}>{t}</Text>
            <Text size="sm" c="dimmed">
              {d}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
      <Nav onNext={onNext} nextLabel="Start setup" />
    </StepCard>
  );
}

function CompanyStep({ setup, onNext, refresh }: { setup: Setup; onNext: () => void; refresh: () => void }) {
  const [form, setForm] = useState({ name: setup.company.name, address: setup.company.address ?? "", homeState: setup.company.homeState ?? "", fiscalYearStartMonth: setup.company.fiscalYearStartMonth });
  const save = async () => {
    try {
      await put("/setup/company", { ...form, homeState: form.homeState || undefined, address: form.address || undefined });
      refresh();
      onNext();
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <StepCard title="Your company" intro="This appears on documents and reports. The state sets where sales tax starts from.">
      <TextInput label="Company name" size="md" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} autoFocus />
      <Textarea label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.currentTarget.value })} autosize minRows={2} />
      <Group grow>
        <TextInput label="State" description="Two letters, e.g. PA" maxLength={2} value={form.homeState} onChange={(e) => setForm({ ...form, homeState: e.currentTarget.value.toUpperCase() })} />
        <Select
          label="Fiscal year starts"
          value={String(form.fiscalYearStartMonth)}
          onChange={(v) => setForm({ ...form, fiscalYearStartMonth: Number(v) })}
          data={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2026, i, 1).toLocaleString("en-US", { month: "long" }) }))}
        />
      </Group>
      <Nav onNext={save} disabled={!form.name.trim()} />
    </StepCard>
  );
}

function TeamStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { profile, choose } = useProfile();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => get<Profile[]>("/profiles") });
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  // The first person is the admin doing setup; everyone after defaults to the dock, unless picked.
  const [picked, setPicked] = useState<Job | null>(null);
  const job: Job = picked ?? (profiles.data?.length ? "CLERK" : "ADMIN");
  const setJob = (j: Job) => setPicked(j);
  const add = async () => {
    try {
      const created = await post<Profile>("/profiles", { name, job });
      if (!profile) choose(created); // the first person added is the one doing setup
      setName("");
      setPicked(null);
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <StepCard
      title="Who works here?"
      intro="Add yourself first, then the people at the dock and in accounting. There are no passwords: each person taps their name on their device, and their name goes on everything they do."
    >
      {(profiles.data ?? []).map((p) => (
        <Group key={p.id} justify="space-between">
          <Text fw={500}>{p.name}</Text>
          <Badge color={p.id === profile?.id ? "lime" : "gray"}>{p.id === profile?.id ? "You" : JOB_LABEL[p.job]}</Badge>
        </Group>
      ))}
      <Card withBorder>
        <Stack>
          <TextInput label={profiles.data?.length ? "Name" : "Your name"} value={name} onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && add()} />
          <SegmentedControl value={job} onChange={(v) => setJob(v as Job)} data={(["CLERK", "ACCOUNTING", "ADMIN"] as Job[]).map((j) => ({ value: j, label: JOB_LABEL[j] }))} />
          <Button variant="light" onClick={add} disabled={!name.trim()}>
            Add {name.trim() || "person"}
          </Button>
        </Stack>
      </Card>
      <Nav onBack={onBack} onNext={onNext} disabled={!profiles.data?.length} />
    </StepCard>
  );
}

function StartStep({ setup, onNext, onBack, refresh }: { setup: Setup; onNext: () => void; onBack: () => void; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const loadSample = async () => {
    setBusy(true);
    try {
      await post("/setup/sample-data");
      toastOk("Sample data added");
      refresh();
      onNext();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const empty = setup.counts.warehouses === 0 && setup.counts.items === 0;
  return (
    <StepCard title="How do you want to start?" intro="Sample data is the smallest set that lets you try every step: no stock and no transactions, so you run the first order, scan, bill and payment yourself. You can clear it before going live.">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder padding="lg">
          <Stack>
            <IconSparkles />
            <Text fw={600}>Add minimal sample data</Text>
            <Text size="sm" c="dimmed">
              1 warehouse, a supplier ({setup.sample.supplier.name}) and a freight carrier, and 3 items: a widget, a serial-tracked robot and an open-box widget. Comes with a printable test sheet of barcodes and a packing slip.
            </Text>
            <Button onClick={loadSample} loading={busy} disabled={setup.sample.loaded || !empty}>
              {setup.sample.loaded ? "Sample data added" : "Add sample data"}
            </Button>
          </Stack>
        </Card>
        <Card withBorder padding="lg">
          <Stack>
            <IconDatabase />
            <Text fw={600}>Start empty</Text>
            <Text size="sm" c="dimmed">
              Enter or import your own warehouses, vendors and items in the next steps.
            </Text>
            <Button variant="light" onClick={onNext}>
              Start empty
            </Button>
          </Stack>
        </Card>
      </SimpleGrid>
      {!empty && !setup.sample.loaded ? <Text size="sm" c="dimmed">This company already has warehouses or items, so sample data isn't offered.</Text> : null}
      <Nav onBack={onBack} onNext={onNext} />
    </StepCard>
  );
}

function WarehousesStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const add = async () => {
    try {
      await post("/warehouses", { code, name });
      setCode("");
      setName("");
      warehouses.refetch();
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <StepCard title="Warehouses" intro="Every place you keep stock. Deliveries are received into one of these.">
      {(warehouses.data ?? []).map((w) => (
        <Group key={w.id} justify="space-between">
          <Text>
            <b>{w.code}</b> · {w.name}
          </Text>
          {w.isSample ? <Badge>Sample</Badge> : null}
        </Group>
      ))}
      <Group align="flex-end" grow>
        <TextInput label="Short code" placeholder="MAIN" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} maxLength={12} />
        <TextInput label="Name" placeholder="Main warehouse" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Button variant="light" onClick={add} disabled={!code || !name}>
          Add
        </Button>
      </Group>
      <Nav onBack={onBack} onNext={onNext} disabled={!warehouses.data?.length} />
    </StepCard>
  );
}

function AccountsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => get<{ id: number; code: string; name: string; type: string; isHeader: boolean; parentId: number | null; purpose: string }[]>("/accounts") });
  return (
    <StepCard title="Chart of accounts" intro="Preloaded from your accounting policy (US GAAP). Inventory Asset is split into On Hand and Inbound so the shelf value proves against the books; reports roll them back together. Rename or add accounts any time under Settings.">
      <Table striped>
        <Table.Tbody>
          {(accounts.data ?? []).map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td w={70} style={{ paddingLeft: a.parentId ? 24 : undefined }}>
                {a.code}
              </Table.Td>
              <Table.Td fw={a.isHeader ? 600 : undefined}>
                {a.name}
                <Text size="xs" c="dimmed">
                  {a.purpose}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Nav onBack={onBack} onNext={onNext} nextLabel="Looks right" />
    </StepCard>
  );
}

function VendorsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  const [form, setForm] = useState({ name: "", kind: "SUPPLIER", email: "", paymentTermsDays: 30 });
  const add = async () => {
    try {
      await post("/vendors", form);
      setForm({ name: "", kind: "SUPPLIER", email: "", paymentTermsDays: 30 });
      vendors.refetch();
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <StepCard title="Vendors" intro="Suppliers you buy stock from, and carriers who bill you for freight. Payment terms set each bill's due date.">
      {(vendors.data ?? []).map((v) => (
        <Group key={v.id} justify="space-between">
          <Text>
            {v.name} <Text span c="dimmed" size="sm">· {v.kind === "CARRIER" ? "carrier" : "supplier"} · {v.paymentTermsDays} days</Text>
          </Text>
          {v.isSample ? <Badge>Sample</Badge> : null}
        </Group>
      ))}
      <Tabs defaultValue="one">
        <Tabs.List>
          <Tabs.Tab value="one">Add one</Tabs.Tab>
          <Tabs.Tab value="csv">Import CSV</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="one" pt="md">
          <Stack>
            <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
            <Group grow>
              <SegmentedControl value={form.kind} onChange={(kind) => setForm({ ...form, kind })} data={[{ value: "SUPPLIER", label: "Supplier" }, { value: "CARRIER", label: "Carrier" }]} />
              <NumberInput label="Terms (days)" value={form.paymentTermsDays} onChange={(v) => setForm({ ...form, paymentTermsDays: Number(v) || 0 })} min={0} max={365} />
            </Group>
            <TextInput label="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />
            <Button variant="light" onClick={add} disabled={!form.name.trim()}>
              Add vendor
            </Button>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="csv" pt="md">
          <CsvImport kind="vendors" columns="name, kind, email, phone, terms_days" example={"name,kind,email,terms_days\nAcme Robotics,SUPPLIER,ap@acme.example,30\nFastFreight,CARRIER,billing@fastfreight.example,15"} onDone={() => vendors.refetch()} />
        </Tabs.Panel>
      </Tabs>
      <Nav onBack={onBack} onNext={onNext} />
    </StepCard>
  );
}

function ItemsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  const [form, setForm] = useState({ sku: "", name: "", barcode: "", serial: false, cost: 0 });
  const add = async () => {
    try {
      await post("/items", { sku: form.sku, name: form.name, trackingMode: form.serial ? "SERIAL" : "NONE", lastCostCents: Math.round(form.cost * 100), barcodes: form.barcode ? [{ raw: form.barcode }] : [] });
      setForm({ sku: "", name: "", barcode: "", serial: false, cost: 0 });
      items.refetch();
    } catch (error) {
      toastErr(error);
    }
  };
  const vendorName = vendors.data?.find((v) => v.kind === "SUPPLIER")?.name ?? "Acme Robotics";
  return (
    <StepCard title="Items" intro="What you stock. The barcode is what the camera reads at the dock; serial-tracked items ask for a serial per unit.">
      <Table>
        <Table.Tbody>
          {(items.data ?? []).map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td fw={500}>{i.sku}</Table.Td>
              <Table.Td>{i.name}</Table.Td>
              <Table.Td c="dimmed">{i.barcodes?.map((b) => b.raw).join(", ")}</Table.Td>
              <Table.Td>{i.trackingMode === "SERIAL" ? <Badge>Serial</Badge> : null}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Tabs defaultValue="one">
        <Tabs.List>
          <Tabs.Tab value="one">Add one</Tabs.Tab>
          <Tabs.Tab value="csv">Import CSV</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="one" pt="md">
          <Stack>
            <Group grow>
              <TextInput label="SKU" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.currentTarget.value })} />
              <TextInput label="Barcode" description="UPC, EAN or any code on the box" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.currentTarget.value })} />
            </Group>
            <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
            <Group grow align="flex-end">
              <NumberInput label="Usual cost ($)" value={form.cost} onChange={(v) => setForm({ ...form, cost: Number(v) || 0 })} min={0} decimalScale={2} />
              <SegmentedControl value={form.serial ? "1" : "0"} onChange={(v) => setForm({ ...form, serial: v === "1" })} data={[{ value: "0", label: "Counted" }, { value: "1", label: "Serial per unit" }]} />
            </Group>
            <Button variant="light" onClick={add} disabled={!form.sku || !form.name}>
              Add item
            </Button>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="csv" pt="md">
          <CsvImport
            kind="items"
            columns="sku, name, barcode, pack_qty, tracking (SERIAL), vendor, vendor_sku, cost"
            example={`sku,name,barcode,tracking,vendor,vendor_sku,cost\nGRIP-01,Gripper arm,036000291452,,${vendorName},GA-1,129.00`}
            onDone={() => items.refetch()}
          />
        </Tabs.Panel>
      </Tabs>
      <Nav onBack={onBack} onNext={onNext} />
    </StepCard>
  );
}

function OpeningStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const [lines, setLines] = useState<{ itemId: string | null; warehouseId: string | null; qty: number; cost: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const counted = (items.data ?? []).filter((i) => i.trackingMode === "NONE");
  const add = () => setLines([...lines, { itemId: null, warehouseId: warehouses.data?.[0] ? String(warehouses.data[0].id) : null, qty: 1, cost: 0 }]);
  const total = lines.reduce((s, l) => s + Math.round(l.cost * 100) * l.qty, 0);
  const postOpening = async () => {
    setBusy(true);
    try {
      await post("/setup/opening-stock", { lines: lines.map((l) => ({ itemId: Number(l.itemId), warehouseId: Number(l.warehouseId), qty: l.qty, unitCostCents: Math.round(l.cost * 100) })) });
      toastOk("Opening stock posted");
      setLines([]);
      setup.refetch();
      onNext();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepCard
      title="Opening stock"
      intro="What's on the shelves before you start using ProfitIndex, at what it cost. It posts once: Dr Inventory / Cr Opening Balance Equity. Brand new and nothing in stock yet? Skip this."
    >
      {setup.data?.counts.stocked ? <Alert color="lime">Opening stock is already posted for {setup.data.counts.stocked} item location(s).</Alert> : null}
      {lines.map((line, i) => (
        <Card key={i} withBorder>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Select label="Item" data={counted.map((it) => ({ value: String(it.id), label: `${it.sku} · ${it.name}` }))} value={line.itemId} onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, itemId: v } : l)))} searchable />
            <Select label="Warehouse" data={(warehouses.data ?? []).map((w) => ({ value: String(w.id), label: w.code }))} value={line.warehouseId} onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, warehouseId: v } : l)))} />
            <NumberInput label="Units" min={1} value={line.qty} onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, qty: Number(v) || 1 } : l)))} />
            <NumberInput label="Unit cost ($)" min={0} decimalScale={2} value={line.cost} onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, cost: Number(v) || 0 } : l)))} />
          </SimpleGrid>
        </Card>
      ))}
      <Group>
        <Button variant="light" onClick={add}>
          Add a line
        </Button>
        {lines.length ? (
          <Button onClick={postOpening} loading={busy} disabled={lines.some((l) => !l.itemId || !l.warehouseId)}>
            Post {usd(total)} of opening stock
          </Button>
        ) : null}
      </Group>
      <Text size="sm" c="dimmed">
        Serial-tracked items come in through a delivery so each unit's serial is recorded.
      </Text>
      <Nav onBack={onBack} onNext={onNext} nextLabel={lines.length ? "Skip these lines" : "Continue"} />
    </StepCard>
  );
}

function DoneStep({ setup, onBack, refresh }: { setup: Setup; onBack: () => void; refresh: () => void }) {
  const navigate = useNavigate();
  const finish = async () => {
    try {
      await post("/setup/complete");
      refresh();
      navigate("/");
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <StepCard title="Ready" intro="That's everything ProfitIndex needs. Here's a first run to try:">
      <Stack gap="xs">
        {[
          "Open the test sheet on a second screen or print it.",
          "On a phone, pick your name, then Receive → scan the widget twice.",
          "As accounting, open the draft bill, enter the invoice number, add $100 freight, post it.",
          "Watch the widgets land at $550 each, then pay the bill.",
        ].map((t, i) => (
          <Group key={t} gap="sm" wrap="nowrap" align="flex-start">
            <Badge circle color="lime.4" variant="filled">
              {i + 1}
            </Badge>
            <Text>{t}</Text>
          </Group>
        ))}
      </Stack>
      {setup.sample.loaded ? (
        <Anchor component={Link} to="/test-sheet" target="_blank">
          Open the test sheet
        </Anchor>
      ) : null}
      <Group justify="space-between" mt="xl">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        <Button size="md" leftSection={<IconCheck size={18} />} onClick={finish}>
          Finish setup
        </Button>
      </Group>
    </StepCard>
  );
}
