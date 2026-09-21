import { hashPassword } from "../src/auth";
import { PrismaClient } from "@prisma/client";
import { CHART_OF_ACCOUNTS, JOURNAL_TEMPLATES } from "../src/accounts";

const prisma = new PrismaClient();

/** Money in the seed is written in dollars and converted once, here. */
const usd = (dollars: number) => Math.round(dollars * 100);

const WAREHOUSES = [
  { code: "MAIN", name: "Newark Robotics Depot", address: "120 Dockside Ave, Newark, NJ", notes: "Primary fulfilment and outbound" },
  { code: "SEC", name: "Chicago Service Center", address: "8 Canal Street, Chicago, IL", notes: "RMA, repairs and slow movers" },
  { code: "WEST", name: "Long Beach Import Hub", address: "441 Harbor Blvd, Long Beach, CA", notes: "Receives container freight from Shenzhen" },
];

/** Parent -> subcategories, matching the scope's two-level tree. */
const CATEGORY_TREE: Record<string, string[]> = {
  Robotics: ["Quadrupeds", "Humanoids"],
  Aerial: ["Agricultural Drones", "Batteries"],
  Additive: ["3D Printers", "Filament"],
  Parts: ["Manipulators", "Spares"],
};

/** [sku, name, subcategory, brand, costUSD, priceUSD, weight, l, w, h, barcode?] */
const PRODUCTS: [string, string, string, string, number, number, number, number, number, number, string?][] = [
  ["UT-GO2-AIR", "Unitree Go2 AIR quadruped", "Quadrupeds", "Unitree", 1250, 1999, 15, 70, 31, 40],
  ["UT-GO2-PRO", "Unitree Go2 PRO quadruped", "Quadrupeds", "Unitree", 1950, 2800, 15.5, 70, 31, 40],
  ["UT-G1-EDU", "Unitree G1 EDU humanoid (23 DoF)", "Humanoids", "Unitree", 16000, 21500, 35, 69, 45, 128],
  ["UT-DEX3-PAIR", "Unitree Dex3-1 dexterous hand (pair)", "Manipulators", "Unitree", 2400, 3400, 1.2, 28, 16, 12],
  ["BL-X1C-AMS", "Bambu Lab X1-Carbon + AMS combo", "3D Printers", "Bambu Lab", 1150, 1599, 20.4, 49, 49, 52],
  ["BL-PLA-1KG", "Bambu Lab PLA Basic filament — 1kg", "Filament", "Bambu Lab", 14, 24, 1.25, 20, 20, 7],
  ["BL-A1-MINI", "Bambu Lab A1 mini", "3D Printers", "Bambu Lab", 210, 299, 5.5, 35, 35, 38],
  ["XAG-P100-PROP", "XAG P100 Pro propeller set", "Spares", "XAG", 48, 95, 0.9, 62, 18, 6],
  ["XAG-B13960", "XAG B13960S smart flight battery", "Batteries", "XAG", 1400, 1950, 12.8, 42, 26, 18],
  ["XAG-P100-PRO", "XAG P100 Pro agricultural drone", "Agricultural Drones", "XAG", 9800, 13500, 52, 130, 120, 65, "6970003561004"],
];

/** Opening stock: [sku, warehouseCode, qty, unitCostUSD, reorderPoint] */
const OPENING: [string, string, number, number, number][] = [
  ["UT-GO2-AIR", "MAIN", 24, 1235, 8],
  ["UT-GO2-AIR", "SEC", 6, 1260, 4],
  ["UT-GO2-PRO", "MAIN", 18, 1930, 6],
  ["UT-GO2-PRO", "WEST", 5, 1965, 3],
  ["UT-G1-EDU", "MAIN", 7, 15800, 3],
  ["UT-G1-EDU", "SEC", 1, 16200, 2],
  ["UT-DEX3-PAIR", "MAIN", 13, 2380, 4],
  ["BL-X1C-AMS", "MAIN", 2, 1140, 10],
  ["BL-X1C-AMS", "WEST", 34, 1155, 8],
  ["BL-PLA-1KG", "MAIN", 310, 13.6, 60],
  ["BL-PLA-1KG", "SEC", 120, 14.2, 30],
  ["BL-A1-MINI", "WEST", 26, 206, 10],
  ["XAG-P100-PROP", "MAIN", 180, 46.5, 40],
  ["XAG-B13960", "MAIN", 4, 1385, 16],
  ["XAG-B13960", "WEST", 11, 1410, 6],
  ["XAG-P100-PRO", "MAIN", 6, 9700, 3],
  ["XAG-P100-PRO", "SEC", 1, 9850, 2],
];

const CUSTOMERS = [
  {
    name: "Cascadia Robotics Lab",
    email: "research@cascadiarobotics.example",
    phone: "+1 206 555 0142",
    address: "1400 NW Market St, Suite 300\nSeattle, WA 98107",
  },
  {
    name: "Prairie AgWorks",
    email: "dispatch@prairieagworks.example",
    phone: "+1 316 555 0178",
    address: "22 County Road 9\nHutchinson, KS 67501",
  },
  {
    name: "Foundry Makerspace",
    email: "shop@foundrymakerspace.example",
    address: "515 S Flower St, Unit B\nLos Angeles, CA 90071",
  },
];

