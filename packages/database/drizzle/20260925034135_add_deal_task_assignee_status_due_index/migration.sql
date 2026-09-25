DROP INDEX "DealTask_assigneeId_idx";--> statement-breakpoint
CREATE INDEX "DealTask_assigneeId_status_dueAt_idx" ON "DealTask" ("assigneeId","status","dueAt");