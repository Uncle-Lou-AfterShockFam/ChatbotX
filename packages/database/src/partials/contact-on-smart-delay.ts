import { z } from "zod"

export const smartDelayTypes = z.enum(["waitNode", "followUp", "waitForEvent"])
export type SmartDelayType = z.infer<typeof smartDelayTypes>

// `running` = claimed by a resume (event or timeout) whose flow has not
// finished yet; the claim generation ties the finish/requeue to THAT claim.
export const smartDelayStatuses = z.enum([
  "pending",
  "scheduled",
  "running",
  "completed",
  "failed",
  "canceled",
])
export type SmartDelayStatus = z.infer<typeof smartDelayStatuses>
