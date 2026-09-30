import { resolveTenantSettings } from "@chatbotx.io/business"
import { pageMessageHtml, pageService } from "@chatbotx.io/business/page"
import { contactDocumentVariables } from "@chatbotx.io/variables"
import { NextResponse } from "next/server"
import { documensoWebhookRateLimitKey as proxyHopRateLimitKey } from "@/app/integrations/documenso/webhook/route"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"
import { isLinkPrefetch } from "@/lib/tracked-link/prefetch"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * A custom page (roadmap B4, s227a): `/p/<token>`, texted or emailed to one
 * contact by the `sendPage` flow step. The 22-character token (128 random
 * bits) is the only credential; the page renders with the contact's CURRENT
 * data until the link expires (410). Unknown or malformed is 404; an
 * expired link, an archived page or a frozen workspace is 410. Refusal pages
 * never name the page or the contact. A link-preview fetch renders the page
 * but is not counted as a view.
 */
type RouteContext = { params: Promise<{ token: string }> }

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Per proxy-hop IP per 10 s window: each render is several DB reads. */
export const PAGE_LINK_RATE_LIMIT = 60

/**
 * No script at all; images from any https host (a document image may be an
 * external URL); links leave the page, never post from it.
 */
export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy":
    "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
}

const message = (status: number, title: string, body: string) =>
  new NextResponse(pageMessageHtml({ title, body }), {
    status,
    headers: PAGE_HEADERS,
  })

const notFound = () => message(404, "Page not found", "This link is not valid.")
const closed = () =>
  message(410, "Link expired", "This page is no longer available.")

export async function GET(request: Request, context: RouteContext) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "page-link-rate-limit",
    key: proxyHopRateLimitKey(request.headers),
    limit: PAGE_LINK_RATE_LIMIT,
  })
  if (limited) {
    return NextResponse.json(
      { code: "tooManyRequests" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    )
  }
  const { token } = await context.params
  try {
    const view = await pageService.resolveView({ token })
    if (!view.ok) {
      return view.reason === "invalid" || view.reason === "not-found"
        ? notFound()
        : closed()
    }
    const { servable } = await loadServableWorkspace(view.link.workspaceId)
    if (!servable) {
      return closed()
    }
    const { appUrl } = await resolveTenantSettings({
      workspaceId: view.link.workspaceId,
    })
    const { html } = await pageService.renderView({
      view,
      appUrl,
      resolveVariables: contactDocumentVariables(view.link.contactId),
    })
    if (!isLinkPrefetch(request)) {
      await pageService.recordView({ linkId: view.link.id })
    }
    return new NextResponse(html, { status: 200, headers: PAGE_HEADERS })
  } catch (error) {
    logger.error(error, `page link failed for token ${token.slice(0, 4)}...`)
    return message(
      503,
      "Page unavailable",
      "This page cannot be shown right now. Please try again in a few minutes.",
    )
  }
}
