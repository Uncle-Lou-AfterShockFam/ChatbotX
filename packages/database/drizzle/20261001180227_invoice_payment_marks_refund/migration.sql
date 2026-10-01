ALTER TABLE "InvoicePayment" ADD COLUMN "marksDoneAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "InvoicePayment" ADD COLUMN "refundedAt" timestamp(6) with time zone;--> statement-breakpoint
-- s235: every claim made before this migration ran to completion or was released; only a
-- claim left by a crash stays open (marksDoneAt null) and becomes re-claimable after the lease.
UPDATE "InvoicePayment" SET "marksDoneAt" = "markedAt" WHERE "markedAt" IS NOT NULL;
