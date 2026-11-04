BEGIN;
-- Ownership is additive. No stock pool, balance, movement or journal is rewritten.
ALTER TABLE "InventoryLot" ADD COLUMN "billLineId" integer;
ALTER TABLE "SerialUnit" ADD COLUMN "lotId" integer;
ALTER TABLE "VendorBillLine" ADD COLUMN "inboundCents" integer NOT NULL DEFAULT 0;
ALTER TABLE "VendorCreditLine" ADD COLUMN "received" boolean NOT NULL DEFAULT true;

-- WH-OUT is the physical evidence, including zero-cent returns (which have
-- no inventory journal line). Old code wrote one movement per received line.
-- Match identical quantity/cost lines in id order when requests had duplicates.
UPDATE "VendorCreditLine" SET "received" = false WHERE qty > 0;
DO $$
DECLARE movement record; credit_line_id integer;
BEGIN
 FOR movement IN SELECT * FROM "StockMovement"
   WHERE "counterType"='VENDOR_CREDIT' AND register='WH_OUT' AND "qtyDelta"<0 ORDER BY id
 LOOP
   SELECT id INTO credit_line_id FROM "VendorCreditLine"
   WHERE "creditId"=movement."counterId" AND "itemId"=movement."itemId"
     AND qty=-movement."qtyDelta" AND "costCents"=movement."valueCents" AND NOT received
   ORDER BY id LIMIT 1;
   IF credit_line_id IS NULL THEN
     RAISE EXCEPTION 'Return movement % has no matching credit line; repair historical returns before migrating', movement.id;
   END IF;
   UPDATE "VendorCreditLine" SET received=true WHERE id=credit_line_id;
 END LOOP;
END $$;

-- Expand only the historical physical trail, assigning its units to posted
-- bill lines oldest bill first, independent of the old (latest-bill) sourceId.
-- A lot may need splitting; all its quantity, remaining units and cents survive.
CREATE TEMP TABLE lineage_parts ON COMMIT DROP AS
WITH bill_capacity AS (
 SELECT l.*, l.qty - COALESCE((SELECT sum(c.qty) FROM "VendorCreditLine" c
   WHERE c."billLineId"=l.id AND NOT c.received),0) AS capacity
 FROM "VendorBillLine" l JOIN "VendorBill" b ON b.id=l."billId"
 WHERE b.kind='INVENTORY' AND b.status='POSTED'
), bill_ranges AS (
 SELECT *, sum(capacity) OVER (PARTITION BY "poLineId" ORDER BY "billId",id) AS hi
 FROM bill_capacity
), physical AS (
 SELECT t.id AS "oldId", u.n, t."qtyIn", t."qtyRemaining", t."valueCents",
 row_number() OVER (PARTITION BY t."poLineId" ORDER BY t.id,u.n) AS ordinal, t."poLineId"
 FROM "InventoryLot" t JOIN "VendorBill" b ON b.id=t."sourceId" AND t."sourceType"='BILL' AND b.status='POSTED'
 CROSS JOIN LATERAL generate_series(1,t."qtyIn") u(n)
), grouped AS (
 SELECT p."oldId", b.id AS "billLineId", b."billId", count(*)::int AS qty,
 count(*) FILTER (WHERE p.n > p."qtyIn"-p."qtyRemaining")::int AS remaining,
 max(p."valueCents") AS value,
 count(*) * greatest(b."landedCents"::numeric / greatest(b.qty,1),0) AS weight
 FROM physical p JOIN bill_ranges b ON b."poLineId"=p."poLineId" AND p.ordinal > b.hi-b.capacity AND p.ordinal<=b.hi
 GROUP BY p."oldId",b.id,b."billId",b."landedCents",b.qty
), weighted AS (
 SELECT *, CASE WHEN sum(weight) OVER (PARTITION BY "oldId")=0 THEN qty ELSE weight END AS w FROM grouped
), valued AS (
 SELECT *, round(value * sum(w) OVER (PARTITION BY "oldId" ORDER BY "billId","billLineId") / sum(w) OVER (PARTITION BY "oldId"))::int AS cumulative
 FROM weighted
)
SELECT *, cumulative - coalesce(lag(cumulative) OVER (PARTITION BY "oldId" ORDER BY "billId","billLineId"),0) AS cents,
 row_number() OVER (PARTITION BY "oldId" ORDER BY "billId","billLineId") AS part
