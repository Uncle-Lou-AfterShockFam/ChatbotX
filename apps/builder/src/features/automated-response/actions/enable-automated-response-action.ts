"use server"
import { automatedResponseTypes } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  enableAutomatedResponse,
  enableRequest,
} from "../lib/enable-automated-response"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const enableAutomatedResponseAction = workspaceActionClient
  .bindArgsSchemas([
    zodBigintAsString(),
    zodBigintAsString(),
    automatedResponseTypes,
  ])
  .inputSchema(enableRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id, type],
      parsedInput,
    } = props

    return await enableAutomatedResponse({ workspaceId, id, type }, parsedInput)
  })
