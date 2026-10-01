"use server"

import { workspaceIdrequestParams } from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import { updateWhatsappProfileRequest } from "../schema/update-whatsapp-profile.request"

export const updateWhatsappProfileAction = settingsActionClient
  .inputSchema(updateWhatsappProfileRequest)
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(
    async () =>
      await {
        success: true,
      },
  )
