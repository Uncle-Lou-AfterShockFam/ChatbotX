"use server"

import { submitBookingRequestSchema } from "@/features/booking-webview/schema/action"
import { actionClient } from "@/lib/safe-action"
import { submitBooking } from "../lib/submit-booking"

// Only the safe-action wrapper lives here: every export of a "use server"
// file is a Server Action, and the helper behind it skips this wrapper's
// input parse and auth, so it stays in a server-only lib module (s232a).
export const submitBookingAction = actionClient
  .inputSchema(submitBookingRequestSchema)
  .action(async ({ parsedInput }) => submitBooking(parsedInput))
