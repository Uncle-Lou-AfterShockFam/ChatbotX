import "server-only"

import { integrationOpenRouterService } from "@chatbotx.io/business"
import {
  type AiIntegrationSummary,
  toAiIntegrationSummary,
} from "@/lib/ai-integration-summary"

export const findIntegrationOpenRouter = async ({
  workspaceId,
}: {
  workspaceId: string
}): Promise<AiIntegrationSummary | null> =>
  toAiIntegrationSummary(
    await integrationOpenRouterService.findByWorkspaceId(workspaceId),
  )
