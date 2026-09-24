import { dealService } from "@chatbotx.io/business/deal"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"
import type { BoardStatusFilter } from "../schema/query"

export const listDealBoardRSC = async (input: {
  workspaceId: string
  pipelineId: string
  status?: BoardStatusFilter
}) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  return dealService.listBoard(input)
}
