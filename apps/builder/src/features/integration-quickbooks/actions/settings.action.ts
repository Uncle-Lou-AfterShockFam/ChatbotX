"use server"

import { integrationQuickbooksService } from "@chatbotx.io/business/integration-quickbooks"
import { z } from "zod"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"

/** Turn the bookkeeping mirror on or off (s214b). */
export const setQuickbooksMirrorAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(z.object({ enabled: z.boolean() }).strict())
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    const summary = await integrationQuickbooksService.setMirror({
      workspaceId,
      enabled: parsedInput.enabled,
    })
    return { mirrorEnabled: summary.mirrorEnabled }
  })

/** Disconnect; refused while a quickbooks invoice is still live. */
export const disconnectQuickbooksAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(async ({ bindArgsParsedInputs: [workspaceId] }) => {
    await integrationQuickbooksService.disconnect(workspaceId)
  })
