ALTER TABLE "FormSession" ADD COLUMN "lastFieldKey" text;--> statement-breakpoint
ALTER TABLE "FormSession" ADD COLUMN "abandonEmittedAt" timestamp(6) with time zone;--> statement-breakpoint
CREATE INDEX "FormSession_endedAt_abandonPending_idx" ON "FormSession" ("endedAt") WHERE "status" in ('expired', 'skipped') and "abandonEmittedAt" is null;--> statement-breakpoint
-- s220 A2-3: runs that ended before formAbandoned existed never emit it.
UPDATE "FormSession" SET "abandonEmittedAt" = coalesce("endedAt", now()) WHERE "status" <> 'inProgress';
