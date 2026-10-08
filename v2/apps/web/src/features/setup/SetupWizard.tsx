import { Button, NumberInput, Select, Textarea, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconBuildingWarehouse,
  IconCalculator,
  IconDatabase,
  IconFileInvoice,
  IconFileSpreadsheet,
  IconPlus,
  IconScale,
  IconScan,
  IconSettings,
  IconSparkles,
  IconTruck,
} from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, Choice, Chips, OnboardingFrame, StepTitle } from "../../components/onboarding/Onboarding";
import { plural, toastErr, toastOk, usd } from "../../components/ui";
import { get, type Job, post, type Profile, put } from "../../lib/api";
import { JOB_LABEL, useProfile } from "../../lib/profile";
import type { Item, Setup, Vendor, Warehouse } from "../../lib/types";
import { CsvImport } from "./CsvImport";
import { CompanyStage, ItemsStage, OpeningStage, type Person, SetupReceipt, StartStage, TeamStage, VendorsStage, WarehouseStage, WelcomeStage } from "./stages";

/**
 * First-run setup, App Store style: one question per screen, a live picture of
 * what you're building beside it on a laptop, and the action at your thumb on
 * a phone. With sample data it is five questions; starting empty adds your
 * warehouse, vendors, items and opening stock. It remembers where you were.
 */

/** Every screen, in order. The server stores the index, so only ever append. */
const ORDER = ["welcome", "company", "you", "team", "start", "warehouse", "vendors", "items", "opening", "done"] as const;
type StepId = (typeof ORDER)[number];
const DATA_STEPS: StepId[] = ["warehouse", "vendors", "items", "opening"];

type Frame = { stepKey: string; dir: "next" | "back"; progress: { index: number; total: number } | null; onBack?: () => void };
type Nav = { frame: Frame; next: () => void; goTo: (id: StepId) => void; setup: Setup; refresh: () => Promise<unknown> };

const ROLE_OPTIONS = (["CLERK", "ACCOUNTING", "ADMIN"] as Job[]).map((job) => ({
  value: job,
  label: JOB_LABEL[job],
  icon: { CLERK: <IconBuildingWarehouse size={20} />, ACCOUNTING: <IconCalculator size={20} />, ADMIN: <IconSettings size={20} /> }[job],
}));
const ROLE_HINT: Record<Job, string> = {
  CLERK: "Receives deliveries with the phone camera.",
  ACCOUNTING: "Reviews bills and freight, and pays them.",
  ADMIN: "Runs orders, settings and the books.",
};

export function SetupWizard() {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const [current, setCurrent] = useState<StepId | null>(null);
  const [dir, setDir] = useState<"next" | "back">("next");
  const [startMode, setStartMode] = useState<"sample" | "empty" | null>(null);
  useEffect(() => {
    if (setup.data && current === null) setCurrent(ORDER[Math.min(setup.data.company.setupStep, ORDER.length - 1)] ?? "welcome");
  }, [setup.data, current]);
  if (!setup.data || current === null) return null;
  const s = setup.data;

  // With sample data the data screens are already filled in, so a first run
  // skips them; starting empty, or reopening setup later, shows them all.
  const pastStart = ORDER.indexOf(current) > ORDER.indexOf("start");
  const mode = s.sample.loaded ? "sample" : (startMode ?? (pastStart ? "empty" : "sample"));
  const showData = !s.required || mode === "empty";
  const path = ORDER.filter((id) => showData || !DATA_STEPS.includes(id));
  const at: StepId = path.includes(current) ? current : "done";
  const index = path.indexOf(at);

  const go = (id: StepId, direction: "next" | "back") => {
    setDir(direction);
    setCurrent(id);
    put("/setup/step", { step: ORDER.indexOf(id) }).catch(() => {});
    window.scrollTo({ top: 0 });
  };
  const nav: Nav = {
    frame: {
      stepKey: at,
      dir,
      // The welcome and the finish stand alone; the questions between them are counted.
      progress: at === "welcome" || at === "done" ? null : { index: index - 1, total: path.length - 2 },
      onBack: index > 0 ? () => go(path[index - 1] ?? "welcome", "back") : undefined,
    },
    next: () => go(path[index + 1] ?? "done", "next"),
    goTo: (id) => go(id, "next"),
    setup: s,
    refresh: () => queryClient.invalidateQueries(),
  };

  switch (at) {
    case "welcome":
      return <WelcomeStep {...nav} />;
    case "company":
      return <CompanyStep {...nav} />;
    case "you":
      return <YouStep {...nav} />;
    case "team":
      return <TeamStep {...nav} />;
    case "start":
      return <StartStep {...nav} onMode={setStartMode} mode={mode} />;
    case "warehouse":
      return <WarehouseStep {...nav} />;
    case "vendors":
      return <VendorsStep {...nav} />;
    case "items":
      return <ItemsStep {...nav} />;
    case "opening":
      return <OpeningStep {...nav} />;
    case "done":
      return <DoneStep {...nav} />;
  }
}

