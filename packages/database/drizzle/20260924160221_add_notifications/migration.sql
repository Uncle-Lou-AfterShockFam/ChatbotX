CREATE TYPE "notificationType" AS ENUM('taskAssigned', 'dealMentioned');--> statement-breakpoint
CREATE TABLE "Notification" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"type" "notificationType" NOT NULL,
	"payload" jsonb NOT NULL,
	"readAt" timestamp(6) with time zone,
	"workspaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"dealId" bigint NOT NULL,
	"taskId" bigint,
	"commentId" bigint
);
--> statement-breakpoint
CREATE INDEX "Notification_userId_workspaceId_readAt_createdAt_idx" ON "Notification" ("userId","workspaceId","readAt","createdAt");--> statement-breakpoint
CREATE INDEX "Notification_dealId_idx" ON "Notification" ("dealId");--> statement-breakpoint
CREATE UNIQUE INDEX "Notification_commentId_userId_key" ON "Notification" ("commentId","userId") WHERE "commentId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_User_id_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_taskId_DealTask_id_fkey" FOREIGN KEY ("taskId") REFERENCES "DealTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_commentId_DealComment_id_fkey" FOREIGN KEY ("commentId") REFERENCES "DealComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;