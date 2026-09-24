import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { stepTypes } from "./step-action"

/**
 * Move the contact's open deal in `pipelineId` to `stageId`. No open deal in
 * that pipeline = the step logs and does nothing. With `targetPipelineId`
 * (s196) the deal moves to ANOTHER pipeline instead: `stageId` is then a
 * stage of the target (empty = its first stage).
 */
export const moveDealStageStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.moveDealStage),
  pipelineId: z.string().optional(),
  stageId: z.string().optional(),
  targetPipelineId: z.string().optional(),
})

export type MoveDealStageStepSchema = z.infer<typeof moveDealStageStepSchema>

export const moveDealStageStepDefaultFn = (): MoveDealStageStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.moveDealStage,
  pipelineId: undefined,
  stageId: undefined,
})
