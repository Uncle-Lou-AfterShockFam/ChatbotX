import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { stepTypes } from "./step-action"

export const MAX_TASK_TITLE_LENGTH = 200
export const MAX_TASK_DESCRIPTION_LENGTH = 2000
export const MAX_TASK_DUE_IN_DAYS = 365

/** Mirrors `dealTaskAssignTo` in `@chatbotx.io/database/partials` (database depends on this package, not the reverse). */
export const createTaskAssignTo = z.enum(["none", "dealOwner", "user"])

/**
 * Add a task to the contact's OPEN deal in `pipelineId` (none = the step
 * logs and does nothing). `title` may carry `{{variable}}` tokens. Due date =
 * run time + `dueInDays`; null = no due date. Start = run time +
 * `startInDays` (null = none; after the due date = clamped to the due date
 * by the worker; a schema refinement here would make the public OpenAPI
 * document non-deterministic).
 */
export const createTaskStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.createTask),
  pipelineId: z.string().optional(),
  title: z.string().trim().max(MAX_TASK_TITLE_LENGTH).default(""),
  description: z.string().trim().max(MAX_TASK_DESCRIPTION_LENGTH).default(""),
  startInDays: z
    .number()
    .int()
    .min(0)
    .max(MAX_TASK_DUE_IN_DAYS)
    .nullable()
    .default(null),
  dueInDays: z
    .number()
    .int()
    .min(0)
    .max(MAX_TASK_DUE_IN_DAYS)
    .nullable()
    .default(null),
  assignTo: createTaskAssignTo.default("none"),
  /** Workspace member id when `assignTo` = user; never remapped on import. */
  assigneeId: z.string().optional(),
})
export type CreateTaskStepSchema = z.infer<typeof createTaskStepSchema>

export const createTaskStepDefaultFn = (): CreateTaskStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.createTask,
  pipelineId: undefined,
  title: "",
  description: "",
  startInDays: null,
  dueInDays: null,
  assignTo: "none",
  assigneeId: undefined,
})
