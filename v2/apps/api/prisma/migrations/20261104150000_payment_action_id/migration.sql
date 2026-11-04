-- Existing payments keep NULL: no backfill or change to historical money.
-- Postgres permits multiple NULLs while enforcing uniqueness for client actions.
ALTER TABLE "Payment" ADD COLUMN "actionId" UUID;
CREATE UNIQUE INDEX "Payment_actionId_key" ON "Payment"("actionId");
