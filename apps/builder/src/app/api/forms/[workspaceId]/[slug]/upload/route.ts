import { ChatbotXException } from "@chatbotx.io/business/errors"
import { formUploadField, formUploadService } from "@chatbotx.io/business/form"
import {
  EMPTY_FORM_DEFINITION,
  FORM_UPLOAD_MAX_BYTES,
  formUploadMaxBytes,
} from "@chatbotx.io/database/partials"
import type { NextRequest } from "next/server"
import { z } from "zod"
import {
  type FormRouteParams,
  formCorsHeaders,
  formPreflight,
  formJson as json,
  openPublicForm,
  readBodyBytesCapped,
  retryAfterSeconds,
} from "@/lib/forms/public-form-request"
import { logger } from "@/lib/log"
import {
  checkFormUploadFormRateLimit,
  checkFormUploadIpRateLimit,
} from "@/lib/rate-limit/form-rate-limit"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"

/**
 * One private web form upload (s225a A2-4 PR 5):
 * `POST /api/forms/<workspaceId>/<slug>/upload?field=<key>&v=<uuid>&name=<file name>`
 * with the file's raw bytes as the body (no multipart). The gates are the
 * submit route's, behind a per-ip limit that runs before any database
 * lookup; the body is read capped at the FIELD's limit, and what it is comes
 * from its magic bytes, never `Content-Type` or `name`. Answers the opaque
 * `uploadId` the page puts in the field's value; the submit claims it for
 * the same page load (`v`).
 */
export const uploadFormQuery = z
  .object({
    field: z.string().min(1).max(40),
    v: z.uuid(),
    name: z.string().max(255).optional(),
  })
  .strict()

export const OPTIONS = formPreflight

export async function POST(req: NextRequest, ctx: FormRouteParams) {
  const closed = formCorsHeaders(req.headers.get("origin"), false)
  try {
    const clientIp = getGuestClientIp(req.headers)
    const ipLimit = await checkFormUploadIpRateLimit({ clientIp })
    if (ipLimit.limited) {
      const retryAfter = retryAfterSeconds(ipLimit.retryAfter)
      closed.set("Retry-After", String(retryAfter))
      return json({ ok: false, errors: [], retryAfter }, 429, closed)
    }
    const gate = await openPublicForm(req, ctx, FORM_UPLOAD_MAX_BYTES)
    if (gate.kind === "refused") {
      return gate.response
    }
    const { form, headers } = gate

    const limit = await checkFormUploadFormRateLimit({ formId: form.id })
    if (limit.limited) {
      const retryAfter = retryAfterSeconds(limit.retryAfter)
      headers.set("Retry-After", String(retryAfter))
      return json({ ok: false, errors: [], retryAfter }, 429, headers)
    }

    const query = uploadFormQuery.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    )
    if (!query.success) {
      return json({ ok: false, errors: [] }, 400, headers)
    }
    const field = formUploadField(
      form.publishedDefinition ?? EMPTY_FORM_DEFINITION,
      query.data.field,
    )
    if (field === null) {
      return json({ ok: false, errors: [] }, 400, headers)
    }
    const bytes = await readBodyBytesCapped(req, formUploadMaxBytes(field))
    if (bytes === null) {
      return json(
        { ok: false, errors: [{ key: field.key, code: "uploadSize" }] },
        413,
        headers,
      )
    }

    const result = await formUploadService.store({
      form,
      fieldKey: field.key,
      interactionId: query.data.v,
      clientIp,
      bytes,
      fileName: query.data.name,
    })
    switch (result.kind) {
      case "ok":
        return json(
          {
            ok: true,
            uploadId: result.uploadId,
            name: result.fileName,
            size: result.sizeBytes,
          },
          200,
          headers,
        )
      case "invalid":
        return json(
          { ok: false, errors: [{ key: field.key, code: result.code }] },
          result.code === "uploadSize" ? 413 : 400,
          headers,
        )
      case "rateLimited":
        headers.set("Retry-After", "3600")
        return json({ ok: false, errors: [], retryAfter: 3600 }, 429, headers)
      default:
        return result satisfies never
    }
  } catch (error) {
    logger.error({ err: error }, "form upload: unhandled error")
    const status =
      error instanceof ChatbotXException && error.httpStatusCode >= 400
        ? error.httpStatusCode
        : 500
    return json({ ok: false, errors: [] }, status, closed)
  }
}
