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

/** A task plus the ids of the OPEN tasks it waits on (derived server-side). */
export const dealTaskWithBlockersResource = dealTaskResource.extend({
  blockedBy: z.array(z.string()),
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
)
export type DealTaskTemplateResource = z.infer<typeof dealTaskTemplateResource>
