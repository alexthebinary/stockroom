-- Beta feedback #16: a vendor return books no cost of goods sold. Return variance gets its own account (6950);
-- repoint the rule only where it still sits on the old default (5000), so an admin's own choice survives.
INSERT INTO "Account" ("code","name","type","normalSide","isHeader","purpose","isActive")
VALUES ('6950','Vendor Return Variance','EXPENSE','DEBIT',false,'Difference between a vendor credit and the cost of the units sent back (not cost of goods sold)',true)
ON CONFLICT ("code") DO NOTHING;
UPDATE "PostingRule" SET "accountId" = (SELECT "id" FROM "Account" WHERE "code"='6950')
WHERE "role"='returnVariance' AND "accountId" = (SELECT "id" FROM "Account" WHERE "code"='5000');
