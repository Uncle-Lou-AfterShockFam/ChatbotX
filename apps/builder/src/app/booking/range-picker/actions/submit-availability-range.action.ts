"use server"

import { submitAvailabilityRangeRequestSchema } from "@/features/booking-webview/schema/availability-range-action"
import { actionClient } from "@/lib/safe-action"
import { submitAvailabilityRange } from "../lib/submit-availability-range"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const submitAvailabilityRangeAction = actionClient
  .inputSchema(submitAvailabilityRangeRequestSchema)
  .action(async ({ parsedInput }) => submitAvailabilityRange(parsedInput))