const VENDORS = [
  { name: "Unitree Robotics", email: "sales@unitree.example" },
  { name: "XAG Co., Ltd", email: "accounts@xag.example" },
  { name: "Bambu Lab", email: "trade@bambulab.example" },
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

  // Four accounts, one per role, so the demo can actually show what the roles
  // do rather than describing them. Passwords are seed-only and obvious by
  // design; SEED_PASSWORD overrides them for anything hosted.
  const seedPassword = process.env.SEED_PASSWORD ?? "stockroom";
  for (const u of [
    { email: "admin@user.com", name: "Avery Admin", role: "ADMIN" },
    { email: "demo@user.com", name: "Demo User", role: "ADMIN" },
    { email: "warehouse@user.com", name: "Wes Warehouse", role: "WAREHOUSE" },
    { email: "finance@user.com", name: "Fran Finance", role: "FINANCE" },
    { email: "viewer@user.com", name: "Val Viewer", role: "VIEWER" },
  ]) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash: hashPassword(seedPassword) },
    });
  }

  // One entry for the whole opening position: Dr Inventory, Cr Opening Balance
  // Equity. NOT Inventory Gain — stock that existed before the books did is not
  // revenue, and booking it as income overstates the first period by the entire
  // opening position and shows sales with no cost against them.
  const inventory = await prisma.account.findUniqueOrThrow({ where: { code: "1200" } });
  const openingEquity = await prisma.account.findUniqueOrThrow({ where: { code: "3000" } });
  await prisma.journalEntry.create({
    data: {
      entryNumber: `JE-${String(++entryNo).padStart(6, "0")}`,
      transactionType: "OPENING_BALANCE",
      memo: "Opening inventory position (seed)",
      status: "POSTED",
      postedAt: new Date(),
      // The seed writes entries directly rather than through createEntry, so
      // it has to set this itself. Leaving it to the column default wrote
      // POSTED entries with the delete guard switched off — the exact hole
      // the 2026-09-14 backfill had to close on the live database.
      hasBeenPosted: true,
      referenceType: "OPENING_BALANCE",
      actor: "seed@demo",
      lines: {
        create: [
          { accountId: inventory.id, debitCents: openingValueCents },
          { accountId: openingEquity.id, creditCents: openingValueCents },
        ],
      },
    },
  });

  // --- A sales order sitting unpacked and uninvoiced ------------------------
  const go2AirId = products.get("UT-GO2-AIR")!;
  const dex3Id = products.get("UT-DEX3-PAIR")!;
  const main = warehouses.get("MAIN")!;
  const west = warehouses.get("WEST")!;

  const draftLines = [
    { productId: go2AirId, warehouseId: main, quantity: 3, unitPriceCents: usd(1999) },
    { productId: dex3Id, warehouseId: main, quantity: 2, unitPriceCents: usd(3400) },
  ];
  const draftSubtotal = draftLines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  await prisma.salesOrder.create({
    data: {
      orderNumber: "SO-001001",
      customerId: customers.get("Cascadia Robotics Lab")!,
      customerName: "Cascadia Robotics Lab",
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
  const propId = products.get("XAG-P100-PROP")!;
  const batteryId = products.get("XAG-B13960")!;
  const packedLines = [
    { productId: propId, warehouseId: main, quantity: 24, unitPriceCents: usd(95) },
    { productId: batteryId, warehouseId: main, quantity: 2, unitPriceCents: usd(1950) },
  ];
  const packedSubtotal = packedLines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const packedTax = Math.round(packedSubtotal * 0.08);
  const packedTotal = packedSubtotal + packedTax;

  const packed = await prisma.salesOrder.create({
    data: {
      orderNumber: "SO-001002",
      customerId: customers.get("Prairie AgWorks")!,
      customerName: "Prairie AgWorks",
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
      // The seed writes entries directly rather than through createEntry, so
      // it has to set this itself. Leaving it to the column default wrote
      // POSTED entries with the delete guard switched off — the exact hole
      // the 2026-09-14 backfill had to close on the live database.
      hasBeenPosted: true,
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
      // The seed writes entries directly rather than through createEntry, so
      // it has to set this itself. Leaving it to the column default wrote
      // POSTED entries with the delete guard switched off — the exact hole
      // the 2026-09-14 backfill had to close on the live database.
      hasBeenPosted: true,
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
  const g1Id = products.get("UT-G1-EDU")!;
  const savedLines = [{ productId: g1Id, warehouseId: main, quantity: 4, unitCostCents: usd(15800) }];
  const savedSubtotal = savedLines.reduce((s, l) => s + l.unitCostCents * l.quantity, 0);
  const savedPo = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-002001",
      vendorId: vendors.get("Unitree Robotics")!,
      supplierName: "Unitree Robotics",
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

  const restockBatteryId = products.get("XAG-B13960")!;
  const p100Id = products.get("XAG-P100-PRO")!;
  const postedLines = [
    { productId: restockBatteryId, warehouseId: main, quantity: 24, unitCostCents: usd(1380) },
    { productId: p100Id, warehouseId: west, quantity: 6, unitCostCents: usd(9650) },
  ];
  const postedSubtotal = postedLines.reduce((s, l) => s + l.unitCostCents * l.quantity, 0);
  const postedPo = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-002002",
      vendorId: vendors.get("XAG Co., Ltd")!,
      supplierName: "XAG Co., Ltd",
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
      // The seed writes entries directly rather than through createEntry, so
      // it has to set this itself. Leaving it to the column default wrote
      // POSTED entries with the delete guard switched off — the exact hole
      // the 2026-09-14 backfill had to close on the live database.
      hasBeenPosted: true,
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
      productId: products.get("BL-X1C-AMS")!,
      fromWarehouseId: west,
      toWarehouseId: main,
      quantity: 12,
      status: "DRAFT",
      notes: "Newark is down to 2 X1-Carbons; Long Beach took the last container",
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
