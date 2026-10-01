ALTER TABLE "EmailSender" ADD COLUMN "tokenVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "EmailSender" ADD COLUMN "tokenRefreshedAt" timestamp(6) with time zone;