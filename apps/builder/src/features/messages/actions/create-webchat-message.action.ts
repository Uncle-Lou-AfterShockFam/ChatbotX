"use server"

import { actionClient } from "@/lib/safe-action"
import { handleCreateWebchatMessage } from "../lib/create-webchat-message"
import { createWebchatMessageRequest } from "../schema/mutation"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const createWebchatMessageAction = actionClient
  .inputSchema(createWebchatMessageRequest)
  .action(handleCreateWebchatMessage)
