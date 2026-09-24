CREATE TYPE "companyActivityType" AS ENUM('created', 'updated', 'stopped', 'noteAdded', 'noteDeleted', 'contactLinked', 'contactUnlinked', 'dealCreated', 'dealMoved', 'dealStatusChanged');--> statement-breakpoint
ALTER TYPE "dealActivityType" ADD VALUE 'contactChanged';--> statement-breakpoint
ALTER TYPE "dealActivityType" ADD VALUE 'companyChanged';--> statement-breakpoint
CREATE TABLE "CompanyActivity" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"type" "companyActivityType" NOT NULL,
	"payload" jsonb NOT NULL,
	"workspaceId" bigint NOT NULL,
	"companyId" bigint NOT NULL,
	"actorId" bigint
);
--> statement-breakpoint
CREATE TABLE "CompanyNote" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"workspaceId" bigint NOT NULL,
	"companyId" bigint NOT NULL,
	"createdById" bigint
);
--> statement-breakpoint
CREATE INDEX "CompanyActivity_companyId_createdAt_idx" ON "CompanyActivity" ("companyId","createdAt");--> statement-breakpoint
CREATE INDEX "CompanyNote_companyId_createdAt_idx" ON "CompanyNote" ("companyId","createdAt");--> statement-breakpoint
ALTER TABLE "CompanyActivity" ADD CONSTRAINT "CompanyActivity_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "CompanyActivity" ADD CONSTRAINT "CompanyActivity_companyId_Company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "CompanyActivity" ADD CONSTRAINT "CompanyActivity_actorId_User_id_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "CompanyNote" ADD CONSTRAINT "CompanyNote_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "CompanyNote" ADD CONSTRAINT "CompanyNote_companyId_Company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "CompanyNote" ADD CONSTRAINT "CompanyNote_createdById_User_id_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;