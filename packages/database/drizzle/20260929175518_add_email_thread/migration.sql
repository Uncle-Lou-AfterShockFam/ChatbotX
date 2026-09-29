CREATE TABLE "EmailThread" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"subject" text NOT NULL,
	"keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"workspaceId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"sequenceId" bigint NOT NULL,
	"lineInboxId" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "EmailThread_workspaceId_contactId_sequenceId_key" ON "EmailThread" ("workspaceId","contactId","sequenceId");--> statement-breakpoint
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_sequenceId_Sequence_id_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_lineInboxId_Inbox_id_fkey" FOREIGN KEY ("lineInboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;