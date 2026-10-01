"use server"

import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { updateMessenger } from "../lib/update-messenger"
import { updateMessengerRequest } from "../schema/action"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const updateMessengerAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updateMessengerRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [_, id],
      parsedInput,
      ctx: { workspace },
    } = props

    return await updateMessenger(
      {
        workspace,
        id,
      },
      parsedInput,
    )
  })
