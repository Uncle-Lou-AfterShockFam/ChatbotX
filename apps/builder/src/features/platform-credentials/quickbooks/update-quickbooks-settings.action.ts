"use server"

import { platformCredentialService } from "@chatbotx.io/business"
import {
  type QuickbooksCredential,
  quickbooksCredentialUpdateSchema,
} from "@chatbotx.io/database/partials"

import { authActionClient } from "@/lib/safe-action"
import { credentialScopeSchema, resolveCredentialScopedUserId } from "../scope"

export const updateQuickbooksSettingsAction = authActionClient
  .bindArgsSchemas([credentialScopeSchema])
  .inputSchema(quickbooksCredentialUpdateSchema)
  .action(async ({ ctx, bindArgsParsedInputs: [scope], parsedInput }) => {
    const scopedUserId = resolveCredentialScopedUserId(ctx.user, scope)
    const config: QuickbooksCredential = {
      clientId: parsedInput.clientId,
      clientSecret: parsedInput.clientSecret,
      webhookVerifierToken: parsedInput.webhookVerifierToken,
      environment: parsedInput.environment,
    }

    await platformCredentialService.upsert({
      userId: scopedUserId,
      type: "quickbooks",
      config,
    })
  })
