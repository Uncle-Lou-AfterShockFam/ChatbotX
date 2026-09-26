ALTER TYPE "invoiceMethod" ADD VALUE 'stripeCheckout';--> statement-breakpoint
ALTER TABLE "IntegrationStripe" ADD COLUMN "defaultMethod" "invoiceMethod" DEFAULT 'stripeInvoice'::"invoiceMethod" NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationStripe" ADD COLUMN "webhookEventsVersion" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "payToken" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "checkoutSessionId" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "checkoutGeneration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "checkoutMintedAt" timestamp(6) with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "Invoice_payToken_key" ON "Invoice" ("payToken");