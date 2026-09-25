CREATE TYPE "formStatus" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "Form" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" "formStatus" DEFAULT 'draft'::"formStatus" NOT NULL,
	"definition" jsonb NOT NULL,
	"publishedDefinition" jsonb,
	"definitionVersion" integer DEFAULT 0 NOT NULL,
	"settings" jsonb NOT NULL,
	"publishedAt" timestamp(6) with time zone,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint,
	"createdById" bigint
);
--> statement-breakpoint
CREATE TABLE "FormSubmission" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"definitionVersion" integer NOT NULL,
	"values" jsonb NOT NULL,
	"visibility" jsonb NOT NULL,
	"ipHash" text NOT NULL,
	"userAgent" text,
	"dedupHash" text NOT NULL,
	"workspaceId" bigint NOT NULL,
	"formId" bigint NOT NULL,
	"contactId" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "Form_workspaceId_slug_key" ON "Form" ("workspaceId","slug");--> statement-breakpoint
CREATE INDEX "Form_workspaceId_status_idx" ON "Form" ("workspaceId","status");--> statement-breakpoint
CREATE INDEX "FormSubmission_formId_createdAt_idx" ON "FormSubmission" ("formId","createdAt");--> statement-breakpoint
CREATE INDEX "FormSubmission_formId_dedupHash_createdAt_idx" ON "FormSubmission" ("formId","dedupHash","createdAt");--> statement-breakpoint
CREATE INDEX "FormSubmission_formId_ipHash_createdAt_idx" ON "FormSubmission" ("formId","ipHash","createdAt");--> statement-breakpoint
CREATE INDEX "FormSubmission_workspaceId_contactId_idx" ON "FormSubmission" ("workspaceId","contactId");--> statement-breakpoint
ALTER TABLE "Form" ADD CONSTRAINT "Form_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Form" ADD CONSTRAINT "Form_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Form" ADD CONSTRAINT "Form_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_Form_id_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;