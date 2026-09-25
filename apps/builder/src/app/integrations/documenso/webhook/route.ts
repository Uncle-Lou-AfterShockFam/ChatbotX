import {
  documentSigningService,
  readCapped,
  verifyDocumensoSecret,
} from "@chatbotx.io/business/documents"
import { NextResponse } from "next/server"
import { logger } from "@/lib/log"

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

export async function POST(request: Request) {
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
