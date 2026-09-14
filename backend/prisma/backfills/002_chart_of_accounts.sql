-- Two accounts added 2026-09-14. The chart is written by the seed, which only
-- runs on an EMPTY database, so an existing deployment never receives a new
-- account and every posting that references one fails with "not in the chart of
-- accounts". Backfills run on every boot, which is what reaches those databases.
--
-- 1210 Inventory In Transit: stock that has left one warehouse and not arrived
-- at the other is owned but cannot be picked, so it is neither warehouse's
-- Inventory. Without it, despatch debits the destination for goods that are
-- still on a truck.
--
-- 3000 Opening Balance Equity: stock that existed before the books did is not
-- revenue. It was being credited to 4900 Inventory Gain, which overstated
-- income by the entire opening position.
--
-- Idempotent: re-running changes nothing.
INSERT INTO "Account" ("code", "name", "accountType", "normalSide", "isActive")
SELECT '1210', 'Inventory In Transit', 'ASSET', 'DEBIT', true
WHERE NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '1210');

INSERT INTO "Account" ("code", "name", "accountType", "normalSide", "isActive")
SELECT '3000', 'Opening Balance Equity', 'EQUITY', 'CREDIT', true
WHERE NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '3000');
