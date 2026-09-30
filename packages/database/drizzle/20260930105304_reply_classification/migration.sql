CREATE TABLE "ReplyClassification" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"class" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"messageId" text,
	"dealId" bigint,
	"workspaceId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"sequenceId" bigint,
	"createdById" bigint
);
--> statement-breakpoint
ALTER TABLE "Sequence" ADD COLUMN "outreachPipelineId" bigint;--> statement-breakpoint
ALTER TABLE "Sequence" ADD COLUMN "outreachStages" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "ReplyClassification_workspaceId_messageId_key" ON "ReplyClassification" ("workspaceId","messageId") WHERE "messageId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ReplyClassification_workspaceId_contactId_createdAt_idx" ON "ReplyClassification" ("workspaceId","contactId","createdAt");--> statement-breakpoint
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_sequenceId_Sequence_id_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_outreachPipelineId_Pipeline_id_fkey" FOREIGN KEY ("outreachPipelineId") REFERENCES "Pipeline"("id") ON DELETE SET NULL ON UPDATE CASCADE;