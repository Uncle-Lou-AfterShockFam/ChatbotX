import {
  dealActivityTypes,
  dealPriorities,
  dealStatuses,
} from "@chatbotx.io/database/partials"
import {
  createSelectSchema,
  dealActivityModel,
  dealModel,
} from "@chatbotx.io/database/schema"
import z from "zod"
import { pipelineStageResource } from "@/features/pipelines/schema/resource"

export const dealResource = createSelectSchema(dealModel, {
  id: z.string(),
  workspaceId: z.string(),
  pipelineId: z.string(),
  stageId: z.string(),
  contactId: z.string().nullable(),
  companyId: z.string().nullable(),
  ownerId: z.string().nullable(),
  status: dealStatuses,
  priority: dealPriorities,
  fields: z.record(z.string(), z.unknown()),
})
export type DealResource = z.infer<typeof dealResource>

export const dealActivityResource = createSelectSchema(dealActivityModel, {
  id: z.string(),
  dealId: z.string(),
  actorId: z.string().nullable(),
  type: dealActivityTypes,
  payload: z.record(z.string(), z.unknown()),
})
export type DealActivityResource = z.infer<typeof dealActivityResource>

/** A board card: the deal + its open / overdue task and comment counts (s198). */
export const boardDealResource = dealResource.extend({
  openTaskCount: z.number().int(),
  overdueTaskCount: z.number().int(),
  commentCount: z.number().int(),
})
export type BoardDealResource = z.infer<typeof boardDealResource>

export const boardColumnResource = z.object({
  stage: pipelineStageResource,
  deals: z.array(boardDealResource),
})
export type BoardColumnResource = z.infer<typeof boardColumnResource>
