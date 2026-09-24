import {
  MAX_DEAL_TASK_DESCRIPTION_LENGTH,
  MAX_DEAL_TASK_DUE_IN_DAYS,
  MAX_DEAL_TASK_TITLE_LENGTH,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

const title = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DEAL_TASK_TITLE_LENGTH)
  .describe("Task title shown in the deal's task list (max 200 characters).")
const description = z
  .string()
  .trim()
  .max(MAX_DEAL_TASK_DESCRIPTION_LENGTH)
  .nullish()
  .describe("Optional longer description of the task (max 2000 characters).")
const assigneeId = zodBigintAsString()
  .nullish()
  .describe(
    "Workspace member (user id) the task is assigned to; null clears it.",
  )
const dueAt = z.coerce
  .date()
  .nullish()
  .describe("Optional due date; an open task past it emits taskOverdue once.")

export const createDealTaskRequest = z.object({
  title,
  description,
  assigneeId,
  dueAt,
})
export type CreateDealTaskRequest = z.infer<typeof createDealTaskRequest>

export const updateDealTaskRequest = z.object({
  title: title.optional(),
  description,
  assigneeId,
  dueAt,
})
export type UpdateDealTaskRequest = z.infer<typeof updateDealTaskRequest>

export const completeDealTaskRequest = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Complete even while a task it depends on is still open."),
})

export const addDealDependencyRequest = z.object({
  dependsOnTaskId: zodBigintAsString().describe(
    "Task of the same deal that must be completed first.",
  ),
})

export const upsertDealTaskTemplateRequest = z.object({
  title,
  description,
  dueInDays: z
    .number()
    .int()
    .min(0)
    .max(MAX_DEAL_TASK_DUE_IN_DAYS)
    .nullish()
    .describe(
      "Due date offset in days from the day the deal enters the stage; null = none.",
    ),
  assignToOwner: z
    .boolean()
    .optional()
    .describe(
      "Assign the task to the deal owner when the deal enters the stage.",
    ),
  assigneeId: zodBigintAsString()
    .nullish()
    .describe("Fixed assignee (workspace member) when assignToOwner is off."),
})
export type UpsertDealTaskTemplateRequest = z.infer<
  typeof upsertDealTaskTemplateRequest
>
