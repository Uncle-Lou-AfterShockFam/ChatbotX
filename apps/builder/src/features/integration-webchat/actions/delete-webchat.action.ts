"use server"

import { integrationWebchatService } from "@chatbotx.io/business"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"

export const deleteWebchatAction = settingsActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, id],
    }: {
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      await integrationWebchatService.delete({ workspaceId, id })
    },
  )