function Cta({ children, form, onClick, disabled, loading }: { children: ReactNode; form?: string; onClick?: () => void; disabled?: boolean; loading?: boolean }) {
  return (
    <Button className="ob-cta" size="lg" fullWidth type={form ? "submit" : "button"} form={form} onClick={onClick} disabled={disabled} loading={loading}>
      {children}
    </Button>
  );
}

function WelcomeStep({ frame, next }: Nav) {
  const features: [ReactNode, string, string][] = [
    [<IconScan key="scan" size={22} />, "Scan at the dock", "Your team counts deliveries with a phone camera. No scanners to buy."],
    [<IconFileInvoice key="bill" size={22} />, "Bills that build themselves", "Every delivery drafts its bill, with freight spread into a true landed cost."],
    [<IconScale key="books" size={22} />, "Books that prove themselves", "Stock, payables and the ledger are checked against each other, always."],
  ];
  return (
    <OnboardingFrame
      {...frame}
      stage={<WelcomeStage />}
      stageCaption="From the dock to the books, every number proved."
      footer={
        <>
          <Cta onClick={next}>Get started</Cta>
          <div className="ob-foot-note">About three minutes. You can stop and pick up where you left off.</div>
        </>
      }
    >
      <img className="ob-hero-mark" src="/icon.svg" alt="" />
      <StepTitle title="Your stock and your books, in sync." lede="ProfitIndex takes a delivery from the dock to a paid bill, with every figure proved against the ledger." />
      <div className="ob-features">
        {features.map(([icon, title, text]) => (
          <div key={title} className="ob-feature">
            <span className="ob-feature-icon">{icon}</span>
            <div>
              <div className="ob-feature-title">{title}</div>
              <div className="ob-feature-text">{text}</div>
            </div>
          </div>
        ))}
      </div>
    </OnboardingFrame>
  );
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2026, i, 1).toLocaleString("en-US", { month: "long" }) }));

function CompanyStep({ frame, next, setup, refresh }: Nav) {
  const c = setup.company;
  const [form, setForm] = useState({ name: c.name, address: c.address ?? "", homeState: c.homeState ?? "", fiscalYearStartMonth: c.fiscalYearStartMonth });
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await put("/setup/company", { ...form, homeState: form.homeState || undefined, address: form.address || undefined });
      await refresh();
      next();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <OnboardingFrame
      {...frame}
      stage={<CompanyStage name={form.name} address={form.address} homeState={form.homeState} fiscalMonth={form.fiscalYearStartMonth} />}
      stageCaption="It prints on every receipt, bill and report."
      footer={
        <Cta form="company-form" disabled={!form.name.trim()} loading={busy}>
          Continue
        </Cta>
      }
    >
      <StepTitle title="What's your company called?" lede="It goes on your receipts, bills and reports." />
      <form id="company-form" className="ob-fields" onSubmit={save}>
        <TextInput label="Company name" size="lg" placeholder="Northwind Supply" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} autoFocus />
        <Textarea label="Address" description="Optional. Printed under your name." size="md" autosize minRows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.currentTarget.value })} />
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.8fr) minmax(0, 1.2fr)", gap: 12 }}>
          <TextInput label="State" description="Where sales tax starts" size="md" placeholder="PA" maxLength={2} value={form.homeState} onChange={(e) => setForm({ ...form, homeState: e.currentTarget.value.toUpperCase() })} />
          <Select label="Fiscal year starts" description="Most companies: January" size="md" data={MONTH_OPTIONS} value={String(form.fiscalYearStartMonth)} onChange={(v) => setForm({ ...form, fiscalYearStartMonth: Number(v) || 1 })} allowDeselect={false} />
        </div>
      </form>
    </OnboardingFrame>
  );
}

