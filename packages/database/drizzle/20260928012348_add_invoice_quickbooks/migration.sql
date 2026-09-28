ALTER TYPE "invoiceMethod" ADD VALUE 'quickbooks';--> statement-breakpoint
CREATE TABLE "IntegrationQuickbooks" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"realmId" text NOT NULL,
	"environment" text NOT NULL,
	"companyName" text,
	"homeCurrency" varchar(3) NOT NULL,
	"multicurrency" boolean DEFAULT false NOT NULL,
	"auth" jsonb NOT NULL,
	"tokenVersion" integer DEFAULT 0 NOT NULL,
	"tokenRefreshedAt" timestamp(6) with time zone NOT NULL,
	"tokenRefreshError" text,
	"itemId" text NOT NULL,
	"mirrorEnabled" boolean DEFAULT false NOT NULL,
	"mirrorFrom" timestamp(6) with time zone,
	"changesSince" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "InvoiceMirror" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"invoiceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"externalInvoiceId" text,
	"externalPaymentId" text,
	"syncedStatus" "invoiceStatus",
	"lastError" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "QuickbooksCustomer" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"customerId" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationQuickbooks_workspaceId_key" ON "IntegrationQuickbooks" ("workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationQuickbooks_integrationId_key" ON "IntegrationQuickbooks" ("integrationId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationQuickbooks_realmId_key" ON "IntegrationQuickbooks" ("realmId");--> statement-breakpoint
CREATE UNIQUE INDEX "InvoiceMirror_invoiceId_integrationId_key" ON "InvoiceMirror" ("invoiceId","integrationId");--> statement-breakpoint
CREATE INDEX "InvoiceMirror_integrationId_idx" ON "InvoiceMirror" ("integrationId");--> statement-breakpoint
CREATE UNIQUE INDEX "QuickbooksCustomer_integrationId_contactId_key" ON "QuickbooksCustomer" ("integrationId","contactId");--> statement-breakpoint
ALTER TABLE "IntegrationQuickbooks" ADD CONSTRAINT "IntegrationQuickbooks_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationQuickbooks" ADD CONSTRAINT "IntegrationQuickbooks_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceMirror" ADD CONSTRAINT "InvoiceMirror_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceMirror" ADD CONSTRAINT "InvoiceMirror_invoiceId_Invoice_id_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "InvoiceMirror" ADD CONSTRAINT "InvoiceMirror_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "QuickbooksCustomer" ADD CONSTRAINT "QuickbooksCustomer_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "QuickbooksCustomer" ADD CONSTRAINT "QuickbooksCustomer_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "QuickbooksCustomer" ADD CONSTRAINT "QuickbooksCustomer_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;