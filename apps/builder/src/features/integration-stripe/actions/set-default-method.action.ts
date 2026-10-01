"use server"

import { integrationStripeService } from "@chatbotx.io/business/integration-stripe"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import { setDefaultMethodSchema } from "../schema"

export const setStripeDefaultMethodAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(setDefaultMethodSchema)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    await integrationStripeService.setDefaultMethod({
      workspaceId,
      method: parsedInput.method,
    })
  })