/** The people on this install, with "you" marked: the profile chosen on this device. */
function usePeople() {
  const { profile } = useProfile();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => get<Profile[]>("/profiles") });
  const list = profiles.data ?? [];
  const me = list.find((p) => p.id === profile?.id) ?? null;
  return { list, me, loaded: profiles.isSuccess, refetch: profiles.refetch };
}

function YouStep({ frame, next }: Nav) {
  const { choose } = useProfile();
  const { list, me, loaded } = usePeople();
  const [name, setName] = useState("");
  const [job, setJob] = useState<Job>("ADMIN");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (me) return next();
    setBusy(true);
    try {
      choose(await post<Profile>("/profiles", { name: name.trim(), job }));
      next();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const people: Person[] = me ? list.map((p) => ({ name: p.name, job: p.job, you: p.id === me.id })) : [...list.map((p) => ({ name: p.name, job: p.job })), ...(name.trim() ? [{ name: name.trim(), job, you: true }] : [])];
  // Setup resumed on a different device: say which person you are.
  const pick = loaded && !me && list.length > 0;
  return (
    <OnboardingFrame
      {...frame}
      stage={<TeamStage people={people} />}
      stageCaption="Everyone taps their name on their own device. No passwords."
      footer={
        pick ? null : (
          <Cta form="you-form" disabled={!me && !name.trim()} loading={busy}>
            Continue
          </Cta>
        )
      }
    >
      {me ? (
        <>
          <StepTitle title={`You're set, ${me.name.split(/\s+/)[0]}.`} lede="Your name goes on everything you do here." />
          <form id="you-form" onSubmit={save} className="ob-list">
            <div className="ob-row">
              <Avatar name={me.name} size={44} you />
              <div>
                <div className="ob-row-title">{me.name}</div>
                <div className="ob-row-meta">{JOB_LABEL[me.job]}</div>
              </div>
              <span className="ob-pill">You</span>
            </div>
          </form>
        </>
      ) : pick ? (
        <>
          <StepTitle title="Which one is you?" lede="Setup was started on another device. Tap your name to carry on here." />
          <div className="ob-list">
            {list.map((p) => (
              <button key={p.id} type="button" className="ob-row" style={{ border: 0, borderBottom: "1px solid var(--line)", background: "none", font: "inherit", textAlign: "left", cursor: "pointer" }} onClick={() => choose(p)}>
                <Avatar name={p.name} size={44} />
                <div>
                  <div className="ob-row-title">{p.name}</div>
                  <div className="ob-row-meta">{JOB_LABEL[p.job]}</div>
                </div>
                <span />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <StepTitle title="And you are?" lede="You're the first person on the team. Your name goes on everything you do." />
          <form id="you-form" className="ob-fields" onSubmit={save}>
            <TextInput label="Your name" size="lg" placeholder="Ada Lovelace" value={name} onChange={(e) => setName(e.currentTarget.value)} autoFocus />
            <div>
              <div className="ob-section-label">Your role</div>
              <Chips label="Your role" value={job} onChange={setJob} options={ROLE_OPTIONS} />
              <div className="ob-hint">{ROLE_HINT[job]}</div>
            </div>
          </form>
        </>
      )}
    </OnboardingFrame>
  );
}

function TeamStep({ frame, next }: Nav) {
  const { list, me, refetch } = usePeople();
  const [name, setName] = useState("");
  const [job, setJob] = useState<Job>("CLERK");
  const [busy, setBusy] = useState(false);
  const others = list.filter((p) => p.id !== me?.id);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await post<Profile>("/profiles", { name: name.trim(), job });
      setName("");
      setJob("CLERK");
      await refetch();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const people: Person[] = [...list.map((p) => ({ name: p.name, job: p.job, you: p.id === me?.id })), ...(name.trim() ? [{ name: name.trim(), job }] : [])];
  return (
    <OnboardingFrame {...frame} stage={<TeamStage people={people} />} stageCaption="Everyone taps their name on their own device. No passwords." footer={<Cta onClick={next}>{others.length ? "Continue" : "Skip for now"}</Cta>}>
      <StepTitle title="Who else works here?" lede="Add the people at the dock and in accounting. You can add more later." />
      {others.length ? (
        <div className="ob-list" role="list" aria-label="Team">
          {others.map((p) => (
            <div key={p.id} className="ob-row" role="listitem">
              <Avatar name={p.name} size={40} />
              <div>
                <div className="ob-row-title">{p.name}</div>
                <div className="ob-row-meta">{JOB_LABEL[p.job]}</div>
              </div>
              <span />
            </div>
          ))}
        </div>
      ) : null}
      <form className="ob-add" onSubmit={add}>
        <TextInput label="Name" size="md" placeholder="Full name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Chips label="Role" value={job} onChange={setJob} options={ROLE_OPTIONS} />
        <Button type="submit" variant="default" size="md" leftSection={<IconPlus size={18} />} disabled={!name.trim()} loading={busy}>
          Add {name.trim() || "a person"}
        </Button>
      </form>
    </OnboardingFrame>
  );
}

function StartStep({ frame, goTo, setup, refresh, mode, onMode }: Nav & { mode: "sample" | "empty"; onMode: (mode: "sample" | "empty") => void }) {
  const [busy, setBusy] = useState(false);
  const loaded = setup.sample.loaded;
  const hasData = setup.counts.warehouses > 0 || setup.counts.items > 0;
  const canSample = loaded || !hasData;
  const chosen = loaded ? "sample" : canSample ? mode : "empty";
  const go = async () => {
    if (chosen === "empty") {
      onMode("empty");
      return goTo("warehouse");
    }
    setBusy(true);
    try {
      if (!loaded) {
        await post("/setup/sample-data");
        toastOk("Sample data added");
        await refresh();
      }
      onMode("sample");
      goTo("done");
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <OnboardingFrame
      {...frame}
      stage={<StartStage mode={chosen} sample={setup.sample} />}
      stageCaption={chosen === "sample" ? "No stock and no transactions: you run the first delivery yourself." : "Type them in, or import a spreadsheet."}
      footer={
        <Cta onClick={go} loading={busy}>
          Continue
        </Cta>
      }
    >
      <StepTitle title="How would you like to start?" lede="Sample data is the quickest way to see a delivery go from the dock to a paid bill. You can clear it before going live." />
      <div role="radiogroup" aria-label="How to start" className="ob-choices">
        <Choice
          icon={<IconSparkles size={22} />}
          title="Try it with sample data"
          badge={<span className="ob-pill">{loaded ? "Added" : "Recommended"}</span>}
          text="A warehouse, a supplier, a freight carrier and three items, with a printable test sheet of barcodes."
          checked={chosen === "sample"}
          disabled={!canSample}
          onSelect={() => onMode("sample")}
        />
        <Choice
          icon={<IconDatabase size={22} />}
          title="Start with my own data"
          text={hasData && !loaded ? "This company already has warehouses or items, so sample data isn't offered." : "Add your warehouse, vendors and items next, or import them from a spreadsheet."}
          checked={chosen === "empty"}
          disabled={loaded}
          onSelect={() => onMode("empty")}
        />
      </div>
    </OnboardingFrame>
  );
}

function WarehouseStep({ frame, next }: Nav) {
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const list = warehouses.data ?? [];
  const first = !warehouses.isLoading && list.length === 0;
  const [form, setForm] = useState({ code: "", name: "" });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // The first warehouse comes suggested; most companies only need the one.
  useEffect(() => {
    if (first) setForm({ code: "MAIN", name: "Main warehouse" });
  }, [first]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.code || !form.name) return list.length ? next() : undefined;
    setBusy(true);
    try {
      await post("/warehouses", form);
      setForm({ code: "", name: "" });
      setAdding(false);
      await warehouses.refetch();
      if (first) next();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const fields = (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.7fr) minmax(0, 1.3fr)", gap: 12 }}>
        <TextInput label="Short code" size="md" placeholder="MAIN" maxLength={12} value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value.toUpperCase() })} />
        <TextInput label="Name" size="md" placeholder="Main warehouse" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
      </div>
    </>
  );
  const shown = form.code || form.name ? form : (list[0] ?? form);
  return (
    <OnboardingFrame
      {...frame}
      stage={<WarehouseStage code={shown.code} name={shown.name} more={Math.max(0, list.length - 1)} />}
      stageCaption="Every delivery is received into a warehouse."
      footer={
        first ? (
          <Cta form="warehouse-form" disabled={!form.code || !form.name} loading={busy}>
            Continue
          </Cta>
        ) : (
          <Cta onClick={next}>Continue</Cta>
        )
      }
    >
      <StepTitle title="Where do you keep stock?" lede={first ? "We've suggested your main warehouse. Rename it if you like; you can add more later." : "Add another place you keep stock, or carry on."} />
      {list.length ? (
        <div className="ob-list">
          {list.map((w) => (
            <div key={w.id} className="ob-row">
              <span className="ob-feature-icon">
                <IconBuildingWarehouse size={20} />
              </span>
              <div>
                <div className="ob-row-title">{w.name}</div>
                <div className="ob-row-meta">{w.code}</div>
              </div>
              {w.isSample ? <span className="ob-pill">Sample</span> : <span />}
            </div>
          ))}
        </div>
      ) : null}
      {first ? (
        <form id="warehouse-form" className="ob-fields" onSubmit={save}>
          {fields}
        </form>
      ) : adding ? (
        <form className="ob-add" onSubmit={save}>
          {fields}
          <Button type="submit" variant="default" size="md" leftSection={<IconPlus size={18} />} disabled={!form.code || !form.name} loading={busy}>
            Add warehouse
          </Button>
        </form>
      ) : (
        <Button variant="subtle" mt="md" leftSection={<IconPlus size={18} />} onClick={() => setAdding(true)}>
          Add another warehouse
        </Button>
      )}
    </OnboardingFrame>
  );
}

/** "Add one" or "import a spreadsheet": a quiet toggle under the add form. */
function ImportToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button variant="subtle" mt="sm" leftSection={open ? <IconPlus size={18} /> : <IconFileSpreadsheet size={18} />} onClick={onToggle}>
      {open ? "Add one at a time instead" : "Import a spreadsheet instead"}
    </Button>
  );
}

