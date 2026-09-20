CREATE TABLE "TrackedLink" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"token" text NOT NULL,
	"workspaceId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"contactInboxId" bigint,
	"flowId" text,
	"stepId" text,
	"url" text NOT NULL,
	"firstClickedAt" timestamp(6) with time zone,
	"lastClickedAt" timestamp(6) with time zone,
	"clickCount" integer DEFAULT 0 NOT NULL,
	"prefetchCount" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "TrackedLink_token_key" ON "TrackedLink" ("token");--> statement-breakpoint
CREATE INDEX "TrackedLink_workspaceId_contactId_idx" ON "TrackedLink" ("workspaceId","contactId");--> statement-breakpoint
CREATE INDEX "TrackedLink_createdAt_idx" ON "TrackedLink" ("createdAt");--> statement-breakpoint
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_contactInboxId_ContactInbox_id_fkey" FOREIGN KEY ("contactInboxId") REFERENCES "ContactInbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;