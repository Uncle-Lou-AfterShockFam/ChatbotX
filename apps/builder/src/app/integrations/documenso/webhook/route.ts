import {
  documentSigningService,
  readCapped,
  verifyDocumensoSecret,
} from "@chatbotx.io/business/documents"
import { NextResponse } from "next/server"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"
import { UNKNOWN_CLIENT_IP } from "@/lib/rate-limit/guest-rate-limit"

/**
 * Documenso webhook (roadmap B6 in the hub). Documenso echoes the configured
 * secret VERBATIM in `X-Documenso-Secret` (no HMAC, no timestamp), so the
 * secret only gets a request in the door: the service confirms every
 * completion with Documenso itself before a contact is marked signed, and
 * dedups on the document row. Fail closed: no configured secret = 404.
 * A transient failure answers 503 so Documenso redelivers; every other
 * outcome is final (200), so a stray or foreign event is not retried forever.
 */
export const MAX_DOCUMENSO_WEBHOOK_BYTES = 64 * 1024

/**
 * Per-IP, per 10 s window (the limiter's fixed window). A 429 is TERMINAL
 * for Documenso: with the local jobs provider it retries a failed delivery
 * 4 times back-to-back within a second, ignores Retry-After, then gives up
 * until a human resends. So the cap must sit far above any legitimate burst,
 * including the hub's own 503 answers being retried 4x: 600 covers 150
 * completions per window (every event of a 100-contact send if the
 * subscription is ever widened beyond document.completed) and still cuts a
 * single-IP flood at 60 req/s, each costing one constant-time compare and a
 * <= 64 KB capped read. Per-IP rather than per-document because a
 * per-document key would 429 Documenso's own retries of one completion.
 */
export const DOCUMENSO_WEBHOOK_RATE_LIMIT = 600

/**
 * The limiter key is the RIGHTMOST `X-Forwarded-For` hop: the value the
 * proxy in front of the app wrote from the connection it accepted. A caller
 * cannot set it, whether that proxy appends to an inbound header (the
 * client's values sit to the left) or overwrites it (there is only one).
 * The leftmost hop, which `getGuestClientIp` trusts, is client-supplied and
 * would let a flood rotate its key or pin Documenso's egress IP.
 */
export const documensoWebhookRateLimitKey = (headers: Headers): string => {
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean)
  return hops.at(-1) ?? headers.get("x-real-ip")?.trim() ?? UNKNOWN_CLIENT_IP
}

export async function POST(request: Request) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "documenso-webhook-rate-limit",
    key: documensoWebhookRateLimitKey(request.headers),
    limit: DOCUMENSO_WEBHOOK_RATE_LIMIT,
  })
  if (limited) {
    return NextResponse.json(
      { code: "tooManyRequests" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    )
  }
  const auth = verifyDocumensoSecret(request.headers.get("x-documenso-secret"))
  if (auth === "not-configured") {
    return NextResponse.json({ code: "notFound" }, { status: 404 })
  }
  if (auth !== "ok") {
    return NextResponse.json({ code: "unauthorized" }, { status: 401 })
  }
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_DOCUMENSO_WEBHOOK_BYTES) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  // Byte cap while streaming: a chunked body without content-length must
  // not be buffered whole before it is refused.
  const bytes = await readCapped(request, MAX_DOCUMENSO_WEBHOOK_BYTES)
  if (bytes === null) {
    return NextResponse.json({ code: "payloadTooLarge" }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return NextResponse.json({ code: "badRequest" }, { status: 400 })
  }

  let result: Awaited<
    ReturnType<typeof documentSigningService.completeFromWebhook>
  >
  try {
    result = await documentSigningService.completeFromWebhook({ body })
  } catch (error) {
    logger.error(error, "documenso webhook failed; Documenso will redeliver")
    return NextResponse.json({ code: "retry" }, { status: 503 })
  }
  if (result.outcome === "retry") {
    logger.warn(`documenso webhook will be retried: ${result.detail}`)
    return NextResponse.json(result, { status: 503 })
  }
  if (result.outcome === "unconfirmed") {
    logger.warn(`documenso webhook unconfirmed: ${result.detail}`)
  }
  return NextResponse.json(result, { status: 200 })
}
