CREATE TYPE "pageStatus" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "PageLink" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"token" text NOT NULL,
	"ref" text,
	"expiresAt" timestamp(6) with time zone NOT NULL,
	"firstViewedAt" timestamp(6) with time zone,
	"lastViewedAt" timestamp(6) with time zone,
	"viewCount" integer DEFAULT 0 NOT NULL,
	"workspaceId" bigint NOT NULL,
	"pageId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"contactInboxId" bigint
);
--> statement-breakpoint
CREATE TABLE "Page" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"status" "pageStatus" DEFAULT 'active'::"pageStatus" NOT NULL,
	"linkTtlHours" integer NOT NULL,
	"workspaceId" bigint NOT NULL,
	"createdById" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "PageLink_token_key" ON "PageLink" ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "PageLink_pageId_ref_key" ON "PageLink" ("pageId","ref");--> statement-breakpoint
CREATE INDEX "PageLink_workspaceId_contactId_idx" ON "PageLink" ("workspaceId","contactId");--> statement-breakpoint
CREATE INDEX "PageLink_expiresAt_idx" ON "PageLink" ("expiresAt");--> statement-breakpoint
CREATE INDEX "Page_workspaceId_status_idx" ON "Page" ("workspaceId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "Page_workspaceId_name_key" ON "Page" ("workspaceId","name");--> statement-breakpoint
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_pageId_Page_id_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "PageLink" ADD CONSTRAINT "PageLink_contactInboxId_ContactInbox_id_fkey" FOREIGN KEY ("contactInboxId") REFERENCES "ContactInbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Page" ADD CONSTRAINT "Page_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Page" ADD CONSTRAINT "Page_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;