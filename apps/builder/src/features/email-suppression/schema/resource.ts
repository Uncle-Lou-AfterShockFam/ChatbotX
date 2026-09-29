import {
  EMAIL_SUPPRESSION_MAX_LENGTH,
  emailSuppressionKinds,
  emailSuppressionReasons,
} from "@chatbotx.io/database/partials"
import z from "zod"

export const emailSuppressionResource = z.object({
  id: z.string(),
  value: z.string(),
  kind: emailSuppressionKinds,
  reason: emailSuppressionReasons,
  source: z.string().nullable(),
  createdAt: z.date(),
})
export type EmailSuppressionResource = z.infer<typeof emailSuppressionResource>

/**
 * The request body; `value` is parsed by the service with
 * `parseEmailSuppression` (ONE validator), this layer only bounds the shape.
 */
export const emailSuppressionData = z
  .object({
    value: z
      .string()
      .max(EMAIL_SUPPRESSION_MAX_LENGTH + 16)
      .describe(
        "An email address (name@example.com) or a domain (@example.com).",
      ),
  })
  .strict()

export const emailSuppressionListQuery = z.object({
  cursor: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
