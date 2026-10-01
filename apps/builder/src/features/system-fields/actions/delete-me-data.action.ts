"use server"

import { actionClient } from "@/lib/safe-action"
import { handleDeleteMeData } from "../lib/delete-me-data"
import { meLinkInputSchema } from "../lib/me-link-params"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const deleteMeDataAction = actionClient
  .inputSchema(meLinkInputSchema)
  .action(handleDeleteMeData)
