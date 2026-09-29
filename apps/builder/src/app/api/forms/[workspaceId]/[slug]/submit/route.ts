import { ChatbotXException } from "@chatbotx.io/business/errors"
import { formSubmitService } from "@chatbotx.io/business/form"
import type { NextRequest } from "next/server"
import { z } from "zod"
import {
  type FormRouteParams,
  formCorsHeaders,
  formPreflight,
  formJson as json,
  MAX_FORM_BODY_BYTES,
  openPublicForm,
  readBodyCapped,
  retryAfterSeconds,
} from "@/lib/forms/public-form-request"
import { logger } from "@/lib/log"
import { checkFormRateLimit } from "@/lib/rate-limit/form-rate-limit"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"

/**
 * Public form submit (s200): `POST /api/forms/<workspaceId>/<slug>/submit`.
 * No session. CORS reflects the request origin only when it is one of the
 * form's `embedOrigins` (an embedded iframe posts from its own origin, so
 * the same-origin page needs no CORS at all). The body is a closed object;
 * the business pipeline does the rest and answers with a typed result.
 * The shared gates live in `openPublicForm`.
 */

export const submitFormRequest = z
  .object({
    values: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        z.union([
          z.string().max(2000),
          z.number(),
          z.boolean(),
          z.array(z.string().max(200)).max(50),
        ]),
      )
      .refine((r) => Object.keys(r).length <= 100, "Too many fields"),
    /** The honeypot: a real browser leaves it empty. */
    website: z.string().max(200).optional(),
    /** s220c A2-4: the signed form link's `k`, verified by the pipeline. */
    k: z.string().max(4096).optional(),
    /** s224a A2-4: the page load's id (the start beacon's `v`). */
    v: z.uuid().optional(),
    timezone: z.string().max(64).optional(),
  })
  .strict()

export const OPTIONS = formPreflight

export async function POST(req: NextRequest, ctx: FormRouteParams) {
  const closed = formCorsHeaders(req.headers.get("origin"), false)
  try {
    const gate = await openPublicForm(req, ctx)
    if (gate.kind === "refused") {
      return gate.response
    }
    const { workspaceId, slug, form, headers } = gate

    const clientIp = getGuestClientIp(req.headers)
    const limit = await checkFormRateLimit({ formId: form.id, clientIp })
    if (limit.limited) {
      const retryAfter = retryAfterSeconds(limit.retryAfter)
      headers.set("Retry-After", String(retryAfter))
      return json({ ok: false, errors: [], retryAfter }, 429, headers)
    }

    const raw = await readBodyCapped(req, MAX_FORM_BODY_BYTES)
    if (raw === null) {
      return json({ ok: false, errors: [] }, 413, headers)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return json(
        { ok: false, errors: [{ key: "body", code: "type" }] },
        400,
        headers,
      )
    }
    const parsed = submitFormRequest.safeParse(body)
    if (!parsed.success) {
      return json(
        {
          ok: false,
          errors: parsed.error.issues.map((i) => ({
            key: i.path.map(String).join(".") || "body",
            code: "type",
          })),
        },
        400,
        headers,
      )
    }

    const result = await formSubmitService.submit({
      workspaceId,
      slug,
      values: parsed.data.values,
      honeypotFilled: (parsed.data.website ?? "") !== "",
      clientIp,
      userAgent: req.headers.get("user-agent"),
      sourceTimezone: parsed.data.timezone,
      formLinkToken: parsed.data.k,
      interactionId: parsed.data.v,
    })
    switch (result.kind) {
      case "notFound":
        return json({ ok: false, errors: [] }, 404, headers)
      case "closed":
        // s220c A2-4: outside the window or full. 410 + the form's own words.
        return json(
          {
            ok: false,
            errors: [],
            closed: result.reason,
            message: result.message,
          },
          410,
          headers,
        )
      case "invalid":
        return json({ ok: false, errors: result.issues }, 400, headers)
      case "rateLimited": {
        const retryAfter = retryAfterSeconds(result.retryAfter)
        headers.set("Retry-After", String(retryAfter))
        return json({ ok: false, errors: [], retryAfter }, 429, headers)
      }
      case "ok":
        return json(
          {
            ok: true,
            duplicate: result.duplicate,
            successMessage: result.successMessage,
            redirectUrl: result.redirectUrl,
          },
          200,
          headers,
        )
      default:
        return json({ ok: false, errors: [] }, 500, headers)
    }
  } catch (error) {
    // Anonymous callers never see an internal message (driver text, constraint
    // names): log it, answer a bare status. A ChatbotXException keeps its
    // status so a 422 stays a 422.
    logger.error({ err: error }, "form submit: unhandled error")
    const status =
      error instanceof ChatbotXException && error.httpStatusCode >= 400
        ? error.httpStatusCode
        : 500
    return json({ ok: false, errors: [] }, status, closed)
  }
}
