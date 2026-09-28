import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { api, type Paginated, type Party, type ProductCategory } from "../api";
import { PageHeader, QueryState, formatDate, toastErr, toastOk } from "../components/ui";
import { useAuth } from "../auth";

type PartyKind = "customers" | "vendors" | "employees";

const LABELS: Record<PartyKind, { one: string; many: string }> = {
  customers: { one: "customer", many: "Customers" },
  vendors: { one: "vendor", many: "Vendors" },
  employees: { one: "manager", many: "Managers" },
};

/** Customers, vendors and managers share one shape, so they share one panel. */
function PartyPanel({ kind }: { kind: PartyKind }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const queryClient = useQueryClient();
  const label = LABELS[kind];

  const list = useQuery({
    queryKey: [kind, "all"],
    queryFn: () => api.get<Paginated<Party>>(`/${kind}?pageSize=100`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Party>(`/${kind}`, {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
      }),
    onSuccess: () => {
      toastOk(`${label.one[0].toUpperCase()}${label.one.slice(1)} created`);
      setName("");
      setEmail("");
      setPhone("");
      close();
      queryClient.invalidateQueries({ queryKey: [kind] });
    },
    onError: toastErr,
  });

  const archive = useMutation({
    mutationFn: (id: number) => api.del<{ archived: boolean }>(`/${kind}/${id}`),
    onSuccess: (res) => {
      toastOk(res.archived ? "Archived — it is referenced by existing records" : "Deleted");
      queryClient.invalidateQueries({ queryKey: [kind] });
    },
    onError: toastErr,
  });

  const rows = list.data?.data ?? [];

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <Title order={5}>{label.many}</Title>
        <Button size="xs" onClick={open}>
          New {label.one}
        </Button>
      </Group>

      <QueryState
        isLoading={list.isLoading}
        error={list.error}
        isEmpty={rows.length === 0}
        emptyMessage={`No ${label.many.toLowerCase()} yet.`}
        emptyAction={<Button onClick={open}>New {label.one}</Button>}
        onRetry={list.refetch}
      >
        <Table className="data-grid" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Email</Table.Th>
              {kind !== "employees" && <Table.Th>Phone</Table.Th>}
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td fw={500}>{row.name}</Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {row.email ?? "—"}
                  </Text>
                </Table.Td>
                {kind !== "employees" && (
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {row.phone ?? "—"}
                    </Text>
                  </Table.Td>
                )}
                <Table.Td>
                  <Badge color={row.isActive ? "teal" : "gray"} variant="light" radius="sm">
                    {row.isActive ? "Active" : "Archived"}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {row.isActive && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      loading={archive.isPending && archive.variables === row.id}
                      onClick={() => archive.mutate(row.id)}
                    >
                      Archive
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </QueryState>

      <Modal opened={opened} onClose={close} title={`New ${label.one}`}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <TextInput
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            mb="sm"
          />
          <TextInput
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            mb="sm"
          />
          {kind !== "employees" && (
            <TextInput
              label="Phone"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
            />
          )}
          <Group justify="flex-end" mt="lg">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </Group>
        </form>
      </Modal>
    </Card>
  );
}

/** The scope's two-level tree: a parent, and subcategories under it. */
function CategoryPanel() {
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["product-categories"],
    queryFn: () => api.get<{ data: ProductCategory[] }>("/product-categories"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<ProductCategory>("/product-categories", {
        name: name.trim(),
        parentId: parentId ? Number(parentId) : null,
      }),
    onSuccess: () => {
      toastOk("Category created");
      setName("");
      close();
      queryClient.invalidateQueries({ queryKey: ["product-categories"] });
    },
    onError: toastErr,
  });

  const parents = list.data?.data ?? [];

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <div>
          <Title order={5}>Product categories</Title>
          <Text size="xs" c="dimmed">
            Two levels: a parent category and its subcategories.
          </Text>
        </div>
        <Button size="xs" onClick={open}>
          New category
        </Button>
      </Group>

      <QueryState
        isLoading={list.isLoading}
        error={list.error}
        isEmpty={parents.length === 0}
        emptyMessage="No categories yet."
        onRetry={list.refetch}
      >
        <Table className="data-grid" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Category</Table.Th>
              <Table.Th>Subcategories</Table.Th>
              <Table.Th ta="right">Products</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {parents.map((c) => (
              <Table.Tr key={c.id}>
                <Table.Td fw={500}>{c.name}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {(c.children ?? []).map((child) => (
                      <Badge key={child.id} variant="light" radius="sm" color="gray">
                        {child.name}
                      </Badge>
                    ))}
                    {(c.children ?? []).length === 0 && (
                      <Text size="xs" c="dimmed">
                        none
                      </Text>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">{c._count?.products ?? 0}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </QueryState>

      <Modal opened={opened} onClose={close} title="New category">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <TextInput
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            mb="sm"
          />
          <Select
            label="Parent category"
            placeholder="None — this is a top-level category"
            description="Only top-level categories can be parents."
            data={parents.map((p) => ({ value: String(p.id), label: p.name }))}
            value={parentId}
            onChange={setParentId}
            clearable
          />
          <Group justify="flex-end" mt="lg">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </Group>
        </form>
      </Modal>
    </Card>
  );
}

type Account = { id: number; code: string; name: string; accountType: string; normalSide: string; isActive: boolean };
type PostingRuleRow = {
  id: number;
  transactionType: string;
  description: string;
  role: string;
  label: string;
  side: "DEBIT" | "CREDIT";
  locked: boolean;
  allowedTypes: string[];
  account: { id: number; code: string; name: string };
  lastChange: { actor: string; changedAt: string } | null;
};

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE", "OFF_BALANCE"];

function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ data: Account[] }>("/accounts"),
  });
}

