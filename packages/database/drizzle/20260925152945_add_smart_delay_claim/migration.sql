ALTER TYPE "ContactOnSmartDelayStatus" ADD VALUE 'running' BEFORE 'completed';--> statement-breakpoint
ALTER TABLE "ContactOnSmartDelay" ADD COLUMN "claimGeneration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ContactOnSmartDelay" ADD COLUMN "claimedAt" timestamp(6) with time zone;