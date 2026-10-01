"use server"

import { templateService } from "@chatbotx.io/business"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import { updateShareSettingsRequest } from "../schema/mutation"

export const updateShareSettingsAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(updateShareSettingsRequest)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    const template = await templateService.updateShareSettings({
      workspaceId,
      templateId: parsedInput.templateId,
      shareEnabled: parsedInput.shareEnabled,
      shareExpiresAt: parsedInput.shareExpiresAt
        ? new Date(parsedInput.shareExpiresAt)
        : null,
    })
    return { shareToken: template.shareToken }
  })
