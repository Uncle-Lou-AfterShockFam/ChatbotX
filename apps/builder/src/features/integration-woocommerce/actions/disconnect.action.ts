"use server"

import { integrationWooCommerceService } from "@chatbotx.io/business/integration-woocommerce"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"

export const disconnectWooCommerceAction = settingsActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      await integrationWooCommerceService.disconnect({
        workspaceId,
        integrationId,
      })
    },
  )
