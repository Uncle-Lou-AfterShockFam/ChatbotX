"use server"

import { integrationApiService, workspaceService } from "@chatbotx.io/business"
import type { WorkspaceMemberPermissions } from "@chatbotx.io/database/partials"
import type { ApiAuthValue } from "@chatbotx.io/integration-api"
import { integration as integrationApi } from "@chatbotx.io/integration-api"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { findIntegrationApiByWorkspaceAndId } from "@/features/integration-api/queries"
import { logger } from "@/lib/log"
import { workspaceActionClientAllowExpired } from "@/lib/safe-action"
import { assertEmailLineAdmin } from "../lib/email-line-guard"

export const deleteApiAction = workspaceActionClientAllowExpired
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .action(
    async ({
      ctx,
      bindArgsParsedInputs: [workspaceId, id],
    }: {
      ctx: {
        workspaceMemberPermissions: WorkspaceMemberPermissions
        isSupportSession: boolean
      }
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      const [integrationApiRow, workspace] = await Promise.all([
        findIntegrationApiByWorkspaceAndId({ workspaceId, id }),
        workspaceService.findById({ id: workspaceId }),
      ])
      // s231b: deleting an email line takes its senders' mail down with it.
      if (integrationApiRow.lineKind === "email") {
        assertEmailLineAdmin(ctx, "delete")
      }

      try {
        await integrationApi.disconnect(integrationApiRow.auth as ApiAuthValue)
      } catch (error) {
        logger.warn(
          { err: error },
          "API channel disconnect call failed — proceeding with local cleanup",
        )
      }

      await integrationApiService.disconnect({
        id: integrationApiRow.id,
        inboxId: integrationApiRow.inboxId,
        workspaceId,
        ownerId: workspace.ownerId,
      })
    },
  )
