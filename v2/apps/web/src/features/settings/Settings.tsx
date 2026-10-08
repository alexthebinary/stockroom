import { Alert, Badge, Button, Card, Group, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { del, get, post, type Profile, put } from "../../lib/api";
import { JOB_LABEL } from "../../lib/profile";
import type { Setup, Vendor, Warehouse } from "../../lib/types";

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
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  return (
    <Stack>
      <Card withBorder>
        <Text fw={600} mb="xs">
          Warehouses
        </Text>
        {(warehouses.data ?? []).map((w) => (
          <Text key={w.id}>
            {w.code} · {w.name}
          </Text>
        ))}
      </Card>
      <Card withBorder>
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
    try {
      const normalSide = ["ASSET", "EXPENSE"].includes(form.type) ? "DEBIT" : "CREDIT";
      await post("/accounts", { ...form, normalSide });
      setForm({ code: "", name: "", type: "ASSET" });
      accounts.refetch();
    } catch (error) {
      toastErr(error);
    }
  };
  const usable = (accounts.data ?? []).filter((a) => !a.isHeader && a.isActive).map((a) => ({ value: String(a.id), label: `${a.code} ${a.name}` }));
  return (
    <Stack>
      <Card withBorder>
        <Text fw={600}>Account assignment</Text>
        <Text size="sm" c="dimmed" mb="sm">
          Which account each kind of posting lands in. The inventory accounts are locked: the books check compares them to the stock records.
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
                <Select data={usable} value={String(r.account.id)} onChange={(v) => repoint(r.role, v)} w={260} />
              )}
            </Group>
          ))}
        </Stack>
      </Card>
      <Card withBorder>
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
        <Group mt="sm" align="flex-end">
          <TextInput label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.currentTarget.value })} w={90} />
          <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} style={{ flex: 1 }} />
          <Select label="Type" data={["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]} value={form.type} onChange={(v) => setForm({ ...form, type: v ?? "ASSET" })} w={140} />
          <Button variant="light" onClick={add} disabled={!form.code || !form.name}>
            Add
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}

function Company() {
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const clear = async () => {
    try {
      await del("/setup/sample-data");
      toastOk("Sample data cleared");
      queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <Stack>
      <Text>{setup.data?.company.name}</Text>
      <Button component={Link} to="/setup" variant="light" w="fit-content">
        Open setup
      </Button>
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
    </Stack>
  );
}
