CREATE TYPE "formChannel" AS ENUM('web', 'chat');--> statement-breakpoint
CREATE TYPE "formSessionStatus" AS ENUM('inProgress', 'completed', 'skipped', 'expired', 'canceled');--> statement-breakpoint
CREATE TABLE "FormSession" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"formId" bigint NOT NULL,
	"contactId" bigint NOT NULL,
	"conversationId" bigint NOT NULL,
	"flowId" bigint NOT NULL,
	"flowVersionId" bigint,
	"nodeId" text NOT NULL,
	"stepId" text NOT NULL,
	"status" "formSessionStatus" DEFAULT 'inProgress'::"formSessionStatus" NOT NULL,
	"endReason" text,
	"definitionVersion" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"profile" jsonb NOT NULL,
	"values" jsonb NOT NULL,
	"asked" jsonb NOT NULL,
	"currentFieldKey" text,
	"askMarker" bigint,
	"challengeId" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer NOT NULL,
	"timeoutMinutes" integer NOT NULL,
	"lastAnsweredMessageId" bigint,
	"expiresAt" timestamp(6) with time zone NOT NULL,
	"endedAt" timestamp(6) with time zone
);
--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD COLUMN "channel" "formChannel" DEFAULT 'web'::"formChannel" NOT NULL;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD COLUMN "identityConflict" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD COLUMN "conversationId" bigint;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD COLUMN "formSessionId" bigint;--> statement-breakpoint
ALTER TABLE "FormSubmission" ALTER COLUMN "ipHash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "FormSubmission" ALTER COLUMN "dedupHash" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "FormSession_contactId_inProgress_key" ON "FormSession" ("contactId") WHERE "status" = 'inProgress';--> statement-breakpoint
CREATE INDEX "FormSession_expiresAt_inProgress_idx" ON "FormSession" ("expiresAt") WHERE "status" = 'inProgress';--> statement-breakpoint
CREATE INDEX "FormSession_workspaceId_formId_idx" ON "FormSession" ("workspaceId","formId");--> statement-breakpoint
CREATE UNIQUE INDEX "FormSubmission_formSessionId_key" ON "FormSubmission" ("formSessionId");--> statement-breakpoint
ALTER TABLE "FormSession" ADD CONSTRAINT "FormSession_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSession" ADD CONSTRAINT "FormSession_formId_Form_id_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSession" ADD CONSTRAINT "FormSession_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSession" ADD CONSTRAINT "FormSession_conversationId_Conversation_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSession" ADD CONSTRAINT "FormSession_flowId_Flow_id_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_conversationId_Conversation_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formSessionId_FormSession_id_fkey" FOREIGN KEY ("formSessionId") REFERENCES "FormSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_web_hashes_check" CHECK ("channel" <> 'web' OR ("ipHash" IS NOT NULL AND "dedupHash" IS NOT NULL));