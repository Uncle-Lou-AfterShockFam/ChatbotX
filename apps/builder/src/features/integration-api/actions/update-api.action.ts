"use server"

import { assertPublicUrl } from "@chatbotx.io/business"
import { auditService } from "@chatbotx.io/business/audit"
import type { WorkspaceMemberPermissions } from "@chatbotx.io/database/partials"
import { integrationApiRepository } from "@chatbotx.io/database/repositories"
import type { ApiAuthValue } from "@chatbotx.io/integration-api"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { findIntegrationApiByWorkspaceAndId } from "@/features/integration-api/queries"
import { workspaceActionClient } from "@/lib/safe-action"
import { assertEmailLineAdmin } from "../lib/email-line-guard"
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
      let lineKind: "email" | null | undefined
      if (parsedInput.emailLine !== undefined) {
        lineKind = parsedInput.emailLine ? "email" : null
      }
      const lineKindChanges =
        lineKind !== undefined && lineKind !== (existing.lineKind ?? null)
      let lineKindNote = ""
      if (lineKindChanges) {
        assertEmailLineAdmin(ctx, lineKind === "email" ? "mark" : "unmark")
        lineKindNote =
          lineKind === "email"
            ? ", marked as an email line"
            : ", no longer an email line"
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
        detail: `updated the API key configuration (#${id})${lineKindNote}`,
      })
    },
  )
