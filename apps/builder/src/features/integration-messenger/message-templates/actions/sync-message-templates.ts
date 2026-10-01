"use server"

import { messengerIntegrationService } from "@chatbotx.io/business"
import { invalidateCacheByTags } from "@chatbotx.io/redis"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { syncMessengerMessageTemplatesForIntegration } from "../lib/sync-message-templates"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const syncMessengerMessageTemplateAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
    } = props

    const integrationMessenger =
      await messengerIntegrationService.findByIdForWorkspace({
        workspaceId,
        id,
      })
    if (!integrationMessenger) {
      throw new Error("Messenger integration not found")
    }

    await syncMessengerMessageTemplatesForIntegration({
      workspaceId,
      integrationMessenger,
    })

    await invalidateCacheByTags([
      `workspaces:${workspaceId}#messenger#messageTemplates`,
    ])
  })
