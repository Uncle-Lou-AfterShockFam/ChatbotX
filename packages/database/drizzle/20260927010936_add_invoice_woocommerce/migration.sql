ALTER TYPE "invoiceMethod" ADD VALUE 'woocommerce';--> statement-breakpoint
CREATE TABLE "IntegrationWooCommerce" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"siteSlug" text NOT NULL,
	"siteUrl" text NOT NULL,
	"auth" jsonb NOT NULL,
	"tokenLast4" text NOT NULL,
	"currency" varchar(3) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationWooCommerce_integrationId_key" ON "IntegrationWooCommerce" ("integrationId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationWooCommerce_workspaceId_siteSlug_key" ON "IntegrationWooCommerce" ("workspaceId","siteSlug");--> statement-breakpoint
ALTER TABLE "IntegrationWooCommerce" ADD CONSTRAINT "IntegrationWooCommerce_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationWooCommerce" ADD CONSTRAINT "IntegrationWooCommerce_integrationId_Integration_id_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;