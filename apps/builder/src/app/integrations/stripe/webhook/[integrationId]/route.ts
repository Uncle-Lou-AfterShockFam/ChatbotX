import { readCapped } from "@chatbotx.io/business/documents"
import { handleStripeWebhook } from "@chatbotx.io/business/invoice"
import { NextResponse } from "next/server"
import { documensoWebhookRateLimitKey as proxyHopRateLimitKey } from "@/app/integrations/documenso/webhook/route"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"

/**
 * A workspace's own Stripe account posts here (hub invoicing, s205b). The
 * path names the workspace integration; the RAW body is verified with that
 * integration's `whsec_` (`Stripe-Signature`, 300 s tolerance) before
 * anything is parsed, and every state change is re-confirmed against the
 * Stripe API. 503 = Stripe redelivers (it retries with backoff for 3 days);
 * 200 = final; 400 = bad signature / mode; 404 = no such integration.
 */
export const MAX_STRIPE_WEBHOOK_BYTES = 256 * 1024

/** Per proxy-hop IP per 10 s window; Stripe backs off on a 429. */
export const STRIPE_WEBHOOK_RATE_LIMIT = 600

const STATUS = {
  applied: 200,
  noop: 200,
  duplicate: 200,
  ignored: 200,
  retry: 503,
  rejected: 400,
  unknown: 404,
} as const

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> },
) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "stripe-webhook-rate-limit",
    key: proxyHopRateLimitKey(request.headers),
    limit: STRIPE_WEBHOOK_RATE_LIMIT,
  })
  if (limited) {
    return NextResponse.json(
      { code: "tooManyRequests" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    )
  }
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_STRIPE_WEBHOOK_BYTES) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  const bytes = await readCapped(request, MAX_STRIPE_WEBHOOK_BYTES)
  if (bytes === null) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  const { integrationId } = await params
  let result: Awaited<ReturnType<typeof handleStripeWebhook>>
  try {
    result = await handleStripeWebhook({
      integrationId,
      rawBody: Buffer.from(bytes),
      signature: request.headers.get("stripe-signature"),
    })
  } catch (error) {
    logger.error(error, "stripe webhook failed; Stripe will redeliver")
    return NextResponse.json({ code: "retry" }, { status: 503 })
  }
  if (result.outcome === "retry") {
    logger.warn(`stripe webhook will be retried: ${result.detail}`)
  }
  return NextResponse.json(
    { outcome: result.outcome },
    { status: STATUS[result.outcome] },
  )
}
