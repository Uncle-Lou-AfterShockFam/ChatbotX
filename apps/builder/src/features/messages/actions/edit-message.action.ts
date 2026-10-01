"use server"

import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { editMessage } from "../lib/edit-message"
import { editMessageRequest } from "../schema/mutation"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const editMessageAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(editMessageRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, conversationId],
      parsedInput,
    } = props

    return await editMessage({ workspaceId, conversationId, parsedInput })
  })
