CREATE TYPE "emailSuppressionKind" AS ENUM('address', 'domain');--> statement-breakpoint
CREATE TYPE "emailSuppressionReason" AS ENUM('manual', 'unreachable');--> statement-breakpoint
CREATE TABLE "EmailSuppression" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"value" text NOT NULL,
	"kind" "emailSuppressionKind" NOT NULL,
	"reason" "emailSuppressionReason" DEFAULT 'manual'::"emailSuppressionReason" NOT NULL,
	"source" text,
	"workspaceId" bigint NOT NULL,
	"createdById" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "EmailSuppression_workspaceId_value_key" ON "EmailSuppression" ("workspaceId","value");--> statement-breakpoint
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;