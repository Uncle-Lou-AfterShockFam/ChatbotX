CREATE TYPE "emailSenderProvider" AS ENUM('smtp', 'google_oauth');--> statement-breakpoint
CREATE TYPE "emailSenderStatus" AS ENUM('active', 'paused', 'draining', 'disconnected', 'archived');--> statement-breakpoint
CREATE TABLE "EmailSender" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"lineInboxId" bigint NOT NULL,
	"provider" "emailSenderProvider" NOT NULL,
	"address" text NOT NULL,
	"fromName" text NOT NULL,
	"firstName" text NOT NULL,
	"lastName" text NOT NULL,
	"replyTo" text,
	"signature" text,
	"dailyLimit" integer DEFAULT 25 NOT NULL,
	"rampStart" integer,
	"rampPercent" integer,
	"minGapMinutes" integer DEFAULT 10 NOT NULL,
	"status" "emailSenderStatus" DEFAULT 'active'::"emailSenderStatus" NOT NULL,
	"disconnectionReason" text,
	"secret" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "EmailThreadMail" ADD COLUMN "senderId" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "EmailSender_lineInboxId_address_live_key" ON "EmailSender" ("lineInboxId","address") WHERE "status" <> 'archived';--> statement-breakpoint
CREATE INDEX "EmailSender_workspaceId_lineInboxId_idx" ON "EmailSender" ("workspaceId","lineInboxId");--> statement-breakpoint
CREATE INDEX "EmailThreadMail_senderId_createdAt_idx" ON "EmailThreadMail" ("senderId","createdAt");--> statement-breakpoint
ALTER TABLE "EmailSender" ADD CONSTRAINT "EmailSender_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailSender" ADD CONSTRAINT "EmailSender_lineInboxId_Inbox_id_fkey" FOREIGN KEY ("lineInboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailThreadMail" ADD CONSTRAINT "EmailThreadMail_senderId_EmailSender_id_fkey" FOREIGN KEY ("senderId") REFERENCES "EmailSender"("id") ON DELETE SET NULL ON UPDATE CASCADE;