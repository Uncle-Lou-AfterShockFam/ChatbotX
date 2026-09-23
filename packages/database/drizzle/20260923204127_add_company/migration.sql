CREATE TABLE "Company" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"website" text,
	"phone" text,
	"notes" text,
	"stopOnReply" boolean DEFAULT true NOT NULL,
	"stoppedAt" timestamp(6) with time zone,
	"stopReason" text,
	"stoppedByContactId" bigint,
	"workspaceId" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Contact" ADD COLUMN "companyId" bigint;--> statement-breakpoint
ALTER TABLE "Workspace" ADD COLUMN "companyStopTagName" text;--> statement-breakpoint
CREATE UNIQUE INDEX "Company_workspaceId_name_key" ON "Company" ("workspaceId","name");--> statement-breakpoint
CREATE INDEX "Company_workspaceId_stoppedAt_idx" ON "Company" ("workspaceId","stoppedAt");--> statement-breakpoint
CREATE INDEX "Company_domains_idx" ON "Company" USING gin ("domains");--> statement-breakpoint
CREATE INDEX "idx_contact_workspace_company" ON "Contact" ("workspaceId","companyId");--> statement-breakpoint
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_Company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;