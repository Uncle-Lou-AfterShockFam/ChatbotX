"use server"

import { integrationWooCommerceService } from "@chatbotx.io/business/integration-woocommerce"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"

export const disconnectWooCommerceAction = workspaceActionClient
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
