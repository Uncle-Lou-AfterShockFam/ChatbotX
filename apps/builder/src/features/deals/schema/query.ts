import { dealStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { basePaginationRequest } from "@/lib/pagination"
import { dealResource } from "./resource"

export const listDealsRequest = basePaginationRequest.and(
  z.object({
    pipelineId: zodBigintAsString()
      .nullish()
      .describe("Only deals of this pipeline."),
    stageId: zodBigintAsString()
      .nullish()
      .describe("Only deals in this stage."),
    contactId: zodBigintAsString()
      .nullish()
      .describe("Only deals of this contact."),
    companyId: zodBigintAsString()
      .nullish()
      .describe("Only deals of this company."),
    ownerId: zodBigintAsString()
      .nullish()
      .describe("Only deals owned by this workspace member (user id)."),
    status: dealStatuses
      .nullish()
      .describe("Only deals with this status (open, won, lost)."),
    title: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .describe("Case-insensitive substring match on the title."),
  }),
)
export type ListDealsRequest = z.infer<typeof listDealsRequest>

export const listDealsResponse = z.object({
  data: z.array(dealResource),
  pageCount: z.number().int(),
})

export const boardStatusFilter = z.enum(["open", "won", "lost", "all"])
export type BoardStatusFilter = z.infer<typeof boardStatusFilter>
