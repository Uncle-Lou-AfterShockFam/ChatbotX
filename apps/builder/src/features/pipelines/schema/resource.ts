import {
  dealFieldDefSchema,
  pipelineAccess,
  pipelineAssignOwner,
  pipelineStopCompanyOn,
} from "@chatbotx.io/database/partials"
import {
  createSelectSchema,
  pipelineMemberModel,
  pipelineModel,
  pipelineStageModel,
} from "@chatbotx.io/database/schema"
import z from "zod"

export const pipelineSettingsResource = z.object({
  stopCompanyOn: pipelineStopCompanyOn,
  defaultCurrency: z.string(),
  // Legacy rows: the service normalises, the boundary defaults as a second guard.
  fieldDefs: z.array(dealFieldDefSchema).default([]),
  assignOwner: pipelineAssignOwner.default("none"),
  access: pipelineAccess.default("workspace"),
})

export const pipelineResource = createSelectSchema(pipelineModel, {
  id: z.string(),
  workspaceId: z.string(),
  settings: pipelineSettingsResource,
  roundRobinLastUserId: z.string().nullable(),
})
export type PipelineResource = z.infer<typeof pipelineResource>

export const pipelineStageResource = createSelectSchema(pipelineStageModel, {
  id: z.string(),
  pipelineId: z.string(),
})
export type PipelineStageResource = z.infer<typeof pipelineStageResource>

export const pipelineWithStagesResource = pipelineResource.extend({
  stages: z.array(pipelineStageResource),
})
export type PipelineWithStagesResource = z.infer<
  typeof pipelineWithStagesResource
>

export const pipelineMemberResource = createSelectSchema(pipelineMemberModel, {
  id: z.string(),
  workspaceId: z.string(),
  pipelineId: z.string(),
  userId: z.string(),
})
export type PipelineMemberResource = z.infer<typeof pipelineMemberResource>
