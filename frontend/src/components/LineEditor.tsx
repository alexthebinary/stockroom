import { ActionIcon, Button, Group, NumberInput, Select, Stack, Table, Text } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useProductOptions, useWarehouseOptions } from "../hooks";
import { money } from "./ui";

export type DraftLine = {
  productId: string | null;
  warehouseId: string | null;
  quantity: number | "";
  /** Unit price on a sales order, unit cost on a purchase order. In cents. */
  unitAmountCents?: number;
};

export const emptyLine: DraftLine = { productId: null, warehouseId: null, quantity: 1 };

export function isCompleteLine(line: DraftLine) {
  return line.productId !== null && line.warehouseId !== null && Number(line.quantity) > 0;
}

/**
 * Submitting only the complete lines would silently drop whatever the user had
 * half-filled, so an order is only ready when every line it shows is complete.
 */
export function linesReady(lines: DraftLine[]) {
  return lines.length > 0 && lines.every(isCompleteLine);
}

export function incompleteLineCount(lines: DraftLine[]) {
  return lines.filter((l) => !isCompleteLine(l)).length;
}

/**
 * Shared line editor for sales and purchase orders. The money column is
 * labelled by the caller (price vs cost) but is the same integer-cents field,
 * pre-filled from the product's default so the common case is one click.
 */
export function LineEditor({
  lines,
  onChange,
  defaultWarehouseId,
  amountLabel,
}: {
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  defaultWarehouseId: string | null;
  amountLabel: string;
}) {
  const products = useProductOptions();
  const warehouses = useWarehouseOptions();

  const update = (index: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  /** Picking a product seeds the amount from its default price or cost. */
  const pickProduct = (index: number, value: string | null) => {
    const product = products.products.find((p) => String(p.id) === value);
    const seeded =
      amountLabel.toLowerCase().includes("cost")
        ? product?.defaultCostCents
        : product?.defaultPriceCents;
    update(index, { productId: value, unitAmountCents: seeded ?? 0 });
  };

  const total = lines.reduce(
    (s, l) => s + Number(l.unitAmountCents ?? 0) * Number(l.quantity || 0),
    0
  );

  return (
    <Stack gap="xs">
      <Table verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Product</Table.Th>
            <Table.Th w={180}>Warehouse</Table.Th>
            <Table.Th w={100}>Qty</Table.Th>
            <Table.Th w={140}>{amountLabel}</Table.Th>
            <Table.Th w={110} ta="right">
              Line total
            </Table.Th>
            <Table.Th w={44} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {lines.map((line, index) => (
            <Table.Tr key={index}>
              <Table.Td>
                <Select
                  placeholder="Pick a product"
                  data={products.options}
                  value={line.productId}
                  onChange={(v) => pickProduct(index, v)}
                  searchable
                />
              </Table.Td>
              <Table.Td>
                <Select
                  placeholder="Warehouse"
                  data={warehouses.options}
                  value={line.warehouseId}
                  onChange={(v) => update(index, { warehouseId: v })}
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  min={1}
                  value={line.quantity}
                  onChange={(v) => update(index, { quantity: v === "" ? "" : Number(v) })}
                />
              </Table.Td>
              <Table.Td>
                {/* Entered in dollars, stored in cents — the conversion happens
                    here so nothing downstream sees a float. */}
                <NumberInput
                  min={0}
                  decimalScale={2}
                  fixedDecimalScale
                  prefix="$"
                  value={(line.unitAmountCents ?? 0) / 100}
                  onChange={(v) =>
                    update(index, { unitAmountCents: Math.round(Number(v || 0) * 100) })
                  }
                />
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm" fw={600}>
                  {money(Number(line.unitAmountCents ?? 0) * Number(line.quantity || 0))}
                </Text>
              </Table.Td>
              <Table.Td>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => onChange(lines.filter((_, i) => i !== index))}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Group justify="space-between">
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange([...lines, { ...emptyLine, warehouseId: defaultWarehouseId }])}
        >
          Add line
        </Button>
        <Group gap="lg">
          {incompleteLineCount(lines) > 0 && (
            <Text size="xs" c="orange">
              {incompleteLineCount(lines)} line(s) still need a product, warehouse and quantity
            </Text>
          )}
          <Text size="sm" fw={700}>
            Subtotal {money(total)}
          </Text>
        </Group>
      </Group>
    </Stack>
  );
}
