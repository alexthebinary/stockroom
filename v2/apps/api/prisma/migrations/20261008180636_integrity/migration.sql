-- Rules the database itself enforces, so no code path — present or future —
-- can write a negative balance, a lopsided line or a duplicate vendor invoice.

ALTER TABLE "StockBalance"
  ADD CONSTRAINT "stock_on_hand_not_negative" CHECK ("onHand" >= 0),
  ADD CONSTRAINT "stock_held_not_negative" CHECK ("held" >= 0),
  ADD CONSTRAINT "stock_reserved_within_on_hand" CHECK ("reserved" >= 0 AND "reserved" <= "onHand");

ALTER TABLE "CostPool"
  ADD CONSTRAINT "pool_qty_not_negative" CHECK ("qty" >= 0),
  ADD CONSTRAINT "pool_value_not_negative" CHECK ("valueCents" >= 0),
  ADD CONSTRAINT "pool_empty_means_no_value" CHECK ("qty" > 0 OR "valueCents" = 0);

ALTER TABLE "InventoryLot"
  ADD CONSTRAINT "lot_remaining_within_in" CHECK ("qtyRemaining" >= 0 AND "qtyRemaining" <= "qtyIn");

ALTER TABLE "JournalLine"
  ADD CONSTRAINT "line_one_sided" CHECK ("side" IN ('DEBIT', 'CREDIT') AND "amountCents" > 0);

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "po_line_quantities" CHECK (
    "qtyOrdered" >= 0 AND "qtyHeld" >= 0 AND "qtyLanded" >= 0 AND "qtyReceived" = "qtyHeld" + "qtyLanded"
  );

ALTER TABLE "ReceiptLine"
  ADD CONSTRAINT "receipt_line_landed_within_qty" CHECK ("landedQty" >= 0 AND "landedQty" <= "qty");

-- A vendor's invoice number can be booked once (voided bills excepted).
CREATE UNIQUE INDEX "bill_vendor_invoice_once"
  ON "VendorBill" ("vendorId", lower("vendorInvoiceNumber"))
  WHERE "status" = 'POSTED' AND "vendorInvoiceNumber" IS NOT NULL;

-- Every entry balances. Checked at COMMIT so an entry can be written line by line.
CREATE FUNCTION journal_entry_balances() RETURNS trigger AS $$
DECLARE
  entry_id integer := COALESCE(NEW."entryId", OLD."entryId");
  net bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN "side" = 'DEBIT' THEN "amountCents" ELSE -"amountCents" END), 0)
    INTO net FROM "JournalLine" WHERE "entryId" = entry_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance (net %)', entry_id, net;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "journal_entry_balances"
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balances();
