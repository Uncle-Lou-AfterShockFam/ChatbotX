CREATE TABLE "PipelineMember" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"inRotation" boolean DEFAULT true NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"workspaceId" bigint NOT NULL,
	"pipelineId" bigint NOT NULL,
	"userId" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Pipeline" ADD COLUMN "roundRobinLastUserId" bigint;--> statement-breakpoint
CREATE INDEX "Deal_workspaceId_ownerId_idx" ON "Deal" ("workspaceId","ownerId");--> statement-breakpoint
CREATE UNIQUE INDEX "PipelineMember_pipelineId_userId_key" ON "PipelineMember" ("pipelineId","userId");--> statement-breakpoint
CREATE INDEX "PipelineMember_userId_idx" ON "PipelineMember" ("userId");--> statement-breakpoint
ALTER TABLE "PipelineMember" ADD CONSTRAINT "PipelineMember_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "PipelineMember" ADD CONSTRAINT "PipelineMember_pipelineId_Pipeline_id_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "PipelineMember" ADD CONSTRAINT "PipelineMember_userId_User_id_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_roundRobinLastUserId_User_id_fkey" FOREIGN KEY ("roundRobinLastUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;