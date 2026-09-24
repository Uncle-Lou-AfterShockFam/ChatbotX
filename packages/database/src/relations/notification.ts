import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const notificationRelations = defineRelationsPart(schema, (r) => ({
  notificationModel: {
    user: r.one.userModel({
      from: r.notificationModel.userId,
      to: r.userModel.id,
    }),
    deal: r.one.dealModel({
      from: r.notificationModel.dealId,
      to: r.dealModel.id,
    }),
    task: r.one.dealTaskModel({
      from: r.notificationModel.taskId,
      to: r.dealTaskModel.id,
    }),
    comment: r.one.dealCommentModel({
      from: r.notificationModel.commentId,
      to: r.dealCommentModel.id,
    }),
  },
}))
