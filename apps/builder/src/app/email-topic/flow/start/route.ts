import { NextResponse } from "next/server"
import { startEmailFlowByToken } from "@/lib/email-flow/start-by-token"

/**
 * B2 phase 4 (s222b): the confirm form on /email-topic/flow posts here. Only
 * POST acts (a scanner's GET must never start a flow for someone), and only a
 * form carrying `source=page`. Redirects back to the page's result view.
 */
/** The confirm form's body is ~12 bytes. */
const MAX_BODY_BYTES = 1024

/**
 * The body, read with a cap on the bytes actually received: a declared
 * Content-Length is only an early refusal, since a chunked request has none
 * (skeptic s222b). Null past the cap.
 */
async function readCappedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
    return null
  }
  if (!request.body) {
    return ""
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const token = url.searchParams.get("t")
  const recipient = url.searchParams.get("r")

  const body = await readCappedBody(request)
  if (body === null) {
    return new NextResponse(null, { status: 413 })
  }
  if (new URLSearchParams(body).get("source") !== "page") {
    return new NextResponse(null, { status: 400 })
  }

  const status = await startEmailFlowByToken(token, recipient)
  // Relative Location: behind the proxy request.url may not carry the public
  // scheme/host, and the token must not be sent anywhere else.
  const back = new URLSearchParams({ t: token ?? "", result: status })
  if (recipient) {
    back.set("r", recipient)
  }
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/email-topic/flow?${back.toString()}` },
  })
}
