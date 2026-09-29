import {
  isWorkspaceScheduledForDeletion,
  workspaceService,
} from "@chatbotx.io/business"
import { formService, type NormalizedForm } from "@chatbotx.io/business/form"
import { FORM_SLUG_REGEX } from "@chatbotx.io/database/partials"
import { getPublicOriginFromRequest } from "@chatbotx.io/utils"
import { type NextRequest, NextResponse } from "next/server"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * The gates every public form POST shares (s200 submit, s224a start beacon):
 * int8 workspace + slug shape, a Content-Length cap, a servable workspace
 * not scheduled for deletion, a PUBLISHED web form, then CORS. The body is
 * read only after the caller's rate limit, capped by `readBodyCapped`.
 */
export const MAX_FORM_BODY_BYTES = 64 * 1024
const INT8 = /^\d{1,19}$/
const INT8_MAX = 2n ** 63n - 1n
const isInt8 = (v: string) => INT8.test(v) && BigInt(v) <= INT8_MAX

/**
 * Read at most `max` bytes of the body; a lying or missing Content-Length
 * cannot make us buffer more than that (skeptic, s200). Returns null when
 * the cap is exceeded.
 */
export async function readBodyCapped(
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

export const formCorsHeaders = (origin: string | null, allowed: boolean) => {
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

export const formJson = (body: unknown, status: number, headers: Headers) =>
  NextResponse.json(body, { status, headers })

/** RFC 9110 delta-seconds: a non-negative integer, whatever the limiter said. */
export const retryAfterSeconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : 60

export type FormRouteParams = {
  params: Promise<{ workspaceId: string; slug: string }>
}

/** Preflight cannot know the form yet: reflect permissively here, enforce on POST. */
export const formPreflight = (req: NextRequest) =>
  new NextResponse(null, {
    status: 204,
    headers: formCorsHeaders(req.headers.get("origin"), true),
  })

export type PublicFormGate =
  | { kind: "refused"; response: NextResponse }
  | {
      kind: "open"
      workspaceId: string
      slug: string
      form: NormalizedForm
      headers: Headers
    }

/** Run the shared gates in order; the first refusal answers. */
export async function openPublicForm(
  req: NextRequest,
  ctx: FormRouteParams,
): Promise<PublicFormGate> {
  const origin = req.headers.get("origin")
  const closed = formCorsHeaders(origin, false)
  const refuse = (status: number, headers = closed): PublicFormGate => ({
    kind: "refused",
    response: formJson({ ok: false, errors: [] }, status, headers),
  })
  const { workspaceId, slug } = await ctx.params
  if (!(isInt8(workspaceId) && FORM_SLUG_REGEX.test(slug))) {
    return refuse(404)
  }
  const length = Number(req.headers.get("content-length") ?? 0)
  if (length > MAX_FORM_BODY_BYTES) {
    return refuse(413)
  }

  const { servable } = await loadServableWorkspace(workspaceId)
  if (!servable) {
    return refuse(404)
  }
  const workspace = await workspaceService.find({
    where: { id: workspaceId },
  })
  if (!workspace || isWorkspaceScheduledForDeletion(workspace)) {
    return refuse(404)
  }

  const form = await formService.findPublishedBySlug({ workspaceId, slug })
  if (!form) {
    return refuse(404)
  }
  // Same-origin = the PUBLIC origin Caddy forwards, never `req.nextUrl`
  // (that is `builder:3000` behind the proxy: the embedded page's own POST
  // was a 403 in the live proof, s200).
  const allowed =
    origin === null ||
    origin === getPublicOriginFromRequest(req) ||
    origin === req.nextUrl.origin ||
    form.settings.embedOrigins.includes(origin)
  const headers = formCorsHeaders(origin, allowed)
  if (!allowed) {
    return refuse(403, headers)
  }
  return { kind: "open", workspaceId, slug, form, headers }
}
