import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ok, sampleCompany, testDb, expectBooksSound } from "./helpers";
import { deliver } from "./scan";

type Company = Awaited<ReturnType<typeof sampleCompany>>;
async function order(c: Company, qty: number, serial = false) {
  return ok(await c.admin.post('/api/purchase-orders', { vendorId: c.ids.supplier, warehouseId: c.ids.warehouse, lines: [{ itemId: serial ? c.ids.robot : c.ids.widget, qtyOrdered: qty, unitCostCents: 10000 }] })).body;
}
async function bill(c: Company, po: any, qty: number, cents = 10000, discountCents = 0) {
  const draft = ok(await c.accountant.post('/api/bills', { poId: po.id })).body;
  const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: `INV-${draft.id}`, lines: [{ id: (await testDb().vendorBillLine.findFirstOrThrow({where:{billId:draft.id}})).id, qty, unitCostCents: cents, discountCents }] })).body;
  return ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version })).body;
}
async function arrive(c: Company, po: any, qty: number, serials?: string[]) {
  const scans = serials ? serials.map(serial => ({ itemId: c.ids.robot, serial })) : [{ itemId: c.ids.widget, qty }];
  ok((await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, scans)).submitted);
}
function credit(c: Company, b: any, kind: string, lines: any[]) {
  return c.accountant.post(`/api/bills/${b.id}/credits`, { kind, lines: lines.map(l => ({ billLineId: b.lines[0].id, ...l })) });
}

async function runLegacyBackfill() {
  const connection = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await connection.connect();
  try {
    await connection.query('ALTER TABLE "InventoryLot" DROP COLUMN "billLineId"; ALTER TABLE "SerialUnit" DROP COLUMN "lotId"; ALTER TABLE "VendorBillLine" DROP COLUMN "inboundCents"; ALTER TABLE "VendorCreditLine" DROP COLUMN "received";');
    await connection.query(readFileSync(new URL('../prisma/migrations/20261104153500_bill_line_lineage/migration.sql', import.meta.url), 'utf8'));
  } finally { await connection.end(); }
}

