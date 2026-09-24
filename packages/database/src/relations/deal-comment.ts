import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const dealCommentRelations = defineRelationsPart(schema, (r) => ({
  dealCommentModel: {
    deal: r.one.dealModel({
      from: r.dealCommentModel.dealId,
      to: r.dealModel.id,
    }),
    author: r.one.userModel({
      from: r.dealCommentModel.authorId,
      to: r.userModel.id,
    }),
    mentionRows: r.many.dealCommentMentionModel({
      from: r.dealCommentModel.id,
      to: r.dealCommentMentionModel.commentId,
    }),
  },
  dealCommentMentionModel: {
    comment: r.one.dealCommentModel({
      from: r.dealCommentMentionModel.commentId,
      to: r.dealCommentModel.id,
    }),
    user: r.one.userModel({
      from: r.dealCommentMentionModel.userId,
      to: r.userModel.id,
    }),
  },
}))
