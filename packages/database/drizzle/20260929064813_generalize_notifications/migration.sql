ALTER TYPE "notificationType" ADD VALUE 'formSubmitted';--> statement-breakpoint
ALTER TABLE "Notification" ADD COLUMN "formSubmissionId" bigint;--> statement-breakpoint
ALTER TABLE "Notification" ALTER COLUMN "dealId" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Notification_formSubmissionId_userId_key" ON "Notification" ("formSubmissionId","userId") WHERE "formSubmissionId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_formSubmissionId_FormSubmission_id_fkey" FOREIGN KEY ("formSubmissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subject_check" CHECK (("dealId" IS NOT NULL) <> ("formSubmissionId" IS NOT NULL));