-- Backfill `hasBeenPosted` for entries that were already on the books.
--
-- 20260910202011_has_been_posted added the column, but its INSERT ... SELECT
-- rebuilt the table without it, so every pre-existing row took the `false`
-- default — including rows with status = 'POSTED'. That silently exempted all
-- of them from the delete guard the column exists to enforce: unpost, then
-- DELETE, and a posted entry leaves the ledger with no trace. Reproduced on a
-- copy of dev.db: GL Inventory went 980920 -> 0 against unchanged FIFO layers,
-- while /api/trial-balance still reported `sound: true`.
--
-- `postedAt` is included because unposting clears it while leaving status
-- SAVED, so status alone cannot identify every entry that was ever posted.
-- Idempotent: re-running changes nothing.
UPDATE "JournalEntry"
SET "hasBeenPosted" = true
WHERE "hasBeenPosted" = false
  AND (status = 'POSTED' OR "postedAt" IS NOT NULL);
