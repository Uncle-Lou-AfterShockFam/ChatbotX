import { visitInvoicePdf } from "@chatbotx.io/business/invoice"
import { NextResponse } from "next/server"
import { documentFileName } from "@/app/f/[token]/route"
import { documensoWebhookRateLimitKey as proxyHopRateLimitKey } from "@/app/integrations/documenso/webhook/route"
import { PAY_LINK_RATE_LIMIT, payPage } from "@/app/pay/[token]/route"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * The hub's PDF of a stripeCheckout invoice (s210b): `/pay/<token>/pdf`, the
 * same credential as the pay link. Open -> the invoice, paid -> the receipt;
 * rendered once and stored on the contact, served from here (never a
 * redirect to storage). Never touches Stripe.
 * The link does not expire (unlike the row's own 30-day `/f/<token>`): a
 * receipt must stay reachable from the pay link the person already has; it
 * stops when the invoice leaves open/paid (void, refunded) or is deleted.
 */
type RouteContext = { params: Promise<{ token: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "invoice-pdf-rate-limit",
    key: proxyHopRateLimitKey(request.headers),
    limit: PAY_LINK_RATE_LIMIT,
  })
  if (limited) {
    return NextResponse.json(
      { code: "tooManyRequests" },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    )
  }
  const { token } = await context.params
  let visit: Awaited<ReturnType<typeof visitInvoicePdf>>
  try {
    visit = await visitInvoicePdf(token, {
      canServe: async (workspaceId) =>
        (await loadServableWorkspace(workspaceId)).servable,
    })
  } catch (error) {
    logger.error(error, `invoice pdf failed for token ${token.slice(0, 4)}...`)
    const response = payPage({
      status: 503,
      title: "PDF unavailable",
      body: "This document is not available right now. Please try again in a few minutes.",
    })
    response.headers.set("retry-after", "60")
    return response
  }
  if (visit.kind === "notFound") {
    return payPage({
      status: 404,
      title: "Document not found",
      body: "There is no document for this link.",
    })
  }
  if (visit.kind === "frozen") {
    return payPage({
      status: 410,
      title: "Link closed",
      body: "This link is no longer available.",
    })
  }
  return new NextResponse(new Uint8Array(visit.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(visit.pdf.length),
      "Content-Disposition": `inline; filename="${documentFileName(visit.title)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  })
}
