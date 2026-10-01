"use server"
import { aiIntegrationService } from "@chatbotx.io/ai/server"
import { integrationGeminiService } from "@chatbotx.io/business"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import {
  type UpdateGeminiRequest,
  updateGeminiRequest,
} from "../schema/request"

export const updateGeminiAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(updateGeminiRequest)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId],
    }: {
      parsedInput: UpdateGeminiRequest
      bindArgsParsedInputs: WorkspaceIdRequestParams
    }) => {
      await integrationGeminiService.update({ workspaceId }, parsedInput)

      await aiIntegrationService.invalidateCache(workspaceId, "gemini")
    },
  )
