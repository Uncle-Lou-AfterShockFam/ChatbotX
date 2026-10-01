CREATE TYPE "integrationApiLineKind" AS ENUM('email');--> statement-breakpoint
ALTER TABLE "IntegrationApi" ADD COLUMN "lineKind" "integrationApiLineKind";--> statement-breakpoint
-- s231b backfill: a line that has ever held a mailbox sender IS an email line
-- (production: the bulktext-email channel). Every other API channel stays
-- null and loses access to the sender feed.
UPDATE "IntegrationApi" SET "lineKind" = 'email' WHERE "inboxId" IN (SELECT DISTINCT "lineInboxId" FROM "EmailSender");
