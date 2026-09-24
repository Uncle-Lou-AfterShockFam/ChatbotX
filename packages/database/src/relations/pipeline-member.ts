import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const pipelineMemberRelations = defineRelationsPart(schema, (r) => ({
  pipelineMemberModel: {
    pipeline: r.one.pipelineModel({
      from: r.pipelineMemberModel.pipelineId,
      to: r.pipelineModel.id,
    }),
    user: r.one.userModel({
      from: r.pipelineMemberModel.userId,
      to: r.userModel.id,
    }),
  },
}))
