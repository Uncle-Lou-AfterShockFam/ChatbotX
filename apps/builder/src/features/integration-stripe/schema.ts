import { STRIPE_SECRET_KEY_PATTERN } from "@chatbotx.io/database/partials"
import { z } from "zod"

/** The connect dialog's field is named `apiKey` (shared API-key dialog). */
export const connectStripeSchema = z
  .object({
    apiKey: z.string().trim().regex(STRIPE_SECRET_KEY_PATTERN, {
      message: "Paste a Stripe secret key (sk_test_... or sk_live_...)",
    }),
  })
  .strict()
