import { readCapped } from "@chatbotx.io/business/documents"
import { handleQuickbooksWebhook } from "@chatbotx.io/business/invoice"
import { NextResponse } from "next/server"
import { documensoWebhookRateLimitKey as proxyHopRateLimitKey } from "@/app/integrations/documenso/webhook/route"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"

/**
 * Intuit posts EVERY connected company's changes to this one URL (s214b),
 * signed with the platform app's verifier token (`intuit-signature` over
 * the raw body). It must answer 200 within 3 s: the handler only verifies,
 * parses and queues; the jobs read QBO. 401 = bad signature, 503 = retry.
 */
export const MAX_QUICKBOOKS_WEBHOOK_BYTES = 256 * 1024

/** Per proxy-hop IP per 10 s window. */
export const QUICKBOOKS_WEBHOOK_RATE_LIMIT = 600

export async function POST(request: Request) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "quickbooks-webhook-rate-limit",
    key: proxyHopRateLimitKey(request.headers),
    limit: QUICKBOOKS_WEBHOOK_RATE_LIMIT,
  })
  if (limited) {
    return NextResponse.json(
      { code: "tooManyRequests" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    )
  }
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_QUICKBOOKS_WEBHOOK_BYTES) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  const bytes = await readCapped(request, MAX_QUICKBOOKS_WEBHOOK_BYTES)
  if (bytes === null) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  let result: Awaited<ReturnType<typeof handleQuickbooksWebhook>>
  try {
    result = await handleQuickbooksWebhook({
      rawBody: Buffer.from(bytes),
      signature: request.headers.get("intuit-signature"),
    })
  } catch (error) {
    logger.error(error, "quickbooks webhook failed; Intuit will retry")
    return NextResponse.json({ code: "retry" }, { status: 503 })
  }
  if (result.status !== 200) {
    logger.warn(`quickbooks webhook answered ${result.status}`)
  }
  return NextResponse.json(
    { ok: result.status === 200, queued: result.queued },
    { status: result.status },
  )
}
