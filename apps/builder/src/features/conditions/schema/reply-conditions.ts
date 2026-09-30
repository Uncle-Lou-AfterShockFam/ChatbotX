import { replyClasses, triggerEventTypes } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/**
 * `contactReplyClassified` (s228b outreach step 2): pinned to ONE class
 * (`sourceId` = the class, e.g. interested); the worker matches it exactly.
 */
export const REPLY_CONDITION_TYPES = [
  triggerEventTypes.enum.contactReplyClassified,
] as const

export const contactReplyClassified = z.object({
  id: zodBigintAsString().optional(),
  type: z.literal(triggerEventTypes.enum.contactReplyClassified),
  sourceId: replyClasses,
})
