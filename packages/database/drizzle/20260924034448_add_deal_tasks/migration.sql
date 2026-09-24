CREATE TYPE "dealTaskStatus" AS ENUM('open', 'done');--> statement-breakpoint
ALTER TYPE "dealActivityType" ADD VALUE 'taskCreated';--> statement-breakpoint
ALTER TYPE "dealActivityType" ADD VALUE 'taskCompleted';--> statement-breakpoint
CREATE TABLE "DealDependency" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"taskId" bigint NOT NULL,
	"dependsOnTaskId" bigint NOT NULL,
	CONSTRAINT "DealDependency_no_self_check" CHECK ("taskId" <> "dependsOnTaskId")
);
--> statement-breakpoint
CREATE TABLE "DealTask" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "dealTaskStatus" DEFAULT 'open'::"dealTaskStatus" NOT NULL,
	"dueAt" timestamp(6) with time zone,
	"completedAt" timestamp(6) with time zone,
	"overdueNotifiedAt" timestamp(6) with time zone,
	"workspaceId" bigint NOT NULL,
	"dealId" bigint NOT NULL,
	"templateId" bigint,
	"assigneeId" bigint,
	"createdById" bigint,
	"completedById" bigint
);
--> statement-breakpoint
CREATE TABLE "DealTaskTemplate" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"dueInDays" integer,
	"assignToOwner" boolean DEFAULT false NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"workspaceId" bigint NOT NULL,
	"pipelineId" bigint NOT NULL,
	"stageId" bigint NOT NULL,
	"assigneeId" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "DealDependency_taskId_dependsOnTaskId_key" ON "DealDependency" ("taskId","dependsOnTaskId");--> statement-breakpoint
CREATE INDEX "DealDependency_dependsOnTaskId_idx" ON "DealDependency" ("dependsOnTaskId");--> statement-breakpoint
CREATE INDEX "DealTask_dealId_status_idx" ON "DealTask" ("dealId","status");--> statement-breakpoint
CREATE INDEX "DealTask_assigneeId_idx" ON "DealTask" ("assigneeId");--> statement-breakpoint
CREATE INDEX "DealTask_dueAt_open_unnotified_idx" ON "DealTask" ("dueAt") WHERE "status" = 'open' AND "overdueNotifiedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "DealTask_dealId_templateId_key" ON "DealTask" ("dealId","templateId") WHERE "templateId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "DealTaskTemplate_stageId_order_idx" ON "DealTaskTemplate" ("stageId","order");--> statement-breakpoint
ALTER TABLE "DealDependency" ADD CONSTRAINT "DealDependency_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealDependency" ADD CONSTRAINT "DealDependency_taskId_DealTask_id_fkey" FOREIGN KEY ("taskId") REFERENCES "DealTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealDependency" ADD CONSTRAINT "DealDependency_dependsOnTaskId_DealTask_id_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "DealTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_templateId_DealTaskTemplate_id_fkey" FOREIGN KEY ("templateId") REFERENCES "DealTaskTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_assigneeId_User_id_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_completedById_User_id_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTaskTemplate" ADD CONSTRAINT "DealTaskTemplate_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTaskTemplate" ADD CONSTRAINT "DealTaskTemplate_pipelineId_Pipeline_id_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTaskTemplate" ADD CONSTRAINT "DealTaskTemplate_stageId_PipelineStage_id_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealTaskTemplate" ADD CONSTRAINT "DealTaskTemplate_assigneeId_User_id_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;