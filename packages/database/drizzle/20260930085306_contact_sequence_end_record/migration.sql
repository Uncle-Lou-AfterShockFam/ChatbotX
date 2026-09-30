ALTER TABLE "ContactOnSequence" ADD COLUMN "endedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "ContactOnSequence" ADD COLUMN "endReason" text;--> statement-breakpoint
ALTER TABLE "ContactOnSequence" ADD COLUMN "replyState" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "ContactOnSequence" ADD COLUMN "repliedAt" timestamp(6) with time zone;