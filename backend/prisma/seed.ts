import { PrismaClient } from "@prisma/client";
import { CHART_OF_ACCOUNTS, JOURNAL_TEMPLATES } from "../src/accounts";

const prisma = new PrismaClient();

/** Money in the seed is written in dollars and converted once, here. */
const usd = (dollars: number) => Math.round(dollars * 100);

const WAREHOUSES = [
  { code: "MAIN", name: "Main Warehouse", address: "120 Dockside Ave, Newark, NJ", notes: "Primary fulfilment site" },
  { code: "SEC", name: "Secondary Warehouse", address: "8 Canal Street, Chicago, IL", notes: "Overflow and slow movers" },
  { code: "WEST", name: "West Coast Hub", address: "441 Harbor Blvd, Long Beach, CA", notes: "Serves the western states" },
];

/** Parent -> subcategories, matching the scope's two-level tree. */
const CATEGORY_TREE: Record<string, string[]> = {
  Apparel: ["T-Shirts", "Outerwear"],
  Accessories: ["Headwear", "Bags"],
  Homeware: ["Drinkware"],
  Electronics: ["Cables", "Power", "Hubs"],
};

/** [sku, name, subcategory, brand, costUSD, priceUSD, weight, l, w, h, barcode?] */
const PRODUCTS: [string, string, string, string, number, number, number, number, number, number, string?][] = [
  ["APP-TEE-BLK-M", "Heavyweight Tee — Black, M", "T-Shirts", "Northline", 6.5, 24, 0.22, 30, 24, 3],
  ["APP-TEE-WHT-L", "Heavyweight Tee — White, L", "T-Shirts", "Northline", 6.5, 24, 0.24, 30, 24, 3],
  ["APP-HOOD-NVY-L", "Fleece Hoodie — Navy, L", "Outerwear", "Northline", 18, 58, 0.68, 36, 28, 6],
  ["ACC-CAP-001", "Six-Panel Cap — Olive", "Headwear", "Northline", 4.25, 19, 0.11, 22, 20, 12],
  ["ACC-BAG-TOTE", "Canvas Tote Bag — 16oz", "Bags", "Harbourgoods", 5.1, 22, 0.35, 40, 36, 2],
  ["HOM-MUG-350", "Enamel Mug — 350ml", "Drinkware", "Harbourgoods", 3.8, 16, 0.31, 12, 9, 9],
  ["HOM-BTL-750", "Insulated Bottle — 750ml", "Drinkware", "Harbourgoods", 9.4, 34, 0.42, 28, 8, 8],
  ["ELE-CBL-USBC-2M", "USB-C Braided Cable — 2m", "Cables", "Voltwork", 2.15, 12, 0.09, 12, 10, 3],
  ["ELE-PWR-10K", "Power Bank — 10,000mAh", "Power", "Voltwork", 11.5, 39, 0.23, 15, 8, 3],
  ["ELE-HUB-4PT", "4-Port USB-C Hub", "Hubs", "Voltwork", 8.9, 32, 0.14, 14, 9, 3, "5060123456789"],
];

/** Opening stock: [sku, warehouseCode, qty, unitCostUSD, reorderPoint] */
const OPENING: [string, string, number, number, number][] = [
  ["APP-TEE-BLK-M", "MAIN", 240, 6.2, 50],
  ["APP-TEE-BLK-M", "SEC", 60, 6.5, 20],
  ["APP-TEE-WHT-L", "MAIN", 185, 6.4, 50],
  ["APP-TEE-WHT-L", "WEST", 40, 6.6, 20],
  ["APP-HOOD-NVY-L", "MAIN", 74, 17.5, 25],
  ["APP-HOOD-NVY-L", "SEC", 8, 18.2, 15],
  ["ACC-CAP-001", "MAIN", 130, 4.1, 30],
  ["ACC-BAG-TOTE", "MAIN", 6, 5.0, 25],
  ["ACC-BAG-TOTE", "WEST", 95, 5.2, 20],
  ["HOM-MUG-350", "MAIN", 310, 3.65, 60],
  ["HOM-MUG-350", "SEC", 120, 3.8, 30],
  ["HOM-BTL-750", "WEST", 52, 9.2, 20],
  ["ELE-CBL-USBC-2M", "MAIN", 480, 2.05, 100],
  ["ELE-PWR-10K", "MAIN", 9, 11.2, 40],
  ["ELE-PWR-10K", "WEST", 22, 11.4, 15],
  ["ELE-HUB-4PT", "MAIN", 64, 8.7, 25],
  ["ELE-HUB-4PT", "SEC", 3, 9.1, 10],
];

