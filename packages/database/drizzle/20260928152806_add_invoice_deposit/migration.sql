CREATE TYPE "invoiceCheckoutKind" AS ENUM('full', 'deposit', 'balance');--> statement-breakpoint
CREATE TYPE "invoiceDepositType" AS ENUM('amount', 'percent');--> statement-breakpoint
ALTER TYPE "invoiceStatus" ADD VALUE 'partiallyPaid' BEFORE 'paid';--> statement-breakpoint
CREATE TABLE "InvoicePayment" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"invoiceId" bigint NOT NULL,
	"kind" "invoiceCheckoutKind" NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"providerPaymentId" text NOT NULL,
	"paidAt" timestamp(6) with time zone NOT NULL,
	"markedAt" timestamp(6) with time zone
);
--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "depositType" "invoiceDepositType";--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "depositValue" text;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "depositAmount" numeric(14,2);--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "amountPaid" numeric(14,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "Invoice" ADD COLUMN "checkoutKind" "invoiceCheckoutKind";--> statement-breakpoint
CREATE UNIQUE INDEX "InvoicePayment_invoiceId_providerPaymentId_key" ON "InvoicePayment" ("invoiceId","providerPaymentId");--> statement-breakpoint
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_Invoice_id_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
-- s216b review: invoices paid before deposits existed took their whole total.
UPDATE "Invoice" SET "amountPaid" = "total" WHERE "status" IN ('paid', 'refunded');
