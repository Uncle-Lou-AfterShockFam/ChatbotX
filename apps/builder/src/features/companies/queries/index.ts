import { companyService } from "@chatbotx.io/business"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
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

/** The company's contacts inside the caller's assigned-only scope (s195). */
export const listCompanyContactsRSC = async (input: {
  workspaceId: string
  companyId: string
}) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  const accessScope = await requireContactPermissionScope(input.workspaceId)
  return companyService.listContacts({ ...input, accessScope })
}
