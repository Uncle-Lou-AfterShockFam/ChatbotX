import {
  MAX_REPLY_REASON,
  replyClassManualClasses,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const classifyReplyPublicRequest = z.object({
  class: replyClassManualClasses.describe(
    "The contact's answer: interested (opens or moves the outreach deal to Interested), maybeLater (to Maybe later) or notInterested (moves an open deal to Not interested).",
  ),
  reason: z
    .string()
    .max(MAX_REPLY_REASON)
    .optional()
    .describe("One line on why (shown with the classification)."),
  sequenceId: zodBigintAsString()
    .optional()
    .describe(
      "The outreach sequence it is for, when the contact is in several; omitted = the one the contact most recently answered.",
    ),
})

const classificationResource = z.object({
  id: z.string(),
  class: z
    .string()
    .describe(
      "interested, maybeLater, notInterested (an operator's), or ooo, auto, bounce (the email line's rules).",
    ),
  source: z.string().describe("manual or rule."),
  reason: z.string().nullable(),
  sequenceId: z
    .string()
    .nullable()
    .describe("The outreach sequence it was made for."),
  dealId: z.string().nullable().describe("The deal it opened or moved."),
  createdAt: z.iso.datetime(),
})

export type ClassificationResource = z.infer<typeof classificationResource>

export const classifyReplyPublicResponse = z.object({
  data: classificationResource,
})

export const listReplyClassificationsPublicResponse = z.object({
  data: z.array(classificationResource),
})

export const toClassificationResource = (row: {
  id: string
  class: string
  source: string
  reason: string | null
  sequenceId: string | null
  dealId: string | null
  createdAt: Date
}) => ({
  id: row.id,
  class: row.class,
  source: row.source,
  reason: row.reason,
  sequenceId: row.sequenceId,
  dealId: row.dealId,
  createdAt: row.createdAt.toISOString(),
})
