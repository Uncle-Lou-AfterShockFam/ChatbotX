import { messengerIntegrationService } from "@chatbotx.io/business"
import { findOrFail } from "@chatbotx.io/database/client"
import { integrationMessengerModel } from "@chatbotx.io/database/schema"
import type { IntegrationMessengerModel } from "@chatbotx.io/database/types"
import {
  type WithoutCredentials,
  withoutCredentials,
} from "@/lib/without-credentials"

export const findIntegrationMessenger = async (
  input: Partial<Pick<IntegrationMessengerModel, "id" | "workspaceId">>,
): Promise<IntegrationMessengerModel> =>
  findOrFail({ table: integrationMessengerModel, where: input })

export const listIntegrationMessengers = async (
  input: Partial<Pick<IntegrationMessengerModel, "id" | "workspaceId">>,
): Promise<{ data: WithoutCredentials<IntegrationMessengerModel>[] }> => {
  const data = await messengerIntegrationService.listByWorkspaceIdOrId(input)

  return { data: data.map(withoutCredentials) }
}
