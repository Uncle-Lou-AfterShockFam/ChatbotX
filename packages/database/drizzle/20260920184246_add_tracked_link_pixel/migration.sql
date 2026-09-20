ALTER TABLE "TrackedLink" ADD COLUMN "kind" text DEFAULT 'link' NOT NULL;--> statement-breakpoint
ALTER TABLE "TrackedLink" ADD COLUMN "firstOpenedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TrackedLink" ADD COLUMN "lastOpenedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TrackedLink" ADD COLUMN "openCount" integer DEFAULT 0 NOT NULL;