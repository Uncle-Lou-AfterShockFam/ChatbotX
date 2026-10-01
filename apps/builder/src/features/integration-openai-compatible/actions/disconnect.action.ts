"use server"

import { integrationOpenaiCompatibleService } from "@chatbotx.io/business"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"

export const disconnectOpenaiCompatibleAction = settingsActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      await integrationOpenaiCompatibleService.disconnect(
        workspaceId,
        integrationId,
      )
    },
  )
