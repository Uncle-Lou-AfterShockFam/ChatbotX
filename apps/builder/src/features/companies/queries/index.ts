import { companyService } from "@chatbotx.io/business"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"
import type { ListCompaniesRequest } from "../schema/query"

export const listCompaniesRSC = async (
  input: ListCompaniesRequest & { workspaceId: string },
) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  return companyService.list(input)
}

export const getCompanyRSC = async (input: {
  workspaceId: string
  id: string
}) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  return companyService.findOrFail(input)
}
