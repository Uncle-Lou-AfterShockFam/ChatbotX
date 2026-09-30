import { integrationThreadsService } from "@chatbotx.io/business"
import { withoutCredentials } from "@/lib/without-credentials"

export const listIntegrationThreads = async ({
  workspaceId,
}: {
  workspaceId: string
}) => {
  const { data } = await integrationThreadsService.listByWorkspaceId({
    workspaceId,
  })
  return { data: data.map(withoutCredentials) }
}
