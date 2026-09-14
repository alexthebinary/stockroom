-- Remove JE-000007, a journal entry created in error on 2026-09-14.
--
-- It was posted by a liveness probe: a POST to /journal-entries/:id/reverse
-- used to check whether a deployment had landed, against production. It posted
-- a real contra entry against the opening inventory position, taking GL
-- Inventory from 980,920 to 0 until it was unposted. It records no business
-- event and should never have existed.
--
-- The API cannot remove it, and correctly so: `hasBeenPosted` is true, and the
-- guard that refuses to delete anything that was ever on the books is the
-- point. This is operator-authorised cleanup of an artifact, not a correction
-- of a transaction — a real mistake would be reversed, not deleted.
--
-- ⚠️ MATCHED ON THE FULL SIGNATURE, NOT ON THE NUMBER. Backfills run on EVERY
-- boot, including against a database seeded fresh later. Entry numbers are
-- allocated from max(id), so a future database will legitimately have its own
-- JE-000007, and a delete keyed on the number alone would eventually destroy
-- real data. Every field below has to match, and the date bound closes it off
-- entirely.
--
-- JournalLine cascades on delete, so the lines go with it.
--
-- Idempotent, and self-limiting: once applied, it matches nothing forever.
DELETE FROM "JournalEntry"
WHERE "entryNumber"      = 'JE-000007'
  AND "transactionType"  = 'ADJUSTMENT_INCREASE_REVERSAL'
  AND "status"           = 'SAVED'
  AND "referenceType"    = 'SEED'
  AND "referenceId"      IS NULL
  AND "memo"             = 'Reversal of JE-000001'
  AND "entryDate"        < '2026-09-15';
