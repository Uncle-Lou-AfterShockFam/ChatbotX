import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const dealRelations = defineRelationsPart(schema, (r) => ({
  dealModel: {
    workspace: r.one.workspaceModel({
      from: r.dealModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    pipeline: r.one.pipelineModel({
      from: r.dealModel.pipelineId,
      to: r.pipelineModel.id,
    }),
    stage: r.one.pipelineStageModel({
      from: r.dealModel.stageId,
      to: r.pipelineStageModel.id,
    }),
    contact: r.one.contactModel({
      from: r.dealModel.contactId,
      to: r.contactModel.id,
    }),
    company: r.one.companyModel({
      from: r.dealModel.companyId,
      to: r.companyModel.id,
    }),
    owner: r.one.userModel({
      from: r.dealModel.ownerId,
      to: r.userModel.id,
    }),
    activities: r.many.dealActivityModel({
      from: r.dealModel.id,
      to: r.dealActivityModel.dealId,
    }),
  },
  dealActivityModel: {
    deal: r.one.dealModel({
      from: r.dealActivityModel.dealId,
      to: r.dealModel.id,
    }),
    actor: r.one.userModel({
      from: r.dealActivityModel.actorId,
      to: r.userModel.id,
    }),
  },
}))
