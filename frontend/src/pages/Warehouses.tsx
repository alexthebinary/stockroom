import {
  Anchor,
  Button,
  Card,
  Grid,
  Group,
  Modal,
  Table,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Warehouse } from "../api";
import { PageHeader, QueryState, toastErr, toastOk } from "../components/ui";

const emptyDraft = { name: "", code: "", address: "", notes: "" };


/** A hover highlight promises the row does something, so it has to. */
const clickableRow = { cursor: "pointer" as const };

export default function Warehouses() {
  const [opened, { open, close }] = useDisclosure(false);
  const [draft, setDraft] = useState(emptyDraft);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["warehouses"],
    queryFn: () => api.get<{ data: Warehouse[] }>("/warehouses"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Warehouse>("/warehouses", {
        name: draft.name.trim(),
        code: draft.code.trim().toUpperCase(),
        address: draft.address.trim() || null,
        notes: draft.notes.trim() || null,
      }),
    onSuccess: () => {
      toastOk("Warehouse created");
      setDraft(emptyDraft);
      close();
      queryClient.invalidateQueries({ queryKey: ["warehouses"] });
    },
    onError: toastErr,
  });

  const rows = data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Warehouses"
        subtitle="Stock is held at warehouse level; bins and locations come later."
        action={<Button onClick={open}>New warehouse</Button>}
      />

      <Card withBorder radius="md" p="md">
        <QueryState
          isLoading={isLoading}
          error={error}
          isEmpty={rows.length === 0}
          emptyMessage="No warehouses yet."
          emptyAction={<Button onClick={open}>New warehouse</Button>}
          onRetry={refetch}
        >
          <Table.ScrollContainer minWidth={720}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Address</Table.Th>
                  <Table.Th ta="right">SKUs stocked</Table.Th>
                  <Table.Th ta="right">On hand</Table.Th>
                  <Table.Th ta="right">Reserved</Table.Th>
                  <Table.Th ta="right">Incoming</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((w) => (
                  <Table.Tr key={w.id} style={clickableRow} onClick={() => navigate(`/warehouses/${w.id}`)}>
                    <Table.Td>
                      <Anchor component={Link} to={`/warehouses/${w.id}`}>{w.code}</Anchor>
                    </Table.Td>
                    <Table.Td>{w.name}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {w.address ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">{w.skuCount ?? 0}</Table.Td>
                    <Table.Td ta="right">{w.totalOnHand ?? 0}</Table.Td>
                    <Table.Td ta="right">{w.totalReserved ?? 0}</Table.Td>
                    <Table.Td ta="right">{w.totalIncoming ?? 0}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </QueryState>
      </Card>

      <Modal opened={opened} onClose={close} title="New warehouse">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.name.trim() && draft.code.trim()) create.mutate();
          }}
        >
        <Grid>
          <Grid.Col span={8}>
            <TextInput
              label="Name"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <TextInput
              label="Code"
              required
              placeholder="MAIN"
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <TextInput
              label="Address"
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <Textarea
              label="Notes"
              autosize
              minRows={2}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.currentTarget.value })}
            />
          </Grid.Col>
        </Grid>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={!draft.name.trim() || !draft.code.trim()}
          >
            Create warehouse
          </Button>
        </Group>
        </form>
      </Modal>
    </>
  );
}
