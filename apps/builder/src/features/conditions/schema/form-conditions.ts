import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/**
 * `formSubmitted` (s200): pinned to ONE form (`sourceId` = the form id); the
 * worker matches it exactly, so an empty sourceId never fires.
 */
export const formSubmitted = z.object({
  id: zodBigintAsString().optional(),
  type: z.literal(triggerEventTypes.enum.formSubmitted),
  sourceId: z.string().min(1, "Required"),
})

/**
 * `formAbandoned` (s220 A2-3): a chat run of ONE form timed out or used up
 * its attempts, or (s224a) a personal-link web visit of it went idle;
 * pinned by form id like `formSubmitted`.
 */
export const formAbandoned = z.object({
  id: zodBigintAsString().optional(),
  type: z.literal(triggerEventTypes.enum.formAbandoned),
  sourceId: z.string().min(1, "Required"),
})

export const FORM_CONDITION_TYPES = [
  triggerEventTypes.enum.formSubmitted,
  triggerEventTypes.enum.formAbandoned,
] as const
