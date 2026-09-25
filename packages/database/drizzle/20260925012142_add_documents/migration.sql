CREATE TYPE "contactDocumentStatus" AS ENUM('generated', 'sent', 'signed', 'failed');--> statement-breakpoint
CREATE TYPE "documentTemplateStatus" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "ContactDocument" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"ref" text NOT NULL,
	"status" "contactDocumentStatus" DEFAULT 'generated'::"contactDocumentStatus" NOT NULL,
	"path" text,
	"fileSize" integer,
	"token" text NOT NULL,
	"tokenExpiresAt" timestamp(6) with time zone NOT NULL,
	"error" text,
	"documensoEnvelopeId" text,
	"documensoDocumentId" integer,
	"signingUrl" text,
	"signedPath" text,
	"signedAt" timestamp(6) with time zone,
	"workspaceId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"templateId" bigint
);
--> statement-breakpoint
CREATE TABLE "DocumentTemplate" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"bodyHtml" text NOT NULL,
	"status" "documentTemplateStatus" DEFAULT 'active'::"documentTemplateStatus" NOT NULL,
	"workspaceId" bigint NOT NULL,
	"createdById" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ContactDocument_token_key" ON "ContactDocument" ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "ContactDocument_contactId_ref_key" ON "ContactDocument" ("contactId","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "ContactDocument_documensoDocumentId_key" ON "ContactDocument" ("documensoDocumentId");--> statement-breakpoint
CREATE INDEX "ContactDocument_workspaceId_contactId_createdAt_idx" ON "ContactDocument" ("workspaceId","contactId","createdAt");--> statement-breakpoint
CREATE INDEX "DocumentTemplate_workspaceId_status_idx" ON "DocumentTemplate" ("workspaceId","status");--> statement-breakpoint
ALTER TABLE "ContactDocument" ADD CONSTRAINT "ContactDocument_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactDocument" ADD CONSTRAINT "ContactDocument_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactDocument" ADD CONSTRAINT "ContactDocument_templateId_DocumentTemplate_id_fkey" FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;