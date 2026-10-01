import "server-only"

import { integrationGeminiService } from "@chatbotx.io/business"
import {
  type AiIntegrationSummary,
  toAiIntegrationSummary,
} from "@/lib/ai-integration-summary"

export const findIntegrationGemini = async ({
  workspaceId,
}: {
  workspaceId: string
}): Promise<AiIntegrationSummary | null> =>
  toAiIntegrationSummary(
    await integrationGeminiService.findByWorkspaceId(workspaceId),
  )
