import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const dealTaskRelations = defineRelationsPart(schema, (r) => ({
  dealTaskModel: {
    deal: r.one.dealModel({
      from: r.dealTaskModel.dealId,
      to: r.dealModel.id,
    }),
    template: r.one.dealTaskTemplateModel({
      from: r.dealTaskModel.templateId,
      to: r.dealTaskTemplateModel.id,
    }),
    assignee: r.one.userModel({
      from: r.dealTaskModel.assigneeId,
      to: r.userModel.id,
    }),
    blockedBy: r.many.dealDependencyModel({
      from: r.dealTaskModel.id,
      to: r.dealDependencyModel.taskId,
    }),
  },
  dealTaskTemplateModel: {
    pipeline: r.one.pipelineModel({
      from: r.dealTaskTemplateModel.pipelineId,
      to: r.pipelineModel.id,
    }),
    stage: r.one.pipelineStageModel({
      from: r.dealTaskTemplateModel.stageId,
      to: r.pipelineStageModel.id,
    }),
  },
  dealDependencyModel: {
    task: r.one.dealTaskModel({
      from: r.dealDependencyModel.taskId,
      to: r.dealTaskModel.id,
    }),
    dependsOn: r.one.dealTaskModel({
      from: r.dealDependencyModel.dependsOnTaskId,
      to: r.dealTaskModel.id,
    }),
  },
}))
