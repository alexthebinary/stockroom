import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Grid, TextInput, Select, SegmentedControl, Button, Card, Group, Text, 
  Stack, ActionIcon, Badge
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus, IconMinus, IconX, IconSearch } from '@tabler/icons-react';
import { api, qs, type Paginated, type Balance, type Party, type Warehouse, openPdf } from '../api';
import { useAuth } from '../auth';
import { PageHeader, money, toastOk, toastErr } from '../components/ui';

interface CartLine {
  productId: number;
  warehouseId: number;
  name: string;
  unitPriceCents: number;
  quantity: number;
  availableQty: number;
}

type CounterSaleResult = {
  order: { id: number; orderNumber: string; totalCents: number; customerName: string };
  invoice: { id: number; invoiceNumber: string; totalCents: number };
};

/**
 * The showroom counter.
 *
 * A client who visits wants to pay and leave with the goods, so this is one
 * screen and one button: the server creates, reserves, takes payment, ships and
 * invoices in a single transaction, and the paid invoice is what they take home.
 */
interface SuccessState {
  invoiceNumber: string;
  totalCents: number;
  clientName: string;
  invoiceId: number;
}

export default function Showroom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const [warehouseId, setWarehouseId] = useState<number | undefined>();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [clientMode, setClientMode] = useState<'walkin' | 'new' | 'existing'>('walkin');
  const [newClient, setNewClient] = useState({ name: '', email: '', phone: '' });
  const [existingClientId, setExistingClientId] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'CARD' | 'CASH' | 'BANK'>('CARD');
  // Sales tax is collected at the counter; same default as the order form.
  // Counter tax is the showroom's rate (PA 6%, pa.gov), read from the channel
  // policy and shown, not typed: a wrong rate at the counter lands on every sale.
  const channels = useQuery({
    queryKey: ['sales-channels'],
    queryFn: () => api.get<{ channels: { code: string; defaultTaxPct: number }[] }>('/sales-orders/channels'),
    staleTime: Infinity,
  });
  const taxPercent = channels.data?.channels.find((c) => c.code === 'SHOWROOM')?.defaultTaxPct ?? 6;
  const [success, setSuccess] = useState<SuccessState | null>(null);

  const { data: warehousesData } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => api.get<Paginated<Warehouse>>('/warehouses' + qs({ pageSize: 100 })),
  });

  const warehouses = warehousesData?.data ?? [];
  const activeWarehouses = useMemo(() => warehouses.filter(w => w.isActive), [warehouses]);

  useEffect(() => {
    if (warehouseId === undefined && activeWarehouses.length > 0) {
      // The counter sells from the showroom's own stock: prefer the warehouse
      // named as the showroom, then MAIN, and only then whatever sorts first.
      // Remembered per device: the counter is always the same place.
      let remembered: number | null = null;
      try {
        remembered = Number(localStorage.getItem('showroom-warehouse')) || null;
      } catch {
        /* storage blocked */
      }
      const showroom =
        activeWarehouses.find((w) => w.id === remembered) ??
        activeWarehouses.find((w) => /showroom/i.test(w.name)) ??
        activeWarehouses.find((w) => w.code === "MAIN") ??
        activeWarehouses[0];
      setWarehouseId(showroom.id);
    }
  }, [activeWarehouses, warehouseId]);

  const { data: inventoryData } = useQuery({
    queryKey: ['inventory', warehouseId, debouncedSearch],
    queryFn: () => api.get<Paginated<Balance>>(`/inventory${qs({ warehouseId, search: debouncedSearch, pageSize: 12 })}`),
    enabled: !!warehouseId,
  });

  const { data: customersData } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<Paginated<Party>>('/customers' + qs({ pageSize: 200 })),
  });

  const cartMap = useMemo(() => {
    const m = new Map<number, number>();
    cart.forEach(l => m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity));
    return m;
  }, [cart]);

  const subtotalCents = useMemo(() =>
    cart.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0), [cart]);
  const taxCents = Math.round((subtotalCents * Number(taxPercent || 0)) / 100);
  const totalCents = subtotalCents + taxCents;

  const canTakePayment = useMemo(() => {
    if (cart.length === 0) return false;
    if (!(user?.can?.stock && user?.can?.money)) return false;
    if (clientMode === 'new' && !newClient.name.trim()) return false;
    if (clientMode === 'existing' && !existingClientId) return false;
    return true;
  }, [cart.length, user?.can, clientMode, newClient.name, existingClientId]);

  const handleWarehouseChange = (value: string | null) => {
    const newId = value ? Number(value) : undefined;
    if (newId !== warehouseId) {
      setCart([]);
      setSuccess(null);
    }
    setWarehouseId(newId);
    try {
      if (newId) localStorage.setItem('showroom-warehouse', String(newId));
    } catch {
      /* storage blocked */
    }
  };

  const addToCart = (balance: Balance) => {
    const product = balance.product;
    if (!product?.isActive) return;
    const cartQty = cartMap.get(balance.productId) ?? 0;
    if (cartQty >= balance.availableQty) return;

    setCart(prev => {
      const idx = prev.findIndex(l => l.productId === balance.productId);
      if (idx !== -1) {
        return prev.map((l, i) => 
          i === idx ? { ...l, quantity: Math.min(l.quantity + 1, l.availableQty) } : l
        );
      }
      return [...prev, {
        productId: balance.productId,
        warehouseId: balance.warehouseId,
        name: product.name,
        unitPriceCents: product.defaultPriceCents,
        quantity: 1,
        availableQty: balance.availableQty,
      }];
    });
  };

  const updateQty = (index: number, qty: number) => {
    setCart(prev => prev.map((l, i) => i === index ? { ...l, quantity: qty } : l));
  };

  const incrementQty = (index: number) => {
    const l = cart[index];
    if (l) updateQty(index, Math.min(l.quantity + 1, l.availableQty));
  };

  const decrementQty = (index: number) => {
    const l = cart[index];
    if (l) updateQty(index, Math.max(1, l.quantity - 1));
  };

  const removeLine = (index: number) => {
    setCart(prev => prev.filter((_, i) => i !== index));
  };

  const saleMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<CounterSaleResult>('/sales-orders/counter-sale', body),
    onSuccess: (data) => {
      setSuccess({
        invoiceNumber: data.invoice.invoiceNumber,
        totalCents: data.invoice.totalCents,
        clientName: data.order.customerName || 'Walk-in',
        invoiceId: data.invoice.id,
      });
      setCart([]);
      // Stock, the ledger, the dashboard and the close all moved at once.
      queryClient.invalidateQueries();
      toastOk(`${data.invoice.invoiceNumber} paid`);
    },
    onError: (err) => {
      toastErr(err);
    },
  });

  const handleTakePayment = () => {
    if (!canTakePayment || saleMutation.isPending) return;

    const lines = cart.map(l => ({
      productId: l.productId,
      warehouseId: l.warehouseId,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
    }));

    const body: Record<string, unknown> = { lines, method: paymentMethod, taxCents };

    if (clientMode === 'existing' && existingClientId) {
      body.customerId = existingClientId;
    } else if (clientMode === 'new' && newClient.name.trim()) {
      body.client = {
        name: newClient.name.trim(),
        ...(newClient.email.trim() && { email: newClient.email.trim() }),
        ...(newClient.phone.trim() && { phone: newClient.phone.trim() }),
      };
    }

    saleMutation.mutate(body);
  };

  const resetSale = () => {
    setSuccess(null);
    setCart([]);
    setClientMode('walkin');
    setNewClient({ name: '', email: '', phone: '' });
    setExistingClientId(null);
    setPaymentMethod('CARD');
  };

  const inventoryItems = inventoryData?.data ?? [];
  const customerOptions = (customersData?.data ?? [])
    .filter(p => p.isActive)
    .map(p => ({ value: String(p.id), label: p.name + (p.email ? ` (${p.email})` : '') }));

  return (
    <>
      <PageHeader
        title="Showroom sale"
        subtitle="The client pays at the counter and leaves with the goods and a paid invoice."
      />
      <Grid>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="md">
            <Select
              label="Warehouse"
              data={activeWarehouses.map(w => ({ value: String(w.id), label: `${w.name} (${w.code})` }))}
              value={warehouseId ? String(warehouseId) : ''}
              onChange={handleWarehouseChange}
              disabled={!!success || saleMutation.isPending}
            />
            <TextInput
              placeholder="Search products"
              value={search}
              onChange={e => setSearch(e.currentTarget.value)}
              leftSection={<IconSearch size={16} />}
              disabled={!!success || saleMutation.isPending}
            />
            <Stack gap="xs">
              {inventoryItems
                .filter(b => b.product?.isActive)
                .map(balance => {
                  const cartQty = cartMap.get(balance.productId) ?? 0;
                  const canAdd = balance.availableQty > cartQty;
                  return (
                    <Group key={balance.id} justify="space-between" wrap="nowrap">
                      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" fw={500} truncate title={balance.product!.sku}>{balance.product!.sku}</Text>
                        <Text size="xs" c="dimmed" truncate title={balance.product!.name}>{balance.product!.name}</Text>
                      </Stack>
                      <Badge variant="light">{balance.availableQty}</Badge>
                      <Text size="sm" fw={500}>{money(balance.product!.defaultPriceCents)}</Text>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => addToCart(balance)}
                        disabled={!canAdd || balance.availableQty === 0}
                        aria-label={`Add ${balance.product!.sku}`}
                      >
                        <IconPlus size={16} />
                      </Button>
                    </Group>
                  );
                })}
              {inventoryItems.length === 0 && <Text c="dimmed" size="sm">No products</Text>}
            </Stack>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card withBorder style={{ position: 'sticky', top: '1rem' }}>
            {success ? (
              <Stack gap="md" py="xs">
                {/* The finished figure draws its rule in: the one authored motion. */}
                <div className="spec rule-in" role="status">
                  <div className="spec-label">Paid · {success.invoiceNumber}</div>
                  <div className="spec-value" style={{ fontSize: 44 }}>
                    {money(success.totalCents)}
                    <span className="signal-dot" aria-hidden />
                  </div>
                  <div className="spec-hint">{success.clientName} · goods leave with the client</div>
                </div>
                <Button
                  component="button"
                  type="button"
                  onClick={() => openPdf(`/sales-orders/invoices/${success.invoiceId}/pdf`).catch(toastErr)}
                  fullWidth
                >
                  Open invoice (PDF)
                </Button>
                <Button variant="light" fullWidth onClick={resetSale}>New sale</Button>
              </Stack>
            ) : (
              <Stack gap="md">
                <Text fw={600} size="lg">Sale</Text>

                {cart.length === 0 ? (
                  <Text c="dimmed" size="sm">Tap + on a product to add it.</Text>
                ) : (
                  <Stack gap="xs">
                    {cart.map((line, index) => (
                      <Group key={line.productId} justify="space-between" wrap="nowrap">
                        <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate title={line.name}>{line.name}</Text>
                        <Group gap="xs">
                          <ActionIcon size="sm" onClick={() => decrementQty(index)} disabled={line.quantity <= 1}>
                            <IconMinus size={14} />
                          </ActionIcon>
                          <Text size="sm" w={24} ta="center">{line.quantity}</Text>
                          <ActionIcon size="sm" onClick={() => incrementQty(index)} disabled={line.quantity >= line.availableQty}>
                            <IconPlus size={14} />
                          </ActionIcon>
                        </Group>
                        <Text size="sm" fw={500} w={70} ta="right">
                          {money(line.quantity * line.unitPriceCents)}
                        </Text>
                        <ActionIcon size="sm" color="red" onClick={() => removeLine(index)}>
                          <IconX size={14} />
                        </ActionIcon>
                      </Group>
                    ))}
                  </Stack>
                )}

                <Stack gap="xs" mt="sm">
                  <Text size="sm">Client</Text>
                  <SegmentedControl
                    fullWidth
                    data={[
                      { value: 'walkin', label: 'Walk-in' },
                      { value: 'new', label: 'New client' },
                      { value: 'existing', label: 'Existing client' },
                    ]}
                    value={clientMode}
                    onChange={v => {
                      const m = v as 'walkin' | 'new' | 'existing';
                      setClientMode(m);
                      if (m !== 'new') setNewClient({ name: '', email: '', phone: '' });
                      if (m !== 'existing') setExistingClientId(null);
                    }}
                    disabled={saleMutation.isPending}
                  />
                  {clientMode === 'new' && (
                    <Stack gap="xs">
                      <TextInput
                        placeholder="Name *"
                        value={newClient.name}
                        onChange={e => setNewClient({ ...newClient, name: e.currentTarget.value })}
                        required
                      />
                      <TextInput
                        placeholder="Email"
                        value={newClient.email}
                        onChange={e => setNewClient({ ...newClient, email: e.currentTarget.value })}
                      />
                      <TextInput
                        placeholder="Phone"
                        value={newClient.phone}
                        onChange={e => setNewClient({ ...newClient, phone: e.currentTarget.value })}
                      />
                    </Stack>
                  )}
                  {clientMode === 'existing' && (
                    <Select
                      placeholder="Select client"
                      searchable
                      data={customerOptions}
                      value={existingClientId ? String(existingClientId) : null}
                      onChange={v => setExistingClientId(v ? Number(v) : null)}
                      disabled={saleMutation.isPending}
                    />
                  )}
                </Stack>

                <Stack gap="xs" mt="sm">
                  <Text size="sm">Payment</Text>
                  <SegmentedControl
                    fullWidth
                    data={[
                      { value: 'CARD', label: 'Card' },
                      { value: 'CASH', label: 'Cash' },
                      { value: 'BANK', label: 'Bank transfer' },
                    ]}
                    value={paymentMethod}
                    onChange={v => setPaymentMethod(v as any)}
                    disabled={saleMutation.isPending}
                  />
                </Stack>

                <Group justify="space-between" mt="xs">
                  <Text>Subtotal</Text>
                  <Text>{money(subtotalCents)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text>Sales tax ({taxPercent}% PA)</Text>
                  <Text>{money(taxCents)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text fw={700}>Total</Text>
                  <Text fw={700} size="lg">{money(totalCents)}</Text>
                </Group>

                <Button
                  size="lg"
                  fullWidth
                  onClick={handleTakePayment}
                  disabled={!canTakePayment || saleMutation.isPending}
                  loading={saleMutation.isPending}
                >
                  Record payment · {money(totalCents)}
                </Button>
              </Stack>
            )}
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
