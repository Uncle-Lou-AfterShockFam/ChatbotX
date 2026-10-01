"use server"

import { zaloIntegrationService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { settingsActionClient } from "@/lib/safe-action"

export const toggleZaloTagSyncAction = settingsActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(z.object({ enabled: z.boolean() }))
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, integrationId],
      parsedInput: { enabled },
    } = props

    await zaloIntegrationService.updateTagSync({
      workspaceId,
      integrationId,
      enabled,
    })
  })
