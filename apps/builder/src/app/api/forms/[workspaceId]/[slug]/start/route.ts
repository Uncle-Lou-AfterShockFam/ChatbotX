import { ChatbotXException } from "@chatbotx.io/business/errors"
import { formVisitService } from "@chatbotx.io/business/form"
import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  type FormRouteParams,
  formCorsHeaders,
  formPreflight,
  formJson as json,
  openPublicForm,
  readBodyCapped,
  retryAfterSeconds,
} from "@/lib/forms/public-form-request"
import { logger } from "@/lib/log"
import {
  checkFormStartFormRateLimit,
  checkFormStartIpRateLimit,
} from "@/lib/rate-limit/form-rate-limit"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"

/**
 * Web abandon beacon (s224a A2-4): `POST /api/forms/<workspaceId>/<slug>/start`
 * with `{ k, v }` (the personal link's token, the page load's id), sent
 * once per page load on the visitor's first interaction. Only a PERSONAL
 * link's visitor opens a visit (the business layer verifies `k` for this
 * workspace + form); the gates and CORS are the submit route's, behind a
 * per-ip limit that runs before any database lookup. A well-formed request
 * answers the same bare 204 whether or not a visit opened; that hides the
 * outcome from the body and status, not from timing (a valid token does
 * more work) nor from a database failure on the valid-token path (500).
 */
const MAX_START_BODY_BYTES = 8 * 1024

export const startFormRequest = z
  .object({ k: z.string().min(1).max(4096), v: z.uuid() })
  .strict()

export const OPTIONS = formPreflight

export async function POST(req: NextRequest, ctx: FormRouteParams) {
  const closed = formCorsHeaders(req.headers.get("origin"), false)
  try {
    const ipLimit = await checkFormStartIpRateLimit({
      clientIp: getGuestClientIp(req.headers),
    })
    if (ipLimit.limited) {
      const retryAfter = retryAfterSeconds(ipLimit.retryAfter)
      closed.set("Retry-After", String(retryAfter))
      return json({ ok: false, errors: [], retryAfter }, 429, closed)
    }
    const gate = await openPublicForm(req, ctx, MAX_START_BODY_BYTES)
    if (gate.kind === "refused") {
      return gate.response
    }
    const { form, headers } = gate

    const limit = await checkFormStartFormRateLimit({ formId: form.id })
    if (limit.limited) {
      const retryAfter = retryAfterSeconds(limit.retryAfter)
      headers.set("Retry-After", String(retryAfter))
      return json({ ok: false, errors: [], retryAfter }, 429, headers)
    }

    const raw = await readBodyCapped(req, MAX_START_BODY_BYTES)
    if (raw === null) {
      return json({ ok: false, errors: [] }, 413, headers)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ ok: false, errors: [] }, 400, headers)
    }
    const parsed = startFormRequest.safeParse(body)
    if (!parsed.success) {
      return json({ ok: false, errors: [] }, 400, headers)
    }

    await formVisitService.start({
      form,
      formLinkToken: parsed.data.k,
      interactionId: parsed.data.v,
    })
    return new NextResponse(null, { status: 204, headers })
  } catch (error) {
    logger.error({ err: error }, "form start: unhandled error")
    const status =
      error instanceof ChatbotXException && error.httpStatusCode >= 400
        ? error.httpStatusCode
        : 500
    return json({ ok: false, errors: [] }, status, closed)
  }
}
