import { readCapped } from "@chatbotx.io/business/documents"
import { handleWooCommerceWebhook } from "@chatbotx.io/business/invoice"
import { NextResponse } from "next/server"
import { documensoWebhookRateLimitKey as proxyHopRateLimitKey } from "@/app/integrations/documenso/webhook/route"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"

/**
 * A linked WordPress site posts a hub invoice's `order.paid` /
 * `order.refunded` here (hub-connector >= 0.6.0, `HUBC_HUB_URL`; s211b). The
 * path names the site's integration; the RAW body is verified with that
 * site's hub-generated `whsec_` (Standard Webhooks, 300 s tolerance) before
 * anything is parsed. The answer is 200 with hub-connector's `reason`
 * (`applied` / `duplicate` / `captured` settle the site's outbox row,
 * `hub-error` retries the same event id, `unverified` / `invalid:*`
 * dead-letter it); 503 = retry.
 */
export const MAX_WOOCOMMERCE_WEBHOOK_BYTES = 64 * 1024

/** Per proxy-hop IP per 10 s window; hub-connector backs off on a 429. */
export const WOOCOMMERCE_WEBHOOK_RATE_LIMIT = 600

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> },
) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "woocommerce-webhook-rate-limit",
    key: proxyHopRateLimitKey(request.headers),
    limit: WOOCOMMERCE_WEBHOOK_RATE_LIMIT,
  })
  if (limited) {
    return NextResponse.json(
      { code: "tooManyRequests" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    )
  }
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_WOOCOMMERCE_WEBHOOK_BYTES) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  const bytes = await readCapped(request, MAX_WOOCOMMERCE_WEBHOOK_BYTES)
  if (bytes === null) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  const { integrationId } = await params
  let result: Awaited<ReturnType<typeof handleWooCommerceWebhook>>
  try {
    result = await handleWooCommerceWebhook({
      integrationId,
      rawBody: Buffer.from(bytes),
      headers: {
        id: request.headers.get("webhook-id"),
        timestamp: request.headers.get("webhook-timestamp"),
        signature: request.headers.get("webhook-signature"),
      },
    })
  } catch (error) {
    logger.error(error, "woocommerce webhook failed; the site will redeliver")
    return NextResponse.json({ code: "retry" }, { status: 503 })
  }
  if (result.reason === "hub-error") {
    logger.warn(`woocommerce webhook will be retried: ${result.detail}`)
  }
  return NextResponse.json(
    { ok: result.reason !== "unverified", reason: result.reason },
    { status: 200 },
  )
}
