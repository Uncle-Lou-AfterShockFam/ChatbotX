ALTER TYPE "customFieldType" ADD VALUE 'select';--> statement-breakpoint
ALTER TYPE "customFieldType" ADD VALUE 'multiSelect';--> statement-breakpoint
ALTER TABLE "CustomField" ADD COLUMN "options" jsonb;