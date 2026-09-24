import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import {
  createPipelineRequest,
  removeStageRequest,
  reorderStagesRequest,
  updatePipelineRequest,
  upsertStageRequest,
} from "./action"
import { pipelineStageResource, pipelineWithStagesResource } from "./resource"

const pipelineIdDescription = "Pipeline id. Get it from `pipelines.list`."

export const pipelinePublicResource = pipelineWithStagesResource.omit({
  workspaceId: true,
})
export const pipelineStagePublicResource = pipelineStageResource

export const pipelineIdInput = z.object({
  id: zodBigintAsString().describe(pipelineIdDescription),
})

export const createPipelinePublicRequest = createPipelineRequest

export const updatePipelinePublicRequest = updatePipelineRequest.extend({
  id: zodBigintAsString().describe(pipelineIdDescription),
})

export const upsertStagePublicRequest = upsertStageRequest
  .omit({ stageId: true })
  .extend({
    id: zodBigintAsString().describe(pipelineIdDescription),
    stageId: zodBigintAsString()
      .nullish()
      .describe(
        "Stage id to update; omitted = a new stage is appended at the end of the pipeline.",
      ),
  })

export const reorderStagesPublicRequest = reorderStagesRequest.extend({
  id: zodBigintAsString().describe(pipelineIdDescription),
  stageIds: z
    .array(zodBigintAsString())
    .min(1)
    .max(30)
    .describe("Every stage id of the pipeline in the wanted order."),
})

export const removeStagePublicRequest = removeStageRequest.extend({
  id: zodBigintAsString().describe(pipelineIdDescription),
  stageId: zodBigintAsString().describe(
    "Stage id to remove; get it from `pipelines.get`.",
  ),
  moveDealsTo: zodBigintAsString()
    .nullish()
    .describe(
      "Stage of the same pipeline that receives the deals still in the removed stage; required when any remain.",
    ),
})
