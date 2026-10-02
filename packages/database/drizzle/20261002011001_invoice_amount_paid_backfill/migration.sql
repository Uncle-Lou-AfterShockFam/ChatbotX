-- s237 (2026-10-02): a provider-reported payment (stripeInvoice, woocommerce,
-- quickbooks) left "amountPaid" at 0 since 20260928152806_add_invoice_deposit,
-- whose backfill only covered rows paid before it. Such a payment settles the
-- whole invoice; the Checkout ledger (InvoicePayment rows) is left alone.
UPDATE "Invoice" i SET "amountPaid" = i."total"
 WHERE i."status" IN ('paid', 'refunded')
   AND i."amountPaid" = 0
   AND NOT EXISTS (SELECT 1 FROM "InvoicePayment" p WHERE p."invoiceId" = i."id");
