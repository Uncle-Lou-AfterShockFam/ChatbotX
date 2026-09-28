"use server"

import { platformCredentialService } from "@chatbotx.io/business"

import { authActionClient } from "@/lib/safe-action"
import { credentialScopeSchema, resolveCredentialScopedUserId } from "../scope"

export const deleteQuickbooksSettingsAction = authActionClient
  .bindArgsSchemas([credentialScopeSchema])
  .action(async ({ ctx, bindArgsParsedInputs: [scope] }) => {
    const scopedUserId = resolveCredentialScopedUserId(ctx.user, scope)
    await platformCredentialService.remove({
      userId: scopedUserId,
      type: "quickbooks",
    })
  })
