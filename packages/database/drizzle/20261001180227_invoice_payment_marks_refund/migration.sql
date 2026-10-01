ALTER TABLE "InvoicePayment" ADD COLUMN "marksDoneAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "InvoicePayment" ADD COLUMN "refundedAt" timestamp(6) with time zone;--> statement-breakpoint
-- s235: a claim older than the marks lease (10 min) finished or was left by a crash before this
-- deploy: count it done. A younger one may still be in flight while the deploy runs, so it stays
-- open; it is re-run only if Stripe redelivers its event (which it does only when that run failed).
UPDATE "InvoicePayment" SET "marksDoneAt" = "markedAt"
 WHERE "markedAt" IS NOT NULL AND "markedAt" < now() - interval '10 minutes';
