ALTER TYPE "dealActivityType" ADD VALUE 'commented';--> statement-breakpoint
CREATE TABLE "DealCommentMention" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"readAt" timestamp(6) with time zone,
	"workspaceId" bigint NOT NULL,
	"commentId" bigint NOT NULL,
	"dealId" bigint NOT NULL,
	"userId" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DealComment" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb NOT NULL,
	"editedAt" timestamp(6) with time zone,
	"workspaceId" bigint NOT NULL,
	"dealId" bigint NOT NULL,
	"authorId" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "DealCommentMention_commentId_userId_key" ON "DealCommentMention" ("commentId","userId");--> statement-breakpoint
CREATE INDEX "DealCommentMention_userId_readAt_idx" ON "DealCommentMention" ("userId","readAt");--> statement-breakpoint
CREATE INDEX "DealComment_dealId_createdAt_idx" ON "DealComment" ("dealId","createdAt");--> statement-breakpoint
ALTER TABLE "DealCommentMention" ADD CONSTRAINT "DealCommentMention_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealCommentMention" ADD CONSTRAINT "DealCommentMention_commentId_DealComment_id_fkey" FOREIGN KEY ("commentId") REFERENCES "DealComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealCommentMention" ADD CONSTRAINT "DealCommentMention_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealCommentMention" ADD CONSTRAINT "DealCommentMention_userId_User_id_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealComment" ADD CONSTRAINT "DealComment_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealComment" ADD CONSTRAINT "DealComment_dealId_Deal_id_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "DealComment" ADD CONSTRAINT "DealComment_authorId_User_id_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;