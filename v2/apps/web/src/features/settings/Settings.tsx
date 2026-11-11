import { Alert, Badge, Button, Card, Group, Select, Stack, Switch, Table, Tabs, Text, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useBlurErrors } from "../../components/form";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { del, get, post, type Profile, put } from "../../lib/api";
import { JOB_LABEL } from "../../lib/profile";
import type { Setup, Vendor, Warehouse } from "../../lib/types";
import { CompaniesPanel, TestCompanyNotice } from "./Companies";

type Account = { id: number; code: string; name: string; type: string; isHeader: boolean; isActive: boolean; parentId: number | null; balanceCents: number };
type Rule = { id: number; role: string; label: string; locked: boolean; account: Account; changes: { at: string; actor: string }[] };

export function Settings() {
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs defaultValue="team">
        <Tabs.List mb="md">
          <Tabs.Tab value="team">Team</Tabs.Tab>
          <Tabs.Tab value="places">Warehouses & vendors</Tabs.Tab>
          <Tabs.Tab value="accounts">Accounts</Tabs.Tab>
          <Tabs.Tab value="company">Company</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="team">
          <Team />
        </Tabs.Panel>
        <Tabs.Panel value="places">
          <Places />
        </Tabs.Panel>
        <Tabs.Panel value="accounts">
          <Accounts />
        </Tabs.Panel>
        <Tabs.Panel value="company">
          <Company />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function Team() {
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => get<Profile[]>("/profiles") });
  const remove = async (p: Profile) => {
    try {
      await put(`/profiles/${p.id}`, { isActive: false });
      profiles.refetch();
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <Stack>
      <Text c="dimmed">No passwords: each person taps their name on their device. People add themselves from the "Who's working?" screen.</Text>
      {(profiles.data ?? []).map((p) => (
        <Group key={p.id} justify="space-between">
          <Text>
            {p.name} · {JOB_LABEL[p.job]}
          </Text>
          <Button size="xs" variant="subtle" color="red" onClick={() => remove(p)}>
            Remove
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

function Places() {
  const queryClient = useQueryClient();
  const [warehouse, setWarehouse] = useState({ code: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const errors = useBlurErrors();
  const addWarehouse = async () => {
    if (busy || !errors.submit(Boolean(warehouse.code.trim() && warehouse.name.trim()))) return;
    setBusy(true);
    setFailed("");
    try {
      const created = await post<Warehouse>("/warehouses", { code: warehouse.code, name: warehouse.name });
      setWarehouse({ code: "", name: "" });
      errors.reset();
      toastOk(`${created.name} added`);
      await queryClient.invalidateQueries({ queryKey: ["warehouses"] });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  return (
    <Stack>
      <Card withBorder className="section">
        <Text fw={600} mb="xs">
          Warehouses
        </Text>
        {(warehouses.data ?? []).map((w) => (
          <Text key={w.id}>
            {w.code} · {w.name}
          </Text>
        ))}
        <form noValidate onSubmit={(e) => { e.preventDefault(); void addWarehouse(); }}>
          {failed ? (
            <Alert role="alert" color="orange" title="The warehouse was not added" mt="sm" styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" } }}>
              {failed} Nothing was saved; fix it and press Add warehouse again.
            </Alert>
          ) : null}
          <Group align="flex-end" mt="sm" wrap="wrap">
            <TextInput label="Code" withAsterisk placeholder="e.g. EAST" value={warehouse.code} maxLength={12} onChange={(e) => setWarehouse({ ...warehouse, code: e.currentTarget.value })} onBlur={errors.blur("code")} error={errors.show("code", warehouse.code.trim() ? null : "Type a short code, like EAST.")} w={120} />
            <TextInput label="Name" withAsterisk placeholder="e.g. East warehouse" value={warehouse.name} onChange={(e) => setWarehouse({ ...warehouse, name: e.currentTarget.value })} onBlur={errors.blur("name")} error={errors.show("name", warehouse.name.trim() ? null : "Type the warehouse name.")} style={{ flex: 1, minWidth: 180 }} />
            <Button type="submit" loading={busy}>
              Add warehouse
            </Button>
          </Group>
        </form>
      </Card>
      <Card withBorder className="section">
        <Text fw={600} mb="xs">
          Vendors
        </Text>
        {(vendors.data ?? []).map((v) => (
          <Text key={v.id}>
            {v.name} · {v.kind === "CARRIER" ? "carrier" : "supplier"} · {v.paymentTermsDays} days
          </Text>
        ))}
        <Text size="sm" c="dimmed" mt="xs">
          Add more from <Link to="/setup">setup</Link>.
        </Text>
      </Card>
    </Stack>
  );
}

function Accounts() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => get<Account[]>("/accounts") });
  const rules = useQuery({ queryKey: ["posting-rules"], queryFn: () => get<Rule[]>("/posting-rules") });
  const [form, setForm] = useState({ code: "", name: "", type: "ASSET" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const errors = useBlurErrors();
  const repoint = async (role: string, accountId: string | null) => {
    try {
      await put(`/posting-rules/${role}`, { accountId: Number(accountId) });
      toastOk("Saved — new entries use it; past entries keep their account");
      queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    }
  };
  const add = async () => {
    if (busy || !errors.submit(Boolean(form.code && form.name))) return;
    setBusy(true);
    setFailed("");
    try {
      const normalSide = ["ASSET", "EXPENSE"].includes(form.type) ? "DEBIT" : "CREDIT";
      await post("/accounts", { ...form, normalSide });
      setForm({ code: "", name: "", type: "ASSET" });
      errors.reset();
      accounts.refetch();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const usable = (accounts.data ?? []).filter((a) => !a.isHeader && a.isActive).map((a) => ({ value: String(a.id), label: `${a.code} ${a.name}` }));
  return (
    <Stack>
      <Card withBorder className="section">
        <Text fw={600}>Account assignment</Text>
        <Text size="sm" c="dimmed" mb="sm">
          Which account each kind of posting lands in. Inventory always posts to 1200 Inventory Asset (locked): the books check compares it to the stock records.
        </Text>
        <Stack gap="xs">
          {(rules.data ?? []).map((r) => (
            <Group key={r.role} justify="space-between" wrap="nowrap">
              <Text>{r.label}</Text>
              {r.locked ? (
                <Badge color="gray">
                  {r.account.code} {r.account.name} · locked
                </Badge>
              ) : (
                <Select aria-label={r.label} placeholder={accounts.isLoading ? "Loading…" : undefined} disabled={accounts.isLoading} data={usable} value={String(r.account.id)} onChange={(v) => repoint(r.role, v)} w={260} />
              )}
            </Group>
          ))}
        </Stack>
      </Card>
      <Card withBorder className="section">
        <Text fw={600} mb="xs">
          Chart of accounts
        </Text>
        <Table>
          <Table.Tbody>
            {(accounts.data ?? []).map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td pl={a.parentId ? 28 : undefined} fw={a.isHeader ? 600 : undefined}>
                  {a.code} {a.name}
                </Table.Td>
                <Table.Td c="dimmed">{a.type.toLowerCase()}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <form noValidate onSubmit={(e) => { e.preventDefault(); void add(); }}>
          {failed ? (
            <Alert role="alert" color="orange" title="The account was not added" mt="sm" styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" } }}>
              {failed} Nothing was saved; fix it and press Add again.
            </Alert>
          ) : null}
          <Group mt="sm" align="flex-end">
            <TextInput label="Code" withAsterisk value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value })} onBlur={errors.blur("code")} error={errors.show("code", form.code ? null : "Type the account code.")} w={90} />
            <TextInput label="Name" withAsterisk value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} onBlur={errors.blur("name")} error={errors.show("name", form.name ? null : "Type the account name.")} style={{ flex: 1 }} />
            <Select label="Type" data={["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]} value={form.type} onChange={(v) => setForm({ ...form, type: v ?? "ASSET" })} allowDeselect={false} w={140} />
            <Button variant="light" type="submit" loading={busy}>
              Add
            </Button>
          </Group>
        </form>
      </Card>
    </Stack>
  );
}

function Company() {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const [failed, setFailed] = useState("");
  const clear = async () => {
    setFailed("");
    try {
      await del("/setup/sample-data");
      toastOk("Sample data cleared");
      queryClient.invalidateQueries();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      toastErr(error);
    }
  };
  return (
    <Stack>
      <TestCompanyNotice />
      <Text>{setup.data?.company.name}</Text>
      <Button component={Link} to="/setup" variant="light" w="fit-content">
        Open setup
      </Button>
      {setup.data ? (
        <Switch
          label="Beta feedback tab"
          description="The Feedback tab on the right edge of every screen, for testers to pin notes."
          checked={setup.data.company.feedbackEnabled}
          onChange={async (event) => {
            const c = setup.data!.company;
            setFailed("");
            try {
              await put("/setup/company", { name: c.name, address: c.address ?? undefined, homeState: c.homeState ?? undefined, fiscalYearStartMonth: c.fiscalYearStartMonth, feedbackEnabled: event.currentTarget.checked });
              await queryClient.invalidateQueries({ queryKey: ["setup"] });
            } catch (error) {
              setFailed(error instanceof Error ? error.message : String(error));
              toastErr(error);
            }
          }}
        />
      ) : null}
      {failed ? (
        <Alert role="alert" color="orange" title="That change was not saved" styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" } }}>
          {failed} Nothing was saved.
        </Alert>
      ) : null}
      {setup.data?.sample.loaded ? (
        <Alert color="blue" title="Sample data">
          <Text size="sm" mb="xs">
            {setup.data.sample.canClear ? "Remove the sample warehouse, vendors and items before going live." : "Sample data can't be cleared once orders, scans or entries exist. For a clean company, reset this install (see the README: npm run fresh)."}
          </Text>
          <Button size="xs" color="red" variant="light" onClick={clear} disabled={!setup.data.sample.canClear}>
            Clear sample data
          </Button>
        </Alert>
      ) : null}
      <Card withBorder className="section">
        <Text fw={600} mb="xs">
          Test companies
        </Text>
        <CompaniesPanel />
      </Card>
    </Stack>
  );
}