/**
 * Account assignment (client request 2026-09-28): which GL account each line
 * of each transaction posts to. Admin-edited; a change applies to postings
 * made after it and is kept in the rule's history.
 */
function AccountAssignmentPanel() {
  const { user } = useAuth();
  const canEdit = Boolean(user?.can.users);
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["posting-rules"],
    queryFn: () => api.get<{ data: PostingRuleRow[] }>("/posting-rules"),
  });
  const accounts = useAccounts();
  const [historyOf, setHistoryOf] = useState<PostingRuleRow | null>(null);
  const history = useQuery({
    queryKey: ["posting-rule-changes", historyOf?.id],
    enabled: historyOf != null,
    queryFn: () =>
      api.get<{
        data: { id: number; actor: string; changedAt: string; from: { code: string; name: string }; to: { code: string; name: string } }[];
      }>(`/posting-rules/${historyOf!.id}/changes`),
  });
  const save = useMutation({
    mutationFn: (v: { id: number; accountId: number }) => api.put(`/posting-rules/${v.id}`, { accountId: v.accountId }),
    onSuccess: () => {
      toastOk("Account assignment saved. New postings use it; posted entries are unchanged.");
      queryClient.invalidateQueries({ queryKey: ["posting-rules"] });
    },
    onError: toastErr,
  });

  const groups = new Map<string, PostingRuleRow[]>();
  for (const r of rules.data?.data ?? []) groups.set(r.transactionType, [...(groups.get(r.transactionType) ?? []), r]);

  return (
    <Card withBorder radius="md" p="md">
      <Title order={5} mb={2}>
        Account assignment
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        Which account each line of each transaction posts to. A change applies to new postings only; posted
        entries never move. Inventory and its clearing accounts are locked: the stock valuation and the
        month-end close reconcile against them.
      </Text>
      <QueryState isLoading={rules.isLoading || accounts.isLoading} error={rules.error ?? accounts.error} onRetry={rules.refetch}>
        <Table className="data-grid" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Transaction</Table.Th>
              <Table.Th>Line</Table.Th>
              <Table.Th>Account</Table.Th>
              <Table.Th>Last change</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...groups.entries()].map(([type, rows]) =>
              rows.map((r, i) => (
                <Table.Tr key={r.id}>
                  {i === 0 && (
                    <Table.Td rowSpan={rows.length} style={{ verticalAlign: "top" }}>
                      <Text size="sm">{r.description}</Text>
                      <Text size="xs" c="dimmed">
                        {type}
                      </Text>
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Badge size="xs" variant="light" color={r.side === "DEBIT" ? "blue" : "grape"}>
                        {r.side === "DEBIT" ? "Dr" : "Cr"}
                      </Badge>
                      <Text size="sm">{r.label}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td miw={260}>
                    {r.locked || !canEdit ? (
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm">
                          {r.account.code} {r.account.name}
                        </Text>
                        {r.locked && (
                          <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }} title="Valuation and close reconcile this account">
                            locked
                          </Badge>
                        )}
                      </Group>
                    ) : (
                      <Select
                        size="xs"
                        aria-label={`${type} ${r.label}`}
                        value={String(r.account.id)}
                        data={(accounts.data?.data ?? [])
                          .filter((a) => (a.isActive && r.allowedTypes.includes(a.accountType)) || a.id === r.account.id)
                          .map((a) => ({ value: String(a.id), label: `${a.code} ${a.name}` }))}
                        onChange={(v) => v && Number(v) !== r.account.id && save.mutate({ id: r.id, accountId: Number(v) })}
                        allowDeselect={false}
                      />
                    )}
                  </Table.Td>
                  <Table.Td>
                    {r.lastChange ? (
                      <Button size="compact-xs" variant="subtle" onClick={() => setHistoryOf(r)}>
                        {r.lastChange.actor} · {formatDate(r.lastChange.changedAt)}
                      </Button>
                    ) : (
                      <Text size="xs" c="dimmed">
                        default
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </QueryState>

      <Modal opened={historyOf != null} onClose={() => setHistoryOf(null)} title={historyOf ? `${historyOf.transactionType} · ${historyOf.label}` : ""}>
        <QueryState isLoading={history.isLoading} error={history.error}>
          <Table verticalSpacing={4}>
            <Table.Tbody>
              {history.data?.data.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {formatDate(c.changedAt)} · {c.actor}
                    </Text>
                    <Text size="sm">
                      {c.from.code} {c.from.name} → {c.to.code} {c.to.name}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </QueryState>
      </Modal>
    </Card>
  );
}

/** Chart of accounts: add, rename, deactivate (admin). Accounts are never deleted. */
function ChartOfAccountsPanel() {
  const { user } = useAuth();
  const canEdit = Boolean(user?.can.users);
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const [opened, { open, close }] = useDisclosure(false);
  const [draft, setDraft] = useState({ code: "", name: "", accountType: "EXPENSE", normalSide: "DEBIT" });
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
    queryClient.invalidateQueries({ queryKey: ["posting-rules"] });
  };
  const create = useMutation({
    mutationFn: () =>
      api.post("/accounts", {
        code: draft.code.trim(),
        name: draft.name.trim(),
        accountType: draft.accountType,
        ...(draft.accountType === "OFF_BALANCE" ? { normalSide: draft.normalSide } : {}),
      }),
    onSuccess: () => {
      toastOk(`Account ${draft.code} added`);
      close();
      setDraft({ code: "", name: "", accountType: "EXPENSE", normalSide: "DEBIT" });
      refresh();
    },
    onError: toastErr,
  });
  const update = useMutation({
    mutationFn: (v: { id: number; body: { name?: string; isActive?: boolean } }) => api.put(`/accounts/${v.id}`, v.body),
    onSuccess: () => {
      setRenaming(null);
      refresh();
    },
    onError: toastErr,
  });

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <div>
          <Title order={5} mb={2}>
            Chart of accounts
          </Title>
          <Text size="xs" c="dimmed">
            An account with postings keeps its type; one that a transaction line uses cannot be deactivated.
          </Text>
        </div>
        {canEdit && (
          <Button size="xs" onClick={open}>
            Add account
          </Button>
        )}
      </Group>
      <QueryState isLoading={accounts.isLoading} error={accounts.error} onRetry={accounts.refetch}>
        <Table className="data-grid" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Normal side</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {accounts.data?.data.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>{a.code}</Table.Td>
                <Table.Td>
                  {renaming?.id === a.id ? (
                    <Group gap={6} wrap="nowrap">
                      <TextInput
                        size="xs"
                        aria-label={`Rename ${a.code}`}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: a.id, name: e.currentTarget.value })}
                      />
                      <Button size="compact-xs" onClick={() => update.mutate({ id: a.id, body: { name: renaming.name } })}>
                        Save
                      </Button>
                    </Group>
                  ) : canEdit ? (
                    <Button size="compact-xs" variant="subtle" onClick={() => setRenaming({ id: a.id, name: a.name })}>
                      {a.name}
                    </Button>
                  ) : (
                    a.name
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{a.accountType.replace("_", "-").toLowerCase()}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{a.normalSide.toLowerCase()}</Text>
                </Table.Td>
                <Table.Td>
                  {canEdit ? (
                    <Button
                      size="compact-xs"
                      variant="light"
                      color={a.isActive ? "teal" : "gray"}
                      onClick={() => update.mutate({ id: a.id, body: { isActive: !a.isActive } })}
                    >
                      {a.isActive ? "Active" : "Inactive"}
                    </Button>
                  ) : (
                    <Badge size="sm" variant="light" color={a.isActive ? "teal" : "gray"}>
                      {a.isActive ? "Active" : "Inactive"}
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </QueryState>

      <Modal opened={opened} onClose={close} title="Add account">
        <TextInput label="Code" description="Four digits" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })} mb="sm" />
        <TextInput label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} mb="sm" />
        <Select
          label="Type"
          data={ACCOUNT_TYPES.map((t) => ({ value: t, label: t.replace("_", "-").toLowerCase() }))}
          value={draft.accountType}
          onChange={(v) => v && setDraft({ ...draft, accountType: v })}
          allowDeselect={false}
          mb="sm"
        />
        {draft.accountType === "OFF_BALANCE" && (
          <Select
            label="Normal side"
            data={[{ value: "DEBIT", label: "debit" }, { value: "CREDIT", label: "credit" }]}
            value={draft.normalSide}
            onChange={(v) => v && setDraft({ ...draft, normalSide: v })}
            allowDeselect={false}
            mb="sm"
          />
        )}
        <Group justify="flex-end">
          <Button loading={create.isPending} onClick={() => create.mutate()} disabled={!draft.code || !draft.name}>
            Add
          </Button>
        </Group>
      </Modal>
    </Card>
  );
}

const CATALOG_TABS = ["customers", "vendors", "employees", "categories", "posting", "accounts"] as const;

export default function Catalogs() {
  const { tab } = useParams();
  if (!CATALOG_TABS.includes((tab ?? "") as (typeof CATALOG_TABS)[number])) {
    return <Navigate to="/catalogs/customers" replace />;
  }

  return (
    <>
      <PageHeader
        title="Catalogs"
        subtitle="The master data every transaction references. Records in use are archived, never deleted."
      />
      {/* The tab list lives in the app's second navigation row. */}
      <Tabs value={tab}>
        <Tabs.Panel value="customers">
          <PartyPanel kind="customers" />
        </Tabs.Panel>
        <Tabs.Panel value="vendors">
          <PartyPanel kind="vendors" />
        </Tabs.Panel>
        <Tabs.Panel value="employees">
          <PartyPanel kind="employees" />
        </Tabs.Panel>
        <Tabs.Panel value="categories">
          <CategoryPanel />
        </Tabs.Panel>
        <Tabs.Panel value="posting">
          <AccountAssignmentPanel />
        </Tabs.Panel>
        <Tabs.Panel value="accounts">
          <ChartOfAccountsPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
