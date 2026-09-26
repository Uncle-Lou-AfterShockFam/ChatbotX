// biome-ignore lint/style/noExportedImports: the one place callers get the SDK class (errors, Decimal, types), pinned to this client
import Stripe from "stripe"

export {
  STRIPE_SECRET_KEY_PATTERN,
  STRIPE_WEBHOOK_SECRET_PATTERN,
} from "@chatbotx.io/database/partials"

/**
 * Every hub call to a workspace's Stripe account goes through here, so the
 * API version, timeout and retry policy are pinned in one place. The SDK
 * retries idempotent requests itself; every mutating hub call ALSO passes an
 * explicit Idempotency-Key so a job retry cannot duplicate a Stripe object.
 */
export const STRIPE_API_VERSION = "2026-05-27.dahlia" as const

const STRIPE_TIMEOUT_MS = 20_000

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: 2,
    appInfo: { name: "chatbotx-hub-invoicing" },
  })
}

/** The webhook events the hub subscribes each workspace endpoint to. */
export const STRIPE_WEBHOOK_EVENTS = [
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "charge.refunded",
  // v2 (s207b, stripeCheckout)
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[]

/**
 * Bump with every change to `STRIPE_WEBHOOK_EVENTS`: an endpoint subscribed
 * under an older version is updated in place (`ensureWebhookEvents`).
 */
export const STRIPE_WEBHOOK_EVENTS_VERSION = 2

/** Signature tolerance for `constructEvent` (Stripe's default, stated). */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300

export { Stripe }
