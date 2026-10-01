import { flowService } from "@chatbotx.io/business"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"
import type { ListFlowsRequest, ListFlowsResponse } from "../schema/query"

export const listFlowsRSC = async (
  input: ListFlowsRequest & { workspaceId: string },
) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)

  return listFlows(input)
}

export async function listFlows(
  input: ListFlowsRequest & { workspaceId: string },
): Promise<ListFlowsResponse> {
  return await flowService.list(input)
}

export const ensureAllFlowIdsExists = async (
  workspaceId: string,
  flowIds: string[],
): Promise<void> => {
  await flowService.assertAllExist({ workspaceId, flowIds })
}
