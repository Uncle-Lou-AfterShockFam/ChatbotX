"use server"

import { submitDateTimeRequestSchema } from "@/features/get-user-data-webview/schema/action"
import { actionClient } from "@/lib/safe-action"
import { submitDateTime } from "../lib/submit-date-time"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const submitDateTimeAction = actionClient
  .inputSchema(submitDateTimeRequestSchema)
  .action(async ({ parsedInput }) => submitDateTime(parsedInput))
