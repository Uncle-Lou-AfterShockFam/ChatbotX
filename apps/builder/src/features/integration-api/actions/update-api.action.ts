"use server"

import { assertPublicUrl } from "@chatbotx.io/business"
import { auditService } from "@chatbotx.io/business/audit"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import type { WorkspaceMemberPermissions } from "@chatbotx.io/database/partials"
import { integrationApiRepository } from "@chatbotx.io/database/repositories"
import type { ApiAuthValue } from "@chatbotx.io/integration-api"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { findIntegrationApiByWorkspaceAndId } from "@/features/integration-api/queries"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"
import type { UpdateApiRequest } from "../schema/mutation"
import { updateApiRequest } from "../schema/mutation"

export const updateApiAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(updateApiRequest)
  .action(
    async ({
      ctx,
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
    }: {
      ctx: {
        workspaceMemberPermissions: WorkspaceMemberPermissions
        isSupportSession: boolean
      }
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
      parsedInput: UpdateApiRequest
    }) => {
      if (parsedInput.callbackUrl) {
        await assertPublicUrl(
          parsedInput.callbackUrl,
          "API channel callback URL",
        )
      }

      const existing = await findIntegrationApiByWorkspaceAndId({
        id,
        workspaceId,
      })

      // s231b (owner 2026-10-01): changing whether this channel is an email
      // line decides whether its token receives mailbox credentials - a real
      // super admin only, never a platform-support session.
      const lineKind =
        parsedInput.emailLine === undefined
          ? undefined
          : parsedInput.emailLine
            ? ("email" as const)
            : null
      const lineKindChanges =
        lineKind !== undefined && lineKind !== (existing.lineKind ?? null)
      if (
        lineKindChanges &&
        (ctx.isSupportSession ||
          !hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin"))
      ) {
        throw new ChatbotXException(
          "Only a workspace admin can mark an API channel as an email line",
          "emailLineSuperAdminRequired",
          403,
        )
      }

      // An empty string from the form means "clear the callback".
      const callbackUrl =
        parsedInput.callbackUrl === "" ? null : parsedInput.callbackUrl

      const auth = existing.auth as ApiAuthValue
      const nextAuth: ApiAuthValue = {
        ...auth,
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        ...(parsedInput.deliveryMode === undefined
          ? {}
          : { deliveryMode: parsedInput.deliveryMode }),
        ...(parsedInput.shortenLinks === undefined
          ? {}
          : { shortenLinks: parsedInput.shortenLinks }),
      }

      await integrationApiRepository.updateSettings({
        id,
        workspaceId,
        name: parsedInput.name,
        callbackUrl,
        auth: nextAuth,
        ...(lineKindChanges ? { lineKind } : {}),
      })

      await auditService.record({
        workspaceId,
        action: "update",
        detail: `updated the API key configuration (#${id})${lineKindChanges ? (lineKind === "email" ? ", marked as an email line" : ", no longer an email line") : ""}`,
      })
    },
  )
