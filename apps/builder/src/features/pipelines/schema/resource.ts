import {
  dealFieldDefSchema,
  pipelineStopCompanyOn,
} from "@chatbotx.io/database/partials"
import {
  createSelectSchema,
  pipelineModel,
  pipelineStageModel,
} from "@chatbotx.io/database/schema"
import z from "zod"

export const pipelineSettingsResource = z.object({
  stopCompanyOn: pipelineStopCompanyOn,
  defaultCurrency: z.string(),
  // Legacy rows: the service normalises, the boundary defaults as a second guard.
  fieldDefs: z.array(dealFieldDefSchema).default([]),
})

export const pipelineResource = createSelectSchema(pipelineModel, {
  id: z.string(),
  workspaceId: z.string(),
  settings: pipelineSettingsResource,
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