FROM valued;

-- Refuse an unrepresentable legacy over-return rather than silently dropping stock.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "InventoryLot" t JOIN "VendorBill" b ON b.id=t."sourceId"
 WHERE t."sourceType"='BILL' AND b.status='POSTED'
 AND t."qtyIn" <> COALESCE((SELECT sum(p.qty) FROM lineage_parts p WHERE p."oldId"=t.id),0))
 THEN RAISE EXCEPTION 'Historical bill quantities cannot cover the lot trail; repair over-returns before migrating'; END IF;
END $$;

INSERT INTO "InventoryLot" ("itemId","warehouseId","poLineId","receiptLineId","sourceType","sourceId","qtyIn","qtyRemaining","valueCents","createdAt","billLineId")
SELECT t."itemId",t."warehouseId",t."poLineId",t."receiptLineId",t."sourceType",p."billId",p.qty,p.remaining,p.cents,t."createdAt",p."billLineId"
FROM lineage_parts p JOIN "InventoryLot" t ON t.id=p."oldId" WHERE p.part>1;
UPDATE "InventoryLot" t SET "sourceId"=p."billId", "billLineId"=p."billLineId", "qtyIn"=p.qty,"qtyRemaining"=p.remaining,"valueCents"=p.cents
FROM lineage_parts p WHERE p."oldId"=t.id AND p.part=1;

-- Bind each extant serial to one unit of the matching physical receipt trail.
WITH units AS (
 SELECT t.id, t."receiptLineId",t."itemId",t."warehouseId",
 row_number() OVER (PARTITION BY t."receiptLineId",t."itemId",t."warehouseId" ORDER BY t.id,u.n) AS n
 FROM "InventoryLot" t CROSS JOIN LATERAL generate_series(1,t."qtyRemaining") u(n)
), serials AS (
 SELECT s.id,s."receiptLineId",s."itemId",s."warehouseId",
 row_number() OVER (PARTITION BY s."receiptLineId",s."itemId",s."warehouseId" ORDER BY s.id) AS n
 FROM "SerialUnit" s WHERE s.state='IN_STOCK'
)
UPDATE "SerialUnit" s SET "lotId"=u.id FROM serials a JOIN units u USING ("receiptLineId","itemId","warehouseId",n) WHERE s.id=a.id;

-- Preserve the existing inbound total, including late freight and allowances.
-- Only outstanding bill units own it; use their residual cost as the weight.
WITH pending AS (
 SELECT l.id,l."poLineId",l."billId",p."inboundCents" AS total,
 l.qty - coalesce((SELECT sum(t."qtyIn") FROM "InventoryLot" t WHERE t."billLineId"=l.id),0)
 - coalesce((SELECT sum(c.qty) FROM "VendorCreditLine" c WHERE c."billLineId"=l.id AND NOT c.received),0) AS qty,
 greatest(0,l."landedCents" - coalesce((SELECT sum(c."amountCents") FROM "VendorCreditLine" c WHERE c."billLineId"=l.id),0)
 - coalesce((SELECT sum(t."valueCents") FROM "InventoryLot" t WHERE t."billLineId"=l.id),0)) AS weight
 FROM "VendorBillLine" l JOIN "VendorBill" b ON b.id=l."billId" JOIN "PurchaseOrderLine" p ON p.id=l."poLineId"
 WHERE b.status='POSTED' AND b.kind='INVENTORY'
), weighted AS (
 SELECT *, CASE WHEN sum(weight) OVER (PARTITION BY "poLineId")=0 THEN qty ELSE weight END AS w FROM pending WHERE qty>0
), valued AS (
 SELECT *, round(total * sum(w) OVER (PARTITION BY "poLineId" ORDER BY "billId",id) / sum(w) OVER (PARTITION BY "poLineId"))::int AS cumulative FROM weighted
), parts AS (
 SELECT *, cumulative-coalesce(lag(cumulative) OVER (PARTITION BY "poLineId" ORDER BY "billId",id),0) AS cents FROM valued
)
UPDATE "VendorBillLine" l SET "inboundCents"=p.cents FROM parts p WHERE l.id=p.id;
CREATE INDEX "InventoryLot_billLineId_idx" ON "InventoryLot"("billLineId");
CREATE INDEX "SerialUnit_lotId_idx" ON "SerialUnit"("lotId");

COMMIT;
