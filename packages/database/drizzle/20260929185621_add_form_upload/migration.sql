CREATE TABLE "FormUpload" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"uploadId" text NOT NULL,
	"workspaceId" bigint NOT NULL,
	"formId" bigint NOT NULL,
	"submissionId" bigint,
	"fieldKey" text NOT NULL,
	"interactionId" text NOT NULL,
	"path" text NOT NULL,
	"mimeType" text NOT NULL,
	"sizeBytes" integer NOT NULL,
	"fileName" text NOT NULL,
	"ipHash" text NOT NULL,
	"deletingAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "FormUpload_uploadId_key" ON "FormUpload" ("uploadId");--> statement-breakpoint
CREATE UNIQUE INDEX "FormUpload_path_key" ON "FormUpload" ("path");--> statement-breakpoint
CREATE INDEX "FormUpload_cleanup_pending_idx" ON "FormUpload" (coalesce("deletingAt", "createdAt")) WHERE "submissionId" is null;--> statement-breakpoint
CREATE INDEX "FormUpload_formId_ipHash_createdAt_idx" ON "FormUpload" ("formId","ipHash","createdAt");--> statement-breakpoint
CREATE INDEX "FormUpload_submissionId_idx" ON "FormUpload" ("submissionId");--> statement-breakpoint
ALTER TABLE "FormUpload" ADD CONSTRAINT "FormUpload_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormUpload" ADD CONSTRAINT "FormUpload_formId_Form_id_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormUpload" ADD CONSTRAINT "FormUpload_submissionId_FormSubmission_id_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;