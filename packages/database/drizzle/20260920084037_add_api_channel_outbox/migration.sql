CREATE TABLE "ApiChannelOutbox" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"contactSourceId" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"leasedAt" timestamp(6) with time zone,
	"leaseExpiresAt" timestamp(6) with time zone,
	"ackedAt" timestamp(6) with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE INDEX "ApiChannelOutbox_inboxId_status_idx" ON "ApiChannelOutbox" ("inboxId","status");--> statement-breakpoint
CREATE INDEX "ApiChannelOutbox_workspaceId_idx" ON "ApiChannelOutbox" ("workspaceId");--> statement-breakpoint
ALTER TABLE "ApiChannelOutbox" ADD CONSTRAINT "ApiChannelOutbox_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ApiChannelOutbox" ADD CONSTRAINT "ApiChannelOutbox_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;