import "server-only"

import { integrationDeepSeekService } from "@chatbotx.io/business"
import {
  type AiIntegrationSummary,
  toAiIntegrationSummary,
} from "@/lib/ai-integration-summary"

export const findIntegrationDeepSeek = async ({
  workspaceId,
}: {
  workspaceId: string
}): Promise<AiIntegrationSummary | null> =>
  toAiIntegrationSummary(
    await integrationDeepSeekService.findByWorkspaceId(workspaceId),
  )
