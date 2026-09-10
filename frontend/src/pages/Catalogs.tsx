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
import { api, type Paginated, type Party, type ProductCategory } from "../api";
import { PageHeader, QueryState, toastErr, toastOk } from "../components/ui";

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

/** Read-only: the posting rules the ledger uses, as configuration. */
function PostingRulesPanel() {
  const list = useQuery({
    queryKey: ["journal-templates"],
    queryFn: () =>
      api.get<{
        data: {
          id: number;
          transactionType: string;
          description: string;
          debitAccountName: string;
          creditAccountName: string;
        }[];
      }>("/journal-templates"),
  });

  return (
    <Card withBorder radius="md" p="md">
      <Title order={5} mb={2}>
        Posting rules
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        Each financial transaction type posts to a fixed pair of accounts. These are configuration,
        not code.
      </Text>
      <QueryState isLoading={list.isLoading} error={list.error} onRetry={list.refetch}>
        <Table className="data-grid" verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Transaction</Table.Th>
              <Table.Th>Debit</Table.Th>
              <Table.Th>Credit</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.data?.data.map((t) => (
              <Table.Tr key={t.id}>
                <Table.Td>
                  <Text size="sm">{t.description}</Text>
                  <Text size="xs" c="dimmed">
                    {t.transactionType}
                  </Text>
                </Table.Td>
                <Table.Td>{t.debitAccountName}</Table.Td>
                <Table.Td>{t.creditAccountName}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </QueryState>
    </Card>
  );
}

export default function Catalogs() {
  return (
    <>
      <PageHeader
        title="Catalogs"
        subtitle="The master data every transaction references. Records in use are archived, never deleted."
      />
      <Tabs defaultValue="customers">
        <Tabs.List mb="md">
          <Tabs.Tab value="customers">Customers</Tabs.Tab>
          <Tabs.Tab value="vendors">Vendors</Tabs.Tab>
          <Tabs.Tab value="employees">Managers</Tabs.Tab>
          <Tabs.Tab value="categories">Categories</Tabs.Tab>
          <Tabs.Tab value="posting">Posting rules</Tabs.Tab>
        </Tabs.List>
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
          <PostingRulesPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
