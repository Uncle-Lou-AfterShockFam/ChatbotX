CREATE TYPE "emailTemplateStatus" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "EmailTemplate" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"status" "emailTemplateStatus" DEFAULT 'active'::"emailTemplateStatus" NOT NULL,
	"workspaceId" bigint NOT NULL,
	"createdById" bigint
);
--> statement-breakpoint
CREATE INDEX "EmailTemplate_workspaceId_status_idx" ON "EmailTemplate" ("workspaceId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "EmailTemplate_workspaceId_name_key" ON "EmailTemplate" ("workspaceId","name");--> statement-breakpoint
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;