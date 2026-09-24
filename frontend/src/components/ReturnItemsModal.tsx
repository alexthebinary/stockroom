import { useState, useEffect } from 'react';
import { Modal, Table, NumberInput, Select, Textarea, Button, Group, Text, Stack } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, type SalesOrder, type Paginated, type Warehouse } from "../api";
import { money, toastOk, toastErr } from "./ui";

type Disposition = 'RESTOCK' | 'WRITE_OFF';
type RefundMethod = 'CARD' | 'CASH' | 'BANK';

interface ReturnItemsModalProps {
  order: SalesOrder;
  opened: boolean;
  onClose: () => void;
}

export function ReturnItemsModal({ order, opened, onClose }: ReturnItemsModalProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [conditions, setConditions] = useState<Record<string, Disposition>>({});
  const [warehouseIds, setWarehouseIds] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('CARD');
  const [pending, setPending] = useState(false);

  const queryClient = useQueryClient();

  const { data: warehousesData } = useQuery({
    queryKey: ["warehouses", "options"],
    queryFn: () => api.get<Paginated<Warehouse>>(`/warehouses${qs({ pageSize: 100 })}`),
    staleTime: 60_000,
  });

  // Only active warehouses: the server refuses to restock into a deactivated one.
  const warehouseOptions = (warehousesData?.data ?? [])
    .filter((w) => w.isActive)
    .map((w) => ({ value: String(w.id), label: `${w.code} — ${w.name}` }));

  // Reset form on open; capture order at open time
  useEffect(() => {
    if (opened) {
      const q: Record<string, number> = {};
      const c: Record<string, Disposition> = {};
      const w: Record<string, string> = {};

      order.lines.forEach(line => {
        q[line.id] = 0;
        c[line.id] = 'RESTOCK';
        w[line.id] = String(line.warehouseId);
      });

      setQuantities(q);
      setConditions(c);
      setWarehouseIds(w);
      setReason('');

      const last = order.deposits?.slice().reverse().find(d => d.method)?.method;
      setRefundMethod(last === 'CARD' || last === 'CASH' || last === 'BANK' ? last : 'CARD');
    }
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  // Credit = returned value + proportional tax share
  const returnedValue = order.lines.reduce((sum, line) => {
    return sum + (quantities[line.id] || 0) * (line.unitPriceCents || 0);
  }, 0);
  const taxShare = order.subtotalCents > 0
    ? Math.round((order.taxCents * returnedValue) / order.subtotalCents)
    : 0;
  const creditCents = returnedValue + taxShare;

  const hasReturning = order.lines.some(line => (quantities[line.id] || 0) > 0);
  const canSubmit = hasReturning && reason.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setPending(true);
    try {
      const lines = order.lines
        .map(line => {
          const qty = quantities[line.id] || 0;
          if (qty <= 0) return null;
          const disposition = conditions[line.id] || 'RESTOCK';
          const wh = disposition === 'RESTOCK' ? warehouseIds[line.id] : undefined;
          return {
            lineId: line.id,
            quantity: qty,
            disposition,
            ...(wh ? { warehouseId: Number(wh) } : {}),
          };
        })
        .filter((l): l is { lineId: number; quantity: number; disposition: Disposition; warehouseId?: number } => l !== null);

      const res = await api.post<{
        salesReturn: { returnNumber: string };
        creditCents: number;
        refundCents: number;
      }>(`/sales-orders/${order.id}/returns`, {
        reason: reason.trim(),
        refundMethod,
        lines,
      });

      toastOk(
        `${res.salesReturn.returnNumber} recorded — ${money(res.creditCents)} credited${
          res.refundCents > 0 ? `, ${money(res.refundCents)} refunded` : ''
        }`
      );
      queryClient.invalidateQueries();
      onClose();
    } catch (e) {
      toastErr(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={`Return items — ${order.orderNumber}`}>
      <Stack>
        <Table.ScrollContainer minWidth={640}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Product</Table.Th>
              <Table.Th>Sold</Table.Th>
              <Table.Th>Already returned</Table.Th>
              <Table.Th>Returning</Table.Th>
              <Table.Th>Condition</Table.Th>
              <Table.Th>Warehouse</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {order.lines.map(line => {
              const max = line.quantity - (line.returnedQty ?? 0);
              const qty = quantities[line.id] ?? 0;
              const cond = conditions[line.id] ?? 'RESTOCK';
              const wh = warehouseIds[line.id] ?? String(line.warehouseId);

              return (
                <Table.Tr key={line.id}>
                  <Table.Td>{line.product?.sku} {line.product?.name}</Table.Td>
                  <Table.Td>{line.quantity}</Table.Td>
                  <Table.Td>{line.returnedQty ?? 0}</Table.Td>
                  <Table.Td>
                    <NumberInput
                      value={qty}
                      onChange={(val) => {
                        const num = typeof val === 'number' ? val : 0;
                        setQuantities(prev => ({ ...prev, [line.id]: Math.max(0, Math.min(num, max)) }));
                      }}
                      min={0}
                      max={max}
                      disabled={max === 0}
                      size="xs"
                    />
                  </Table.Td>
                  <Table.Td>
                    <Select
                      value={cond}
                      onChange={(val) => setConditions(prev => ({ ...prev, [line.id]: (val as Disposition) || 'RESTOCK' }))}
                      data={[
                        { value: 'RESTOCK', label: 'Back on the shelf' },
                        { value: 'WRITE_OFF', label: 'Damaged — write off' },
                      ]}
                      size="xs"
                    />
                  </Table.Td>
                  <Table.Td style={{ minWidth: 140 }}>
                    {cond === 'RESTOCK' ? (
                      <Select
                        value={wh}
                        onChange={(val) => { if (val) setWarehouseIds(prev => ({ ...prev, [line.id]: val })); }}
                        data={warehouseOptions}
                        size="xs"
                      />
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        </Table.ScrollContainer>

        <Textarea
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          placeholder="Wrong size, arrived damaged, etc."
        />

        <Select
          label="Refund to"
          value={refundMethod}
          onChange={(val) => setRefundMethod((val as RefundMethod) || 'CARD')}
          data={[
            { value: 'CARD', label: 'Card' },
            { value: 'CASH', label: 'Cash' },
            { value: 'BANK', label: 'Bank transfer' },
          ]}
        />

        <div>
          <Text>Credit to customer: {money(creditCents)}</Text>
          <Text size="xs" c="dimmed">
            Shipping is not refunded. Any amount the customer has already paid beyond what they now owe is refunded to the method above.
          </Text>
        </div>
      </Stack>

      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!canSubmit} loading={pending}>
          Record return
        </Button>
      </Group>
    </Modal>
  );
}
