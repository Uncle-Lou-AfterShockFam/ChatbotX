import { companyModel, createSelectSchema } from "@chatbotx.io/database/schema"
import z from "zod"

export const companyResource = createSelectSchema(companyModel, {
  id: z.string(),
  workspaceId: z.string(),
  stoppedByContactId: z.string().nullable(),
})
export type CompanyResource = z.infer<typeof companyResource>

export const companyWithContactCountResource = companyResource.extend({
  contactCount: z.number().int(),
})
export type CompanyWithContactCountResource = z.infer<
  typeof companyWithContactCountResource
>

export const companyStopResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("stopped"),
    companyId: z.string(),
    contactCount: z.number().int(),
    enrollmentsRemoved: z.number().int(),
    smartDelaysCanceled: z.number().int(),
    broadcastRowsFailed: z.number().int(),
    tagId: z.string().optional(),
  }),
  z.object({ status: z.literal("already_stopped"), companyId: z.string() }),
  z.object({
    status: z.literal("skipped"),
    companyId: z.string(),
    why: z.literal("stopOnReply_off"),
  }),
])
export type CompanyStopResult = z.infer<typeof companyStopResultSchema>
