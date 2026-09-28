-- Weighted average cutover (2026-09-28): LotConsumption.costCents is new.
-- Legacy FIFO rows cost exactly quantity × unitCostCents. Idempotent: touches
-- only rows never priced, and runs on every boot (docker-entrypoint.sh).
UPDATE "LotConsumption" SET "costCents" = "quantity" * "unitCostCents"
WHERE "costCents" = 0 AND "unitCostCents" > 0;
