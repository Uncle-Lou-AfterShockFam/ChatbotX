import "server-only"

import { integrationWebchatService } from "@chatbotx.io/business"
import type { IntegrationWebchatModel } from "@chatbotx.io/database/types"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"
import { withoutCredentials } from "@/lib/without-credentials"
import type { ListIntegrationWebchatsRequest } from "../schema/query"

export const listIntegrationWebchats = async (
  input: ListIntegrationWebchatsRequest & { workspaceId: string },
) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)

  const { data, pageCount } = await integrationWebchatService.list({
    workspaceId: input.workspaceId,
    page: input.page,
    perPage: input.perPage,
  })
  return { data: data.map(withoutCredentials), pageCount }
}

export async function findIntegrationWebchat(
  where: Pick<IntegrationWebchatModel, "id" | "workspaceId">,
) {
  return await integrationWebchatService.findByIdForWorkspace({
    id: where.id,
    workspaceId: where.workspaceId,
  })
}
