import { pipelineService } from "@chatbotx.io/business"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"

export const listPipelinesRSC = async (input: { workspaceId: string }) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  return pipelineService.list(input)
}

export const getPipelineRSC = async (input: {
  workspaceId: string
  id: string
}) => {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)
  return pipelineService.find(input)
}
