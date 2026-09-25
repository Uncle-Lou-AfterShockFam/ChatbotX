import {
  isWorkspaceScheduledForDeletion,
  workspaceService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { formService, formSubmitService } from "@chatbotx.io/business/form"
import { FORM_SLUG_REGEX } from "@chatbotx.io/database/partials"
import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { logger } from "@/lib/log"
import { checkFormRateLimit } from "@/lib/rate-limit/form-rate-limit"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * Public form submit (s200): `POST /api/forms/<workspaceId>/<slug>/submit`.
 * No session. CORS reflects the request origin only when it is one of the
 * form's `embedOrigins` (an embedded iframe posts from its own origin, so
 * the same-origin page needs no CORS at all). The body is a closed object;
 * the business pipeline does the rest and answers with a typed result.
 */
const MAX_BODY_BYTES = 64 * 1024
const INT8 = /^\d{1,19}$/
const INT8_MAX = 2n ** 63n - 1n
const isInt8 = (v: string) => INT8.test(v) && BigInt(v) <= INT8_MAX

/**
 * Read at most `max` bytes of the body; a lying or missing Content-Length
 * cannot make us buffer more than that (skeptic, s200). Returns null when
 * the cap is exceeded.
 */
async function readBodyCapped(
  req: NextRequest,
  max: number,
): Promise<string | null> {
  const reader = req.body?.getReader()
  if (!reader) {
    return ""
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

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
    timezone: z.string().max(64).optional(),
  })
  .strict()

const corsHeaders = (origin: string | null, allowed: boolean) => {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    Vary: "Origin",
  })
  if (allowed && origin) {
    headers.set("Access-Control-Allow-Origin", origin)
  }
  return headers
}

const json = (body: unknown, status: number, headers: Headers) =>
  NextResponse.json(body, { status, headers })

/** RFC 9110 delta-seconds: a non-negative integer, whatever the limiter said. */
const retryAfterSeconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : 60

type Params = { params: Promise<{ workspaceId: string; slug: string }> }

export function OPTIONS(req: NextRequest) {
  // Preflight cannot know the form yet: reflect permissively here, enforce on POST.
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin"), true),
  })
}

export async function POST(req: NextRequest, ctx: Params) {
  const origin = req.headers.get("origin")
  const closed = corsHeaders(origin, false)
  try {
    const { workspaceId, slug } = await ctx.params
    if (!(isInt8(workspaceId) && FORM_SLUG_REGEX.test(slug))) {
      return json({ ok: false, errors: [] }, 404, closed)
    }
    const length = Number(req.headers.get("content-length") ?? 0)
    if (length > MAX_BODY_BYTES) {
      return json({ ok: false, errors: [] }, 413, closed)
    }

    const { servable } = await loadServableWorkspace(workspaceId)
    if (!servable) {
      return json({ ok: false, errors: [] }, 404, closed)
    }
    const workspace = await workspaceService.find({
      where: { id: workspaceId },
    })
    if (!workspace || isWorkspaceScheduledForDeletion(workspace)) {
      return json({ ok: false, errors: [] }, 404, closed)
    }

    const form = await formService.findPublishedBySlug({ workspaceId, slug })
    if (!form) {
      return json({ ok: false, errors: [] }, 404, closed)
    }
    const allowed =
      origin === null ||
      origin === req.nextUrl.origin ||
      form.settings.embedOrigins.includes(origin)
    const headers = corsHeaders(origin, allowed)
    if (!allowed) {
      return json({ ok: false, errors: [] }, 403, headers)
    }

    const clientIp = getGuestClientIp(req.headers)
    const limit = await checkFormRateLimit({ formId: form.id, clientIp })
    if (limit.limited) {
      const retryAfter = retryAfterSeconds(limit.retryAfter)
      headers.set("Retry-After", String(retryAfter))
      return json({ ok: false, errors: [], retryAfter }, 429, headers)
    }

    const raw = await readBodyCapped(req, MAX_BODY_BYTES)
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
    })
    switch (result.kind) {
      case "notFound":
        return json({ ok: false, errors: [] }, 404, headers)
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
