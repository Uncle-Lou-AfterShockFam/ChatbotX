CREATE TABLE "DealTaskTemplateDependency" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"templateId" bigint NOT NULL,
	"dependsOnTemplateId" bigint NOT NULL,
	CONSTRAINT "DealTaskTemplateDependency_no_self_check" CHECK ("templateId" <> "dependsOnTemplateId")
);
--> statement-breakpoint
ALTER TABLE "DealTask" ADD COLUMN "startAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "DealTaskTemplate" ADD COLUMN "startInDays" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "DealTaskTemplateDependency_templateId_dependsOnTemplateId_key" ON "DealTaskTemplateDependency" ("templateId","dependsOnTemplateId");--> statement-breakpoint
CREATE INDEX "DealTaskTemplateDependency_dependsOnTemplateId_idx" ON "DealTaskTemplateDependency" ("dependsOnTemplateId");--> statement-breakpoint
ALTER TABLE "DealTaskTemplateDependency" ADD CONSTRAINT "DealTaskTemplateDependency_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTaskTemplateDependency" ADD CONSTRAINT "DealTaskTemplateDependency_templateId_DealTaskTemplate_id_fkey" FOREIGN KEY ("templateId") REFERENCES "DealTaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTaskTemplateDependency" ADD CONSTRAINT "DealTaskTemplateDependency_cXT90obvcKI2_fkey" FOREIGN KEY ("dependsOnTemplateId") REFERENCES "DealTaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_start_not_after_due_check" CHECK ("startAt" IS NULL OR "dueAt" IS NULL OR "startAt" <= "dueAt");