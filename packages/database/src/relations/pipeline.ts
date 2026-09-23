import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const pipelineRelations = defineRelationsPart(schema, (r) => ({
  pipelineModel: {
    workspace: r.one.workspaceModel({
      from: r.pipelineModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    stages: r.many.pipelineStageModel({
      from: r.pipelineModel.id,
      to: r.pipelineStageModel.pipelineId,
    }),
    deals: r.many.dealModel({
      from: r.pipelineModel.id,
      to: r.dealModel.pipelineId,
    }),
  },
  pipelineStageModel: {
    pipeline: r.one.pipelineModel({
      from: r.pipelineStageModel.pipelineId,
      to: r.pipelineModel.id,
    }),
    deals: r.many.dealModel({
      from: r.pipelineStageModel.id,
      to: r.dealModel.stageId,
    }),
  },
}))
