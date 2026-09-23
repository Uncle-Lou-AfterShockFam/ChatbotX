import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { publicListRequest, publicListResponse } from "@/lib/public-api/list"
import { createCompanyRequest, updateCompanyRequest } from "./action"
import { companyResource, companyWithContactCountResource } from "./resource"

export const listCompaniesPublicRequest = publicListRequest.extend({
  name: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .describe("Case-insensitive substring match on the company name."),
  domain: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .describe("Exact email domain the company claims (no @)."),
  stopped: z
    .boolean()
    .nullish()
    .describe("true = only stopped companies, false = only active ones."),
})

export const companyPublicResource = companyResource.omit({
  workspaceId: true,
})
export const companyWithContactCountPublicResource =
  companyWithContactCountResource.omit({ workspaceId: true })

export const listCompaniesPublicResponse = publicListResponse(
  companyWithContactCountPublicResource,
)

export const createCompanyPublicRequest = createCompanyRequest

export const updateCompanyPublicRequest = updateCompanyRequest.extend({
  id: zodBigintAsString().describe("Company id. Get it from `companies.list`."),
})