function VendorsStep({ frame, next }: Nav) {
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  const list = vendors.data ?? [];
  const blank = { name: "", kind: "SUPPLIER" as "SUPPLIER" | "CARRIER", email: "", paymentTermsDays: 30 };
  const [form, setForm] = useState(blank);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post("/vendors", { ...form, email: form.email || undefined });
      setForm(blank);
      await vendors.refetch();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const shown = form.name.trim() ? [...list, { name: form.name.trim(), kind: form.kind, paymentTermsDays: form.paymentTermsDays }] : list;
  return (
    <OnboardingFrame {...frame} stage={<VendorsStage vendors={shown} />} stageCaption="Payment terms set each bill's due date." footer={<Cta onClick={next}>{list.length ? "Continue" : "Skip for now"}</Cta>}>
      <StepTitle title="Who do you buy from?" lede="Suppliers you buy stock from, and carriers who bill you for freight." />
      {list.length ? (
        <div className="ob-list">
          {list.map((v) => (
            <div key={v.id} className="ob-row">
              <span className="ob-feature-icon">{v.kind === "CARRIER" ? <IconTruck size={20} /> : <IconBuildingWarehouse size={20} />}</span>
              <div>
                <div className="ob-row-title">{v.name}</div>
                <div className="ob-row-meta">
                  {v.kind === "CARRIER" ? "Carrier" : "Supplier"} · Net {v.paymentTermsDays}
                </div>
              </div>
              {v.isSample ? <span className="ob-pill">Sample</span> : <span />}
            </div>
          ))}
        </div>
      ) : null}
      {importing ? (
        <div className="ob-add">
          <CsvImport kind="vendors" columns="name, kind, email, phone, terms_days" example={"name,kind,email,terms_days\nAcme Robotics,SUPPLIER,ap@acme.example,30\nFastFreight,CARRIER,billing@fastfreight.example,15"} onDone={() => vendors.refetch()} />
        </div>
      ) : (
        <form className="ob-add" onSubmit={add}>
          <TextInput label="Vendor name" size="md" placeholder="Acme Robotics" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          <Chips label="Kind of vendor" row value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={[{ value: "SUPPLIER", label: "Supplier" }, { value: "CARRIER", label: "Freight carrier" }]} />
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.7fr) minmax(0, 1.3fr)", gap: 12 }}>
            <NumberInput label="Pays in (days)" size="md" min={0} max={365} value={form.paymentTermsDays} onChange={(v) => setForm({ ...form, paymentTermsDays: Number(v) || 0 })} />
            <TextInput label="Email" size="md" placeholder="Optional" value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />
          </div>
          <Button type="submit" variant="default" size="md" leftSection={<IconPlus size={18} />} disabled={!form.name.trim()} loading={busy}>
            Add {form.name.trim() || "vendor"}
          </Button>
        </form>
      )}
      <ImportToggle open={importing} onToggle={() => setImporting(!importing)} />
    </OnboardingFrame>
  );
}

