CREATE TYPE "invoiceMethod" AS ENUM('stripeInvoice');--> statement-breakpoint
CREATE TYPE "invoiceStatus" AS ENUM('draft', 'open', 'paid', 'void', 'uncollectible', 'refunded');--> statement-breakpoint
CREATE TABLE "IntegrationStripe" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"auth" jsonb NOT NULL,
	"accountId" text NOT NULL,
	"accountName" text,
	"livemode" boolean NOT NULL,
	"keyLast4" text NOT NULL,
	"webhookEndpointId" text
);
--> statement-breakpoint
CREATE TABLE "StripeCustomer" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"customerId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "InvoiceEvent" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"invoiceId" bigint,
	"providerEventId" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "InvoiceLineItem" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"invoiceId" bigint NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unitAmount" numeric(14,2) NOT NULL,
	"amount" numeric(14,2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Invoice" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"number" integer NOT NULL,
	"status" "invoiceStatus" DEFAULT 'draft'::"invoiceStatus" NOT NULL,
	"method" "invoiceMethod" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"total" numeric(14,2) NOT NULL,
	"memo" text,
	"dueAt" timestamp(6) with time zone,
	"paidAt" timestamp(6) with time zone,
	"voidedAt" timestamp(6) with time zone,
	"sourceKey" text,
	"lastError" text,
	"contactId" bigint NOT NULL,
	"companyId" bigint,
	"dealId" bigint,
	"integrationId" bigint,
	"providerInvoiceId" text,
	"providerCustomerId" text,
	"hostedUrl" text,
	"pdfUrl" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationStripe_workspaceId_key" ON "IntegrationStripe" ("workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationStripe_integrationId_key" ON "IntegrationStripe" ("integrationId");--> statement-breakpoint
CREATE UNIQUE INDEX "StripeCustomer_integrationId_contactId_key" ON "StripeCustomer" ("integrationId","contactId");--> statement-breakpoint
CREATE UNIQUE INDEX "InvoiceEvent_integrationId_providerEventId_key" ON "InvoiceEvent" ("integrationId","providerEventId");--> statement-breakpoint
CREATE INDEX "InvoiceEvent_invoiceId_idx" ON "InvoiceEvent" ("invoiceId");--> statement-breakpoint
CREATE UNIQUE INDEX "InvoiceLineItem_invoiceId_position_key" ON "InvoiceLineItem" ("invoiceId","position");--> statement-breakpoint
CREATE UNIQUE INDEX "Invoice_workspaceId_number_key" ON "Invoice" ("workspaceId","number");--> statement-breakpoint
CREATE UNIQUE INDEX "Invoice_workspaceId_sourceKey_key" ON "Invoice" ("workspaceId","sourceKey");--> statement-breakpoint
CREATE UNIQUE INDEX "Invoice_providerInvoiceId_key" ON "Invoice" ("providerInvoiceId");--> statement-breakpoint
CREATE INDEX "Invoice_workspaceId_createdAt_idx" ON "Invoice" ("workspaceId","createdAt");--> statement-breakpoint
CREATE INDEX "Invoice_workspaceId_contactId_idx" ON "Invoice" ("workspaceId","contactId");--> statement-breakpoint
ALTER TABLE "IntegrationStripe" ADD CONSTRAINT "IntegrationStripe_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationStripe" ADD CONSTRAINT "IntegrationStripe_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "StripeCustomer" ADD CONSTRAINT "StripeCustomer_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "StripeCustomer" ADD CONSTRAINT "StripeCustomer_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "StripeCustomer" ADD CONSTRAINT "StripeCustomer_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_invoiceId_Invoice_id_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_Invoice_id_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_Company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;