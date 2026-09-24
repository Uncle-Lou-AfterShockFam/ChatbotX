import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { stepTypes } from "./step-action"

export const setDealStatusTargets = z.enum(["won", "lost"])
export type SetDealStatusTarget = z.infer<typeof setDealStatusTargets>

/**
 * Mark the contact's open deal in `pipelineId` won or lost. No open deal in
 * that pipeline = the step logs and does nothing.
 */
export const setDealStatusStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.setDealStatus),
  pipelineId: z.string().optional(),
  status: setDealStatusTargets.default("won"),
})

export type SetDealStatusStepSchema = z.infer<typeof setDealStatusStepSchema>

export const setDealStatusStepDefaultFn = (): SetDealStatusStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.setDealStatus,
  pipelineId: undefined,
  status: "won",
})
