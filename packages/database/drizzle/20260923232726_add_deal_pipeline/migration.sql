CREATE TYPE "dealActivityType" AS ENUM('created', 'stageMoved', 'valueChanged', 'statusChanged', 'priorityChanged', 'assigned', 'note');--> statement-breakpoint
CREATE TYPE "dealPriority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "dealStatus" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "DealActivity" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"type" "dealActivityType" NOT NULL,
	"payload" jsonb NOT NULL,
	"dealId" bigint NOT NULL,
	"actorId" bigint
);
--> statement-breakpoint
CREATE TABLE "Deal" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"value" numeric(14,2),
	"currency" varchar(3) NOT NULL,
	"status" "dealStatus" DEFAULT 'open'::"dealStatus" NOT NULL,
	"priority" "dealPriority" DEFAULT 'medium'::"dealPriority" NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"dueAt" timestamp(6) with time zone,
	"closedAt" timestamp(6) with time zone,
	"fields" jsonb NOT NULL,
	"workspaceId" bigint NOT NULL,
	"pipelineId" bigint NOT NULL,
	"stageId" bigint NOT NULL,
	"contactId" bigint,
	"companyId" bigint,
	"ownerId" bigint
);
--> statement-breakpoint
CREATE TABLE "Pipeline" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"settings" jsonb NOT NULL,
	"workspaceId" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PipelineStage" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"color" text,
	"probability" integer DEFAULT 0 NOT NULL,
	"isWon" boolean DEFAULT false NOT NULL,
	"isLost" boolean DEFAULT false NOT NULL,
	"pipelineId" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "DealActivity_dealId_createdAt_idx" ON "DealActivity" ("dealId","createdAt");--> statement-breakpoint
CREATE INDEX "Deal_workspaceId_pipelineId_stageId_position_idx" ON "Deal" ("workspaceId","pipelineId","stageId","position");--> statement-breakpoint
CREATE INDEX "Deal_workspaceId_contactId_status_idx" ON "Deal" ("workspaceId","contactId","status");--> statement-breakpoint
CREATE INDEX "Deal_workspaceId_companyId_idx" ON "Deal" ("workspaceId","companyId");--> statement-breakpoint
CREATE UNIQUE INDEX "Pipeline_workspaceId_name_key" ON "Pipeline" ("workspaceId","name");--> statement-breakpoint
CREATE INDEX "Pipeline_workspaceId_order_idx" ON "Pipeline" ("workspaceId","order");--> statement-breakpoint
CREATE INDEX "PipelineStage_pipelineId_order_idx" ON "PipelineStage" ("pipelineId","order");--> statement-breakpoint
ALTER TABLE "DealActivity" ADD CONSTRAINT "DealActivity_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealActivity" ADD CONSTRAINT "DealActivity_actorId_User_id_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_Pipeline_id_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_PipelineStage_id_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_companyId_Company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_User_id_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_Pipeline_id_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;