import "server-only"

import { integrationClaudeService } from "@chatbotx.io/business"
import {
  type AiIntegrationSummary,
  toAiIntegrationSummary,
} from "@/lib/ai-integration-summary"

export const findIntegrationClaude = async ({
  workspaceId,
}: {
  workspaceId: string
}): Promise<AiIntegrationSummary | null> =>
  toAiIntegrationSummary(
    await integrationClaudeService.findByWorkspaceId(workspaceId),
  )
