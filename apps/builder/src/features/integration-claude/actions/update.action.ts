"use server"

import { aiProviders } from "@chatbotx.io/ai"
import { aiIntegrationService } from "@chatbotx.io/ai/server"
import { integrationClaudeService } from "@chatbotx.io/business"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import {
  type UpdateClaudeRequest,
  updateClaudeRequest,
} from "../schema/request"

export const updateIntegrationClaudeAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(updateClaudeRequest)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: UpdateClaudeRequest
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      await integrationClaudeService.update({ workspaceId }, parsedInput)

      await aiIntegrationService.invalidateCache(
        workspaceId,
        aiProviders.enum.claude,
      )
    },
  )
