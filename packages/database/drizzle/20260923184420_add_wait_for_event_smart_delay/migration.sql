ALTER TYPE "ContactOnSmartDelayType" ADD VALUE 'waitForEvent';--> statement-breakpoint
ALTER TABLE "ContactOnSmartDelay" ADD COLUMN "eventNodeId" text;--> statement-breakpoint
ALTER TABLE "ContactOnSmartDelay" ADD COLUMN "eventSpec" jsonb;--> statement-breakpoint
CREATE INDEX "ContactOnSmartDelay_workspaceId_type_status_contactInboxId_idx" ON "ContactOnSmartDelay" ("workspaceId","type","status","contactInboxId");