const CUSTOMERS = [
  { name: "Bridge Street Outfitters", email: "buying@bridgestreet.example", phone: "+1 212 555 0134" },
  { name: "Harborline Retail", email: "orders@harborline.example", phone: "+1 312 555 0188" },
  { name: "Cascade General Store", email: "hello@cascadegs.example" },
];

const VENDORS = [
  { name: "Cotton Mills Ltd", email: "sales@cottonmills.example" },
  { name: "Voltwork Manufacturing", email: "accounts@voltwork.example" },
  { name: "Harbourgoods Supply", email: "trade@harbourgoods.example" },
];

const EMPLOYEES = [
  { name: "Dana Reyes", email: "dana@stockroom.example", role: "MANAGER" },
  { name: "Sam Okafor", email: "sam@stockroom.example", role: "MANAGER" },
];

async function reset() {
  // Children before parents.
  await prisma.lotConsumption.deleteMany();
  await prisma.inventoryLot.deleteMany();
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.journalTemplate.deleteMany();
  await prisma.account.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.goodsReceipt.deleteMany();
  await prisma.inventoryMovement.deleteMany();
  await prisma.salesOrderLine.deleteMany();
  await prisma.salesOrder.deleteMany();
  await prisma.purchaseOrderLine.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.stockAdjustment.deleteMany();
  await prisma.stockTransfer.deleteMany();
  await prisma.inventoryBalance.deleteMany();
  await prisma.product.deleteMany();
  await prisma.productCategory.deleteMany();
  await prisma.warehouse.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.employee.deleteMany();
}

