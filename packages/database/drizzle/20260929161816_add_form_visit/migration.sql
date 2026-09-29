CREATE TABLE "FormVisit" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"formId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"interactionId" text NOT NULL,
	"startedAt" timestamp(6) with time zone NOT NULL,
	"lastActivityAt" timestamp(6) with time zone NOT NULL,
	"abandonAt" timestamp(6) with time zone NOT NULL,
	"submittedAt" timestamp(6) with time zone,
	"abandonEmittedAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "FormVisit_formId_contactId_open_key" ON "FormVisit" ("formId","contactId") WHERE "submittedAt" is null and "abandonEmittedAt" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "FormVisit_formId_contactId_interactionId_key" ON "FormVisit" ("formId","contactId","interactionId");--> statement-breakpoint
CREATE INDEX "FormVisit_abandonAt_open_idx" ON "FormVisit" ("abandonAt") WHERE "submittedAt" is null and "abandonEmittedAt" is null;--> statement-breakpoint
CREATE INDEX "FormVisit_createdAt_idx" ON "FormVisit" ("createdAt");--> statement-breakpoint
CREATE INDEX "FormVisit_contactId_idx" ON "FormVisit" ("contactId");--> statement-breakpoint
ALTER TABLE "FormVisit" ADD CONSTRAINT "FormVisit_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormVisit" ADD CONSTRAINT "FormVisit_formId_Form_id_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormVisit" ADD CONSTRAINT "FormVisit_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;