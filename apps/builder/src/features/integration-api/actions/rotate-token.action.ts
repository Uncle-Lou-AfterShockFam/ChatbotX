"use server"

import { auditService } from "@chatbotx.io/business/audit"
import { generateApiChannelToken } from "@chatbotx.io/business/workspace-api-token/credentials"
import type { WorkspaceMemberPermissions } from "@chatbotx.io/database/partials"
import { integrationApiRepository } from "@chatbotx.io/database/repositories"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { findIntegrationApiByWorkspaceAndId } from "@/features/integration-api/queries"
import { settingsActionClient } from "@/lib/safe-action"
import { assertEmailLineAdmin } from "../lib/email-line-guard"

export const rotateApiTokenAction = settingsActionClient
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
      const existing = await findIntegrationApiByWorkspaceAndId({
        id,
        workspaceId,
      })
      // s231b: a new email-line token reads every sender's credentials.
      if (existing.lineKind === "email") {
        assertEmailLineAdmin(ctx, "rotate the token of")
      }

      const { token, tokenHash, tokenPrefix } = await generateApiChannelToken()

      await integrationApiRepository.rotateToken({
        id,
        workspaceId,
        tokenHash,
        tokenPrefix,
      })

      await auditService.record({
        workspaceId,
        action: "update",
        detail: `rotated the API key (#${id})`,
      })

      return { token }
    },
  )
