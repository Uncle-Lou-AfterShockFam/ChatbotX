import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  errorStateDefaultFn,
  errorStateSchema,
  successStateDefaultFn,
  successStateSchema,
} from "../states"
import { stepTypes } from "./step-action"

/** Mirrors PAGE_LINK_TTL_MIN_HOURS / _MAX_HOURS in @chatbotx.io/database. */
const TTL_MIN_HOURS = 1
const TTL_MAX_HOURS = 2160

/**
 * Mint the contact's personal link to a custom page (roadmap B4) and write
 * it to the contact field `page_link` for a following text or email step.
 * The link expires after `ttlHours` (or the page's own lifetime). Error: no
 * page picked, the page is archived or gone, or the run has no key.
 */
export const sendPageStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.sendPage),
  pageId: z.string().optional(),
  ttlHours: z.number().int().min(TTL_MIN_HOURS).max(TTL_MAX_HOURS).optional(),
  states: z.tuple([successStateSchema, errorStateSchema]),
})
export type SendPageStepSchema = z.infer<typeof sendPageStepSchema>

export const sendPageStepDefaultFn = (): SendPageStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.sendPage,
  pageId: undefined,
  ttlHours: undefined,
  states: [successStateDefaultFn(), errorStateDefaultFn()],
})
