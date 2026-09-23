import type { CompanyModel } from "@chatbotx.io/database/types"
import { getSortingStateParser } from "@chatbotx.io/ui/lib/parsers"
import { zodBigintAsString } from "@chatbotx.io/utils"
import {
  createSearchParamsCache,
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
} from "nuqs/server"
import z from "zod"
import { basePaginationRequest } from "@/lib/pagination"
import { companyWithContactCountResource } from "./resource"

export const listCompaniesSearchParams = {
  page: parseAsInteger,
  perPage: parseAsInteger,
  name: parseAsString,
  domain: parseAsString,
  stopped: parseAsBoolean,
  sort: getSortingStateParser<CompanyModel>().withDefault([
    { id: "createdAt", desc: true },
  ]),
}
export const listCompaniesSearchParamsCache = createSearchParamsCache(
  listCompaniesSearchParams,
)

export const listCompaniesRequest = basePaginationRequest.and(
  z.object({
    name: z.string().nullish(),
    domain: z.string().nullish(),
    stopped: z.boolean().nullish(),
    workspaceId: zodBigintAsString(),
  }),
)
export type ListCompaniesRequest = z.infer<typeof listCompaniesRequest>

export const listCompaniesResponse = z.object({
  data: z.array(companyWithContactCountResource),
  pageCount: z.number().int(),
})
export type ListCompaniesResponse = z.infer<typeof listCompaniesResponse>