function ItemsStep({ frame, next }: Nav) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  const list = items.data ?? [];
  const blank = { sku: "", name: "", barcode: "", serial: false, cost: 0 };
  const [form, setForm] = useState(blank);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post("/items", { sku: form.sku, name: form.name, trackingMode: form.serial ? "SERIAL" : "NONE", lastCostCents: Math.round(form.cost * 100), barcodes: form.barcode ? [{ raw: form.barcode }] : [] });
      setForm(blank);
      await items.refetch();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const vendorName = vendors.data?.find((v) => v.kind === "SUPPLIER")?.name ?? "Acme Robotics";
  const last = list[list.length - 1];
  const drafting = form.sku || form.name || form.barcode;
  const label = drafting || !last ? { ...form, costCents: Math.round(form.cost * 100) } : { sku: last.sku, name: last.name, barcode: last.barcodes?.[0]?.raw ?? "", serial: last.trackingMode === "SERIAL", costCents: last.lastCostCents };
  return (
    <OnboardingFrame
      {...frame}
      stage={<ItemsStage {...label} count={list.length} />}
      stageCaption="The barcode is what the camera reads at the dock."
      footer={<Cta onClick={next}>{list.length ? "Continue" : "Skip for now"}</Cta>}
    >
      <StepTitle title="What do you stock?" lede="Add the items you buy. Serial-tracked items ask for a serial on each unit at the dock." />
      {list.length ? (
        <div className="ob-list">
          {list.map((i) => (
            <div key={i.id} className="ob-row">
              <span className="ob-code" style={{ fontWeight: 600, color: "var(--text-strong)" }}>
                {i.sku}
              </span>
              <div className="ob-row-meta">{i.name}</div>
              {i.trackingMode === "SERIAL" ? <span className="ob-pill">Serial</span> : <span />}
            </div>
          ))}
        </div>
      ) : null}
      {importing ? (
        <div className="ob-add">
          <CsvImport kind="items" columns="sku, name, barcode, pack_qty, tracking (SERIAL), vendor, vendor_sku, cost" example={`sku,name,barcode,tracking,vendor,vendor_sku,cost\nGRIP-01,Gripper arm,036000291452,,${vendorName},GA-1,129.00`} onDone={() => items.refetch()} />
        </div>
      ) : (
        <form className="ob-add" onSubmit={add}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <TextInput label="SKU" size="md" placeholder="GRIP-01" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.currentTarget.value })} />
            <TextInput label="Barcode" size="md" placeholder="UPC or EAN" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.currentTarget.value })} />
          </div>
          <TextInput label="Name" size="md" placeholder="Gripper arm" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          <NumberInput label="Usual cost" size="md" prefix="$" min={0} decimalScale={2} fixedDecimalScale value={form.cost} onChange={(v) => setForm({ ...form, cost: Number(v) || 0 })} />
          <Chips label="How it's counted" row value={form.serial ? "SERIAL" : "NONE"} onChange={(v) => setForm({ ...form, serial: v === "SERIAL" })} options={[{ value: "NONE", label: "By quantity" }, { value: "SERIAL", label: "Serial per unit" }]} />
          <Button type="submit" variant="default" size="md" leftSection={<IconPlus size={18} />} disabled={!form.sku || !form.name} loading={busy}>
            Add {form.sku || "item"}
          </Button>
        </form>
      )}
      <ImportToggle open={importing} onToggle={() => setImporting(!importing)} />
    </OnboardingFrame>
  );
}

