import { dealStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { publicListRequest, publicListResponse } from "@/lib/public-api/list"
import {
  addDealNoteRequest,
  createDealRequest,
  moveDealPipelineRequest,
  moveDealRequest,
  setDealStatusRequest,
  updateDealRequest,
} from "./action"
import { dealActivityResource, dealResource } from "./resource"

const dealIdDescription = "Deal id. Get it from `deals.list`."

export const dealPublicResource = dealResource.omit({ workspaceId: true })
export const dealActivityPublicResource = dealActivityResource

export const dealIdInput = z.object({
  id: zodBigintAsString().describe(dealIdDescription),
})

export const listDealsPublicRequest = publicListRequest.extend({
  pipelineId: zodBigintAsString()
    .nullish()
    .describe("Only deals of this pipeline (see `pipelines.list`)."),
  stageId: zodBigintAsString()
    .nullish()
    .describe("Only deals in this stage of the pipeline."),
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
    .describe("Only deals with this status: open, won or lost."),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullish()
    .describe("Case-insensitive substring match on the deal title."),
})

export const listDealsPublicResponse = publicListResponse(dealPublicResource)

export const createDealPublicRequest = createDealRequest

export const updateDealPublicRequest = updateDealRequest.extend({
  id: zodBigintAsString().describe(dealIdDescription),
})

export const moveDealPublicRequest = moveDealRequest.extend({
  id: zodBigintAsString().describe(dealIdDescription),
})

export const moveDealPipelinePublicRequest = moveDealPipelineRequest.extend({
  id: zodBigintAsString().describe(dealIdDescription),
})

export const setDealStatusPublicRequest = setDealStatusRequest.extend({
  id: zodBigintAsString().describe(dealIdDescription),
})

export const addDealNotePublicRequest = addDealNoteRequest.extend({
  id: zodBigintAsString().describe(dealIdDescription),
})