describe('bill line lineage', () => {
  it('#4 two partial bills own their receipt units; void unlands only the first', async () => {
    const c = await sampleCompany(); const po = await order(c, 2);
    const a = await bill(c, po, 1); const b = await bill(c, po, 1, 20000);
    await arrive(c, po, 2);
    const lots = await testDb().inventoryLot.findMany({ orderBy: { id: 'asc' } });
    expect(lots.map(l => [l.sourceId, l.qtyIn, l.valueCents])).toEqual([[a.id, 1, 10000], [b.id, 1, 20000]]);
    await expectBooksSound();
    ok(await c.accountant.post(`/api/bills/${a.id}/void`));
    expect(await testDb().purchaseOrderLine.findUniqueOrThrow({ where: { id: po.lines[0].id } })).toMatchObject({ qtyLanded: 1, qtyHeld: 1, inboundCents: 0 });
    await expectBooksSound();
  });
  it('#9 discounts are cumulative, including duplicate request lines and concurrent requests', async () => {
    const c = await sampleCompany(); const po = await order(c, 1); const b = await bill(c, po, 1); await arrive(c, po, 1);
    expect((await credit(c,b,'PRICE_ALLOWANCE',[{qty:0,amountCents:6000},{qty:0,amountCents:6000}])).status).toBe(400);
    const results = await Promise.all([credit(c,b,'PRICE_ALLOWANCE',[{qty:0,amountCents:8000}]),credit(c,b,'PRICE_ALLOWANCE',[{qty:0,amountCents:8000}])]);
    expect(results.map(r => r.status).sort()).toEqual([200,400]);
    await expectBooksSound();
  });
  it('#10 allowance uses the two billed units, not the ten ordered', async () => {
    const c = await sampleCompany(); const po = await order(c,10); const b = await bill(c,po,2); await arrive(c,po,2);
    ok(await credit(c,b,'PRICE_ALLOWANCE',[{qty:0,amountCents:2000}]));
    expect(await testDb().purchaseOrderLine.findUniqueOrThrow({where:{id:po.lines[0].id}})).toMatchObject({inboundCents:0});
    expect(await testDb().costPool.findUniqueOrThrow({where:{itemId:c.ids.widget}})).toMatchObject({valueCents:18000});
    await expectBooksSound();
  });
  it('#11 returns cannot borrow units from another bill or return the same units twice', async () => {
    const c = await sampleCompany(); const po = await order(c,3); const a = await bill(c,po,1); await bill(c,po,2); await arrive(c,po,3);
    expect((await credit(c,a,'RETURN',[{qty:2}])).status).toBe(400);
    ok(await credit(c,a,'RETURN',[{qty:1}]));
    expect((await credit(c,a,'RETURN',[{qty:1}])).status).toBe(400);
    await expectBooksSound();
  });
  it('#12 serial must belong to the credited bill and consumes its exact lot', async () => {
    const c = await sampleCompany(); const po = await order(c,2,true); const a = await bill(c,po,1); const b = await bill(c,po,1);
    await arrive(c,po,2,['A','B']);
    expect((await credit(c,a,'RETURN',[{qty:1,serials:['B']}])).status).toBe(400);
    const other = await order(c,1,true); await bill(c,other,1); await arrive(c,other,1,['OTHER']);
    expect((await credit(c,a,'RETURN',[{qty:1,serials:['OTHER']}])).status).toBe(400);
    ok(await credit(c,b,'RETURN',[{qty:1,serials:['B']}]));
    const lots = await testDb().inventoryLot.findMany({where:{poLineId:po.lines[0].id},orderBy:{id:'asc'}});
    expect(lots.map(l=>[l.sourceId,l.qtyRemaining])).toEqual([[a.id,1],[b.id,0]]);
    await expectBooksSound();
  });
  it('#17 three individually returned units clear the one-cent line exactly', async () => {
    const c = await sampleCompany(); const po = await order(c,3); const b = await bill(c,po,3,1,2); await arrive(c,po,3);
    const amounts = [];
    for(let i=0;i<3;i++) { amounts.push(ok(await credit(c,b,'RETURN',[{qty:1}])).body.totalCents); await expectBooksSound(); }
    expect(amounts.reduce((a,b)=>a+b,0)).toBe(1);
  });
  it('backfills pre-existing pooled receipt lots oldest bill first without changing books', async () => {
    const c = await sampleCompany(); const po = await order(c, 2, true);
    const a = await bill(c, po, 1); const b = await bill(c, po, 1, 20000);
    await arrive(c, po, 2, ['LEGACY-A', 'LEGACY-B']);
    const db = testDb();
    const lots = await db.inventoryLot.findMany({ orderBy: { id: 'asc' } });
    // Recreate the old receive implementation's one pooled lot, latest bill source.
    await db.inventoryLot.delete({ where: { id: lots[1]!.id } });
    await db.inventoryLot.update({ where: { id: lots[0]!.id }, data: { sourceId: b.id, qtyIn: 2, qtyRemaining: 2, valueCents: 30000 } });
    await runLegacyBackfill();
    const migrated = await db.inventoryLot.findMany({ orderBy: { id: 'asc' } });
    expect(migrated.map(l => [l.billLineId,l.sourceId,l.qtyIn,l.qtyRemaining,l.valueCents])).toEqual([[a.lines[0].id,a.id,1,1,10000],[b.lines[0].id,b.id,1,1,20000]]);
    expect((await db.serialUnit.findMany({ orderBy: { id: 'asc' } })).map(s => s.lotId)).toEqual(migrated.map(l=>l.id));
    await expectBooksSound();
    ok(await c.accountant.post(`/api/bills/${a.id}/void`));
    await expectBooksSound();
  });
  it('#10 only the credited bill owns its inbound discount and later receipt value', async () => {
    const c = await sampleCompany(); const po = await order(c, 4);
    const a = await bill(c, po, 2); const b = await bill(c, po, 2, 20000);
    await arrive(c,po,1);
    ok(await credit(c,a,'PRICE_ALLOWANCE',[{qty:0,amountCents:2000}]));
    await expectBooksSound();
    await arrive(c,po,3);
    expect((await testDb().inventoryLot.findMany({orderBy:{id:'asc'}})).map(l=>[l.sourceId,l.valueCents])).toEqual([[a.id,10000],[a.id,9000],[b.id,40000]]);
    await expectBooksSound();
  });
  it('#11 inbound returns are capped to the selected bill line and leave other bills intact', async () => {
    const c = await sampleCompany(); const po = await order(c,3);
    const a = await bill(c,po,1); const b = await bill(c,po,2,20000);
    expect((await credit(c,a,'RETURN',[{qty:2,received:false}])).status).toBe(400);
    ok(await credit(c,a,'RETURN',[{qty:1,received:false}]));
    expect((await credit(c,a,'RETURN',[{qty:1,received:false}])).status).toBe(400);
    await expectBooksSound();
    await arrive(c,po,2);
    expect(await testDb().inventoryLot.findMany()).toMatchObject([{sourceId:b.id,qtyIn:2,valueCents:40000}]);
    await expectBooksSound();
  });

  it('freight before partial bills follows all ordered units as their bills post', async () => {
    const c = await sampleCompany(); const po = await order(c,4);
    const a = await bill(c,po,2);
    const freight = ok(await c.accountant.post('/api/freight-bills',{kind:'FREIGHT_IN', vendorId:c.ids.carrier, vendorInvoiceNumber:'FREIGHT', amountCents:4000,targetPoIds:[po.id]})).body;
    ok(await c.accountant.post(`/api/bills/${freight.id}/post`,{version:freight.version}));
    await arrive(c,po,4);
    const b = await bill(c,po,2,20000);
    expect((await testDb().inventoryLot.findMany({orderBy:{id:'asc'}})).map(l=>[l.sourceId,l.qtyIn,l.valueCents])).toEqual([[a.id,2,22000],[b.id,2,42000]]);
    expect(await testDb().purchaseOrderLine.findUniqueOrThrow({where:{id:po.lines[0].id}})).toMatchObject({inboundCents:0});
    await expectBooksSound();
    ok(await c.accountant.post(`/api/bills/${freight.id}/void`));
    await expectBooksSound();
  });
  it('#12 a serial return consumes its own later receipt lot even within one bill', async () => {
    const c = await sampleCompany(); const po = await order(c,2,true); const b = await bill(c,po,2);
    await arrive(c,po,1,['FIRST']); await arrive(c,po,1,['SECOND']);
    ok(await credit(c,b,'RETURN',[{qty:1,serials:['SECOND']}]));
    expect((await testDb().inventoryLot.findMany({orderBy:{id:'asc'}})).map(l=>l.qtyRemaining)).toEqual([1,0]);
    await expectBooksSound();
  });

  it('backfills outstanding bills with pre-existing allowances and inbound returns; later receipts keep books sound', async () => {
    const c = await sampleCompany(); const po = await order(c,5);
    const a = await bill(c,po,2); const b = await bill(c,po,3,20000);
    await arrive(c,po,1);
    ok(await credit(c,a,'PRICE_ALLOWANCE',[{qty:0,amountCents:2000}]));
    const returned = ok(await credit(c,b,'RETURN',[{qty:1,received:false}])).body;
    await expectBooksSound();
    await runLegacyBackfill();
    expect(await testDb().vendorCreditLine.findFirstOrThrow({where:{creditId:returned.id}})).toMatchObject({received:false});
    const lines = await testDb().vendorBillLine.findMany({where:{billId:{in:[a.id,b.id]}}});
    expect(lines.reduce((n,l)=>n+l.inboundCents,0)).toBe(49000);
    await expectBooksSound();
    await arrive(c,po,3);
    expect(await testDb().purchaseOrderLine.findUniqueOrThrow({where:{id:po.lines[0].id}})).toMatchObject({inboundCents:0,qtyLanded:4});
    await expectBooksSound();
  });

  it('#11 duplicate inbound return lines each use the remaining value', async () => {
    const c = await sampleCompany(); const po = await order(c,2); const b = await bill(c,po,2);
    ok(await credit(c,b,'RETURN',[{qty:1,received:false},{qty:1,received:false}]));
    expect(await testDb().purchaseOrderLine.findUniqueOrThrow({where:{id:po.lines[0].id}})).toMatchObject({inboundCents:0,qtyBilled:0});
    expect(await testDb().vendorBillLine.findUniqueOrThrow({where:{id:b.lines[0].id}})).toMatchObject({inboundCents:0});
    await expectBooksSound();
  });

  it('backfills zero-cent inbound returns using the physical unit register', async () => {
    const c = await sampleCompany(); const po = await order(c,3); const b = await bill(c,po,3,1,2);
    const returned = ok(await credit(c,b,'RETURN',[{qty:1,received:false}])).body;
    expect(returned.totalCents).toBe(0);
    await runLegacyBackfill();
    expect(await testDb().vendorCreditLine.findFirstOrThrow({where:{creditId:returned.id}})).toMatchObject({received:false});
    await arrive(c,po,2);
    expect((await credit(c,b,'RETURN',[{qty:1,received:false}])).status).toBe(400);
    await expectBooksSound();
  });

  it('backfills received returns without making their units pending again', async () => {
    const c = await sampleCompany(); const po = await order(c,2);
    const a = await bill(c,po,1); const b = await bill(c,po,1,20000);
    await arrive(c,po,1);
    const returned = ok(await credit(c,a,'RETURN',[{qty:1}])).body;
    await runLegacyBackfill();
    expect(await testDb().vendorCreditLine.findFirstOrThrow({where:{creditId:returned.id}})).toMatchObject({received:true});
    await arrive(c,po,1);
    expect((await testDb().inventoryLot.findMany({where:{qtyRemaining:{gt:0}}}))).toMatchObject([{sourceId:b.id,qtyIn:1,valueCents:20000}]);
    await expectBooksSound();
  });

});
