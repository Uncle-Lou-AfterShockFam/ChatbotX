CREATE TABLE "EmailThreadMail" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"direction" text NOT NULL,
	"messageKey" text,
	"messageId" text,
	"subject" text NOT NULL,
	"parents" text[] DEFAULT '{}'::text[] NOT NULL,
	"workspaceId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"lineInboxId" bigint NOT NULL,
	"sequenceId" bigint,
	"broadcastId" bigint,
	"flowId" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "EmailThreadMail_workspaceId_lineInboxId_messageKey_key" ON "EmailThreadMail" ("workspaceId","lineInboxId","messageKey");--> statement-breakpoint
CREATE UNIQUE INDEX "EmailThreadMail_workspaceId_lineInboxId_messageId_key" ON "EmailThreadMail" ("workspaceId","lineInboxId","messageId");--> statement-breakpoint
CREATE INDEX "EmailThreadMail_contact_line_createdAt_idx" ON "EmailThreadMail" ("workspaceId","contactId","lineInboxId","createdAt" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "EmailThreadMail" ADD CONSTRAINT "EmailThreadMail_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailThreadMail" ADD CONSTRAINT "EmailThreadMail_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailThreadMail" ADD CONSTRAINT "EmailThreadMail_lineInboxId_Inbox_id_fkey" FOREIGN KEY ("lineInboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;