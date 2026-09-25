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
const startAt = z.coerce
  .date()
  .nullish()
  .describe(
    "Optional start of the task's timeline bar; must not be after dueAt (422 startAfterDue).",
  )
const dayOffset = z
  .number()
  .int()
  .min(0)
  .max(MAX_DEAL_TASK_DUE_IN_DAYS)
  .nullish()

export const createDealTaskRequest = z.object({
  title,
  description,
  assigneeId,
  startAt,
  dueAt,
})
export type CreateDealTaskRequest = z.infer<typeof createDealTaskRequest>

export const updateDealTaskRequest = z.object({
  title: title.optional(),
  description,
  assigneeId,
  startAt,
  dueAt,
  shiftSuccessors: z
    .boolean()
    .optional()
    .describe(
      "When dueAt moves, move every open task that waits on this one (directly or through other open tasks) by the same amount.",
    ),
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
  startInDays: dayOffset.describe(
    "Start date offset in days from the day the deal enters the stage; null = none. Must not exceed dueInDays.",
  ),
  dueInDays: dayOffset.describe(
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

export const addTaskTemplateDependencyRequest = z.object({
  dependsOnTemplateId: zodBigintAsString().describe(
    "Template of the same stage whose task must be completed first.",
  ),
})

/** `GET /workspaces/{workspaceId}/tasks` (the task calendar, s197). */
export const listTasksInRangeQuery = z.object({
  from: z.coerce.date().describe("Start of the range (inclusive, on dueAt)."),
  to: z.coerce
    .date()
    .describe("End of the range (exclusive); at most 62 days after `from`."),
  assignee: z
    .enum(["me", "any"])
    .optional()
    .describe("`me` = only tasks assigned to the caller (default any)."),
  status: z.enum(["open", "done"]).optional(),
  pipelineId: zodBigintAsString().optional(),
})

/**
 * `GET /workspaces/{workspaceId}/tasks/mine` ("My tasks", s198). Closed:
 * the assignee is always the caller, so an `assigneeId` is a 400, not a
 * silently ignored key.
 */
export const listMyTasksQuery = z
  .object({
    workspaceId: zodBigintAsString(),
    status: z
      .enum(["open", "done"])
      .optional()
      .describe(
        "`open` (default) = soonest due first; `done` = latest completed first.",
      ),
    cursor: z
      .string()
      // = MY_TASKS_CURSOR_MAX_LENGTH in the deal-task service
      .max(256)
      .optional()
      .describe("`nextCursor` of the previous page."),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
