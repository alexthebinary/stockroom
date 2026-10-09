-- One inventory account. Inventory Asset (1200) stops being a header and takes
-- over everything posted to its two children, 1201 On Hand and 1202 Inbound,
-- which are then removed. Each line keeps its role (inventoryOnHand /
-- inventoryInbound), so the books check still proves both parts. Entries keep
-- the same debits and credits, so every entry still balances. On a brand-new
-- database there are no accounts yet and this does nothing.
UPDATE "Account" SET "isHeader" = false WHERE "code" = '1200';

UPDATE "JournalLine" SET "accountId" = (SELECT "id" FROM "Account" WHERE "code" = '1200')
WHERE "accountId" IN (SELECT "id" FROM "Account" WHERE "code" IN ('1201', '1202'));

UPDATE "PostingRule" SET "accountId" = (SELECT "id" FROM "Account" WHERE "code" = '1200')
WHERE "accountId" IN (SELECT "id" FROM "Account" WHERE "code" IN ('1201', '1202'));

DELETE FROM "Account" WHERE "code" IN ('1201', '1202');