async function main() {
  await reset();

  for (const account of CHART_OF_ACCOUNTS) {
    await prisma.account.create({ data: account });
  }
  for (const template of JOURNAL_TEMPLATES) {
    await prisma.journalTemplate.create({ data: template });
  }

  const warehouses = new Map<string, number>();
  for (const w of WAREHOUSES) {
    warehouses.set(w.code, (await prisma.warehouse.create({ data: w })).id);
  }

  const categories = new Map<string, number>();
  for (const [parent, children] of Object.entries(CATEGORY_TREE)) {
    const parentRow = await prisma.productCategory.create({ data: { name: parent } });
    categories.set(parent, parentRow.id);
    for (const child of children) {
      const childRow = await prisma.productCategory.create({
        data: { name: child, parentId: parentRow.id },
      });
      categories.set(child, childRow.id);
    }
  }

  const products = new Map<string, number>();
  for (const [sku, name, subcategory, brand, cost, price, weight, l, w, h, barcode] of PRODUCTS) {
    const row = await prisma.product.create({
      data: {
        sku,
        name,
        brand,
        category: subcategory,
        categoryId: categories.get(subcategory) ?? null,
        defaultCostCents: usd(cost),
        defaultPriceCents: usd(price),
        weight,
        length: l,
        width: w,
        height: h,
        barcode: barcode ?? null,
      },
    });
    products.set(sku, row.id);
  }

  const customers = new Map<string, number>();
  for (const c of CUSTOMERS) {
    customers.set(c.name, (await prisma.customer.create({ data: c })).id);
  }
  const vendors = new Map<string, number>();
  for (const v of VENDORS) {
    vendors.set(v.name, (await prisma.vendor.create({ data: v })).id);
  }
  const employees = new Map<string, number>();
  for (const e of EMPLOYEES) {
    employees.set(e.name, (await prisma.employee.create({ data: e })).id);
  }

  // --- Opening stock -------------------------------------------------------
  // Each opening position is a real cost layer plus a movement plus a balanced
  // journal entry, so the demo starts from a ledger that already ties out.
  let openingValueCents = 0;
  let entryNo = 0;

  for (const [sku, code, qty, unitCost, reorderPoint] of OPENING) {
    const productId = products.get(sku)!;
    const warehouseId = warehouses.get(code)!;
    const unitCostCents = usd(unitCost);
    const valueCents = qty * unitCostCents;
    openingValueCents += valueCents;

    await prisma.inventoryBalance.create({
      data: { productId, warehouseId, onHandQty: qty, reorderPoint },
    });
    await prisma.inventoryLot.create({
      data: {
        productId,
        warehouseId,
        unitCostCents,
        originalQty: qty,
        remainingQty: qty,
        sourceType: "OPENING_BALANCE",
      },
    });
    await prisma.inventoryMovement.create({
      data: {
        productId,
        toWarehouseId: warehouseId,
        quantity: qty,
        movementType: "ADJUSTMENT_IN",
        reason: "Opening balance (seed)",
        referenceType: "SEED",
        totalCostCents: valueCents,
        actor: "seed@demo",
      },
    });
  }

  // One entry for the whole opening position: Dr Inventory, Cr Inventory Gain.
  const inventory = await prisma.account.findUniqueOrThrow({ where: { code: "1200" } });
  const gain = await prisma.account.findUniqueOrThrow({ where: { code: "4900" } });
  await prisma.journalEntry.create({
    data: {
      entryNumber: `JE-${String(++entryNo).padStart(6, "0")}`,
      transactionType: "ADJUSTMENT_INCREASE",
      memo: "Opening inventory position (seed)",
      status: "POSTED",
      postedAt: new Date(),
      referenceType: "SEED",
      actor: "seed@demo",
      lines: {
        create: [
          { accountId: inventory.id, debitCents: openingValueCents },
          { accountId: gain.id, creditCents: openingValueCents },
        ],
      },
    },
  });

  // --- A sales order sitting unpacked and uninvoiced ------------------------
  const teeId = products.get("APP-TEE-BLK-M")!;
  const capId = products.get("ACC-CAP-001")!;
  const main = warehouses.get("MAIN")!;
  const west = warehouses.get("WEST")!;

  const draftLines = [
    { productId: teeId, warehouseId: main, quantity: 24, unitPriceCents: usd(24) },
    { productId: capId, warehouseId: main, quantity: 12, unitPriceCents: usd(19) },
  ];
  const draftSubtotal = draftLines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  await prisma.salesOrder.create({
    data: {
      orderNumber: "SO-001001",
      customerId: customers.get("Bridge Street Outfitters")!,
      customerName: "Bridge Street Outfitters",
      employeeId: employees.get("Dana Reyes")!,
      readinessStatus: "NOT_PACKED",
      paymentStatus: "AWAITING_PAYMENT",
      subtotalCents: draftSubtotal,
      totalCents: draftSubtotal,
      lines: {
        create: draftLines.map((l) => ({
          ...l,
          lineTotalCents: l.unitPriceCents * l.quantity,
          status: "PENDING",
        })),
      },
    },
  });

  // --- A packed, invoiced and paid order, ready to ship --------------------
  const mugId = products.get("HOM-MUG-350")!;
  const cblId = products.get("ELE-CBL-USBC-2M")!;
  const packedLines = [
    { productId: mugId, warehouseId: main, quantity: 40, unitPriceCents: usd(16) },
    { productId: cblId, warehouseId: main, quantity: 60, unitPriceCents: usd(12) },
  ];
  const packedSubtotal = packedLines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const packedTax = Math.round(packedSubtotal * 0.08);
  const packedTotal = packedSubtotal + packedTax;

  const packed = await prisma.salesOrder.create({
    data: {
      orderNumber: "SO-001002",
      customerId: customers.get("Harborline Retail")!,
      customerName: "Harborline Retail",
      employeeId: employees.get("Sam Okafor")!,
      readinessStatus: "PACKED",
      paymentStatus: "PAID",
      channel: "SHOPIFY",
      subtotalCents: packedSubtotal,
      taxCents: packedTax,
      totalCents: packedTotal,
      lines: {
        create: packedLines.map((l) => ({
          ...l,
          lineTotalCents: l.unitPriceCents * l.quantity,
          status: "RESERVED",
        })),
      },
    },
    include: { lines: true },
  });

  for (const line of packed.lines) {
    await prisma.inventoryBalance.update({
      where: { productId_warehouseId: { productId: line.productId, warehouseId: line.warehouseId } },
      data: { reservedQty: { increment: line.quantity } },
    });
  }

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-000001",
      salesOrderId: packed.id,
      customerId: packed.customerId!,
      subtotalCents: packedSubtotal,
      taxCents: packedTax,
      totalCents: packedTotal,
      status: "POSTED",
    },
  });
  const ar = await prisma.account.findUniqueOrThrow({ where: { code: "1100" } });
  const revenue = await prisma.account.findUniqueOrThrow({ where: { code: "4000" } });
  const bank = await prisma.account.findUniqueOrThrow({ where: { code: "1000" } });

  await prisma.journalEntry.create({
    data: {
      entryNumber: `JE-${String(++entryNo).padStart(6, "0")}`,
      transactionType: "SALES_INVOICE",
      memo: `Invoice ${invoice.invoiceNumber} for ${packed.orderNumber}`,
      status: "POSTED",
      postedAt: new Date(),
      referenceType: "INVOICE",
      referenceId: invoice.id,
      actor: "seed@demo",
      lines: {
        create: [
          { accountId: ar.id, debitCents: packedTotal },
          { accountId: revenue.id, creditCents: packedTotal },
        ],
      },
    },
  });

  const payment = await prisma.payment.create({
    data: {
      paymentNumber: "PAY-000001",
      direction: "RECEIPT",
      amountCents: packedTotal,
      method: "CARD",
      status: "POSTED",
      invoiceId: invoice.id,
      customerId: packed.customerId,
    },
  });
  await prisma.journalEntry.create({
    data: {
      entryNumber: `JE-${String(++entryNo).padStart(6, "0")}`,
      transactionType: "SALES_PAYMENT",
      memo: `Payment ${payment.paymentNumber} against ${invoice.invoiceNumber}`,
      status: "POSTED",
      postedAt: new Date(),
      referenceType: "PAYMENT",
      referenceId: payment.id,
      actor: "seed@demo",
      lines: {
        create: [
          { accountId: bank.id, debitCents: packedTotal },
          { accountId: ar.id, creditCents: packedTotal },
        ],
      },
    },
  });

  // --- A saved PO (incoming stock) and a posted one awaiting delivery ------
  const hoodId = products.get("APP-HOOD-NVY-L")!;
  const savedLines = [{ productId: hoodId, warehouseId: main, quantity: 150, unitCostCents: usd(17.8) }];
  const savedSubtotal = savedLines.reduce((s, l) => s + l.unitCostCents * l.quantity, 0);
  const savedPo = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-002001",
      vendorId: vendors.get("Cotton Mills Ltd")!,
      supplierName: "Cotton Mills Ltd",
      employeeId: employees.get("Dana Reyes")!,
      status: "SAVED",
      subtotalCents: savedSubtotal,
      totalCents: savedSubtotal,
      lines: {
        create: savedLines.map((l) => ({
          ...l,
          lineTotalCents: l.unitCostCents * l.quantity,
          status: "PENDING",
        })),
      },
    },
    include: { lines: true },
  });
  for (const line of savedPo.lines) {
    await prisma.inventoryBalance.update({
      where: { productId_warehouseId: { productId: line.productId, warehouseId: line.warehouseId } },
      data: { incomingQty: { increment: line.quantity } },
    });
  }

  const pwrId = products.get("ELE-PWR-10K")!;
  const hubId = products.get("ELE-HUB-4PT")!;
  const postedLines = [
    { productId: pwrId, warehouseId: main, quantity: 200, unitCostCents: usd(11.35) },
    { productId: hubId, warehouseId: west, quantity: 80, unitCostCents: usd(8.75) },
  ];
  const postedSubtotal = postedLines.reduce((s, l) => s + l.unitCostCents * l.quantity, 0);
  const postedPo = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-002002",
      vendorId: vendors.get("Voltwork Manufacturing")!,
      supplierName: "Voltwork Manufacturing",
      employeeId: employees.get("Sam Okafor")!,
      status: "POSTED",
      subtotalCents: postedSubtotal,
      totalCents: postedSubtotal,
      lines: {
        create: postedLines.map((l) => ({
          ...l,
          lineTotalCents: l.unitCostCents * l.quantity,
          status: "ORDERED",
        })),
      },
    },
    include: { lines: true },
  });
  for (const line of postedPo.lines) {
    await prisma.inventoryBalance.upsert({
      where: { productId_warehouseId: { productId: line.productId, warehouseId: line.warehouseId } },
      create: { productId: line.productId, warehouseId: line.warehouseId, incomingQty: line.quantity },
      update: { incomingQty: { increment: line.quantity } },
    });
  }

  const bill = await prisma.bill.create({
    data: {
      billNumber: "BILL-000001",
      purchaseOrderId: postedPo.id,
      vendorId: postedPo.vendorId!,
      subtotalCents: postedSubtotal,
      totalCents: postedSubtotal,
      status: "POSTED",
    },
  });
  const prepaid = await prisma.account.findUniqueOrThrow({ where: { code: "1250" } });
  const ap = await prisma.account.findUniqueOrThrow({ where: { code: "2000" } });
  await prisma.journalEntry.create({
    data: {
      entryNumber: `JE-${String(++entryNo).padStart(6, "0")}`,
      transactionType: "PURCHASE_BILL",
      memo: `Bill ${bill.billNumber} for ${postedPo.poNumber}`,
      status: "POSTED",
      postedAt: new Date(),
      referenceType: "BILL",
      referenceId: bill.id,
      actor: "seed@demo",
      lines: {
        create: [
          { accountId: prepaid.id, debitCents: postedSubtotal },
          { accountId: ap.id, creditCents: postedSubtotal },
        ],
      },
    },
  });

  // --- A transfer waiting to be started ------------------------------------
  await prisma.stockTransfer.create({
    data: {
      productId: products.get("ACC-BAG-TOTE")!,
      fromWarehouseId: west,
      toWarehouseId: main,
      quantity: 30,
      status: "DRAFT",
      notes: "Rebalance totes toward Main",
    },
  });

  const lines = await prisma.journalLine.findMany();
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);

  console.log("Seed complete:", {
    accounts: await prisma.account.count(),
    journalTemplates: await prisma.journalTemplate.count(),
    warehouses: await prisma.warehouse.count(),
    categories: await prisma.productCategory.count(),
    products: await prisma.product.count(),
    customers: await prisma.customer.count(),
    vendors: await prisma.vendor.count(),
    employees: await prisma.employee.count(),
    balances: await prisma.inventoryBalance.count(),
    costLayers: await prisma.inventoryLot.count(),
    movements: await prisma.inventoryMovement.count(),
    journalEntries: await prisma.journalEntry.count(),
    salesOrders: await prisma.salesOrder.count(),
    purchaseOrders: await prisma.purchaseOrder.count(),
    transfers: await prisma.stockTransfer.count(),
  });
  console.log(
    `Trial balance: debits ${debits} = credits ${credits} -> ${debits === credits ? "BALANCED" : "OUT OF BALANCE"}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
