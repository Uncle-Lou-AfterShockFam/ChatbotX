import { dealTaskStatuses } from "@chatbotx.io/database/partials"
import {
  createSelectSchema,
  dealTaskModel,
  dealTaskTemplateModel,
} from "@chatbotx.io/database/schema"
import z from "zod"

export const dealTaskResource = createSelectSchema(dealTaskModel, {
  id: z.string(),
  workspaceId: z.string(),
  dealId: z.string(),
  templateId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  createdById: z.string().nullable(),
  completedById: z.string().nullable(),
  status: dealTaskStatuses,
})
export type DealTaskResource = z.infer<typeof dealTaskResource>

/** An update's result: the task plus the successors a `shiftSuccessors` moved. */
export const dealTaskUpdateResource = dealTaskResource.extend({
  shifted: z.array(z.string()),
})

/** A task plus the ids of the OPEN tasks it waits on (derived server-side). */
export const dealTaskWithBlockersResource = dealTaskResource.extend({
  /** OPEN tasks it waits on (the "blocked" badge). */
  blockedBy: z.array(z.string()),
  /** Every stored dependency edge, open or done (drives add/remove). */
  dependsOn: z.array(z.string()),
  /** Start of the timeline bar: startAt, else the latest predecessor due date, else createdAt. */
  effectiveStart: z.date(),
  /** Open predecessors due after this task starts (the timeline's red arrows). */
  conflicts: z.array(z.string()),
})
export type DealTaskWithBlockersResource = z.infer<
  typeof dealTaskWithBlockersResource
>

export const dealTaskTemplateResource = createSelectSchema(
  dealTaskTemplateModel,
  {
    id: z.string(),
    workspaceId: z.string(),
    pipelineId: z.string(),
    stageId: z.string(),
    assigneeId: z.string().nullable(),
  },
).extend({
  /** Templates of the same stage this one waits on. */
  dependsOn: z.array(z.string()),
})
export type DealTaskTemplateResource = z.infer<typeof dealTaskTemplateResource>
