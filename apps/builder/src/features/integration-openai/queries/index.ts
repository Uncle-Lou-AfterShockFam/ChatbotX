import "server-only"

import { integrationOpenAIService } from "@chatbotx.io/business"
import {
  type AiIntegrationSummary,
  toAiIntegrationSummary,
} from "@/lib/ai-integration-summary"

export const findIntegrationOpenAI = async ({
  workspaceId,
}: {
  workspaceId: string
}): Promise<{
  data: AiIntegrationSummary | null
}> => ({
  data: toAiIntegrationSummary(
    await integrationOpenAIService.findByWorkspaceId(workspaceId),
  ),
})
