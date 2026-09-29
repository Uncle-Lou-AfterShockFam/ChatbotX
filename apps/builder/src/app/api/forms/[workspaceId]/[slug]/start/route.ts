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
import { checkFormStartRateLimit } from "@/lib/rate-limit/form-rate-limit"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"

/**
 * Web abandon beacon (s224a A2-4): `POST /api/forms/<workspaceId>/<slug>/start`
 * with `{ k }`, sent once per page load on the visitor's first interaction.
 * Only a PERSONAL link's visitor opens a visit (the business layer verifies
 * `k` for this workspace + form); the gates and CORS are the submit route's.
 * Every well-formed request answers 204 whether or not a visit opened, so
 * the beacon is no oracle for a token, a contact or the form's state.
 */
const MAX_START_BODY_BYTES = 8 * 1024

export const startFormRequest = z
  .object({ k: z.string().min(1).max(4096) })
  .strict()

export const OPTIONS = formPreflight

export async function POST(req: NextRequest, ctx: FormRouteParams) {
  const closed = formCorsHeaders(req.headers.get("origin"), false)
  try {
    const gate = await openPublicForm(req, ctx)
    if (gate.kind === "refused") {
      return gate.response
    }
    const { form, headers } = gate

    const limit = await checkFormStartRateLimit({
      formId: form.id,
      clientIp: getGuestClientIp(req.headers),
    })
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

    await formVisitService.start({ form, formLinkToken: parsed.data.k })
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