function OpeningStep({ frame, next, setup, refresh }: Nav) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const [lines, setLines] = useState<{ itemId: string | null; warehouseId: string | null; qty: number; cost: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const counted = (items.data ?? []).filter((i) => i.trackingMode === "NONE");
  const total = lines.reduce((sum, l) => sum + Math.round(l.cost * 100) * l.qty, 0);
  const posted = setup.counts.stocked > 0;
  const update = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines([...lines, { itemId: null, warehouseId: warehouses.data?.[0] ? String(warehouses.data[0].id) : null, qty: 1, cost: 0 }]);
  const postOpening = async () => {
    setBusy(true);
    try {
      await post("/setup/opening-stock", { lines: lines.map((l) => ({ itemId: Number(l.itemId), warehouseId: Number(l.warehouseId), qty: l.qty, unitCostCents: Math.round(l.cost * 100) })) });
      toastOk("Opening stock posted");
      setLines([]);
      await refresh();
      next();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const ready = lines.length > 0 && lines.every((l) => l.itemId && l.warehouseId);
  return (
    <OnboardingFrame
      {...frame}
      stage={<OpeningStage totalCents={total} />}
      stageCaption="It posts once, item by item, at what each one cost."
      footer={
        lines.length ? (
          <>
            <Cta onClick={postOpening} disabled={!ready} loading={busy}>
              Post {usd(total)} and continue
            </Cta>
            <Button variant="subtle" size="md" onClick={next}>
              Skip for now
            </Button>
          </>
        ) : (
          <Cta onClick={next}>{posted ? "Continue" : "Skip for now"}</Cta>
        )
      }
    >
      <StepTitle title="Anything already on the shelves?" lede={posted ? `Opening stock is posted for ${plural(setup.counts.stocked, "item location")}.` : "Enter what you have now and what it cost. Brand new with nothing in stock? Skip this."} />
      {lines.map((line, i) => (
        <div key={i} className="ob-add">
          <Select label="Item" size="md" searchable data={counted.map((it) => ({ value: String(it.id), label: `${it.sku} · ${it.name}` }))} value={line.itemId} onChange={(v) => update(i, { itemId: v })} />
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1fr)", gap: 12 }}>
            <Select label="Warehouse" size="md" data={(warehouses.data ?? []).map((w) => ({ value: String(w.id), label: w.code }))} value={line.warehouseId} onChange={(v) => update(i, { warehouseId: v })} />
            <NumberInput label="Units" size="md" min={1} value={line.qty} onChange={(v) => update(i, { qty: Number(v) || 1 })} />
            <NumberInput label="Unit cost" size="md" prefix="$" min={0} decimalScale={2} value={line.cost} onChange={(v) => update(i, { cost: Number(v) || 0 })} />
          </div>
        </div>
      ))}
      {counted.length ? (
        <Button variant="subtle" mt="md" leftSection={<IconPlus size={18} />} onClick={addLine}>
          {lines.length ? "Add another line" : "Add opening stock"}
        </Button>
      ) : (
        <p className="ob-hint">Add items first to enter opening stock.</p>
      )}
      <p className="ob-hint">Serial-tracked items come in through a delivery, so each unit's serial is recorded.</p>
    </OnboardingFrame>
  );
}

function DoneStep({ frame, setup, refresh }: Nav) {
  const navigate = useNavigate();
  const { me, list } = usePeople();
  const [busy, setBusy] = useState(false);
  const first = setup.required;
  const finish = async () => {
    setBusy(true);
    try {
      if (first) await post("/setup/complete");
      await refresh();
      navigate("/");
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const sample = setup.sample.loaded;
  const steps = sample
    ? [
        "Open the test sheet on another screen, or print it.",
        "On your phone, open this app, tap your name, then Receive a delivery and scan the widget twice.",
        "As accounting, open the draft bill, add $100 of freight and hold to post.",
        "Watch each widget land at $550, then pay the bill.",
      ]
    : ["On your phone, open this app and tap your name.", "Choose Receive a delivery and scan your first box.", "As accounting, open its draft bill, check it and hold to post."];
  const receipt = (
    <SetupReceipt
      company={setup.company.name || "Your company"}
      sample={sample}
      rows={[
        ["Team", plural(list.length, "person", "people")],
        ["Warehouses", String(setup.counts.warehouses)],
        ["Vendors", String(setup.counts.vendors)],
        ["Items", String(setup.counts.items)],
      ]}
    />
  );
  return (
    <OnboardingFrame
      {...frame}
      stage={receipt}
      footer={
        <>
          <Cta onClick={finish} loading={busy}>
            {first ? "Open ProfitIndex" : "Back to ProfitIndex"}
          </Cta>
          {sample ? (
            <Button component="a" href="/test-sheet" target="_blank" variant="subtle" size="md">
              Open the test sheet
            </Button>
          ) : null}
        </>
      }
    >
      <div className="ob-phone-only" style={{ marginBottom: 28 }}>
        {receipt}
      </div>
      <StepTitle title={me ? `You're all set, ${me.name.split(/\s+/)[0]}.` : "You're all set."} lede={sample ? "Try your first delivery, start to finish:" : "Here's your first delivery:"} />
      <ol className="ob-steps">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </OnboardingFrame>
  );
}
