import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { stepTypes } from "./step-action"

export const completeTaskMatch = z.enum(["template", "title"])

/**
 * Complete every open, unblocked task on the contact's open deal in
 * `pipelineId` that matches: by the stage template it came from, or by exact
 * (case-insensitive) title. A blocked match is skipped and logged.
 */
export const completeTaskStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.completeTask),
  pipelineId: z.string().optional(),
  match: completeTaskMatch.default("template"),
  templateId: z.string().optional(),
  title: z.string().trim().max(200).default(""),
})
export type CompleteTaskStepSchema = z.infer<typeof completeTaskStepSchema>

export const completeTaskStepDefaultFn = (): CompleteTaskStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.completeTask,
  pipelineId: undefined,
  match: "template",
  templateId: undefined,
  title: "",
})
