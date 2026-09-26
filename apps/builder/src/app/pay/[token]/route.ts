import { escapeHtml } from "@chatbotx.io/business/documents"
import { visitCheckout } from "@chatbotx.io/business/invoice"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { NextResponse } from "next/server"
import { documensoWebhookRateLimitKey as proxyHopRateLimitKey } from "@/app/integrations/documenso/webhook/route"
import { logger } from "@/lib/log"
import { checkApiRateLimit } from "@/lib/rate-limit/api-rate-limit"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * The stable pay link of a stripeCheckout invoice (s207b): `/pay/<token>`,
 * texted or emailed to the person. The 22-character token (128 random bits)
 * is the only credential. Each visit is sent (303) to the invoice's ONE live
 * Stripe Checkout Session, minted when there is none; a paid, closed or
 * processing invoice gets a small page instead, never a new session.
 */
type RouteContext = { params: Promise<{ token: string }> }

/** Per proxy-hop IP per 10 s window: each miss can cost Stripe calls. */
export const PAY_LINK_RATE_LIMIT = 60

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
}

const invoiceLabel = (invoice: InvoiceModel) =>
  `Invoice #${invoice.number} (${invoice.total} ${invoice.currency})`

export const payPage = (props: {
  status: number
  title: string
  body: string
  invoice?: InvoiceModel
  /** A same-site path shown as a link under the text (the receipt PDF). */
  link?: { href: string; label: string }
}) => {
  const heading = props.invoice ? invoiceLabel(props.invoice) : props.title
  const link = props.link
    ? `<p class="link"><a href="${escapeHtml(props.link.href)}">${escapeHtml(props.link.label)}</a></p>`
    : ""
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(props.title)}</title><style>body{font-family:system-ui,-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:48px 16px;background:#f6f7f9;color:#111}main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{margin:0;line-height:1.5;color:#444}.link{margin-top:16px}a{color:#1d4ed8}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(props.body)}</p>${link}</main></body></html>`
  return new NextResponse(html, { status: props.status, headers: PAGE_HEADERS })
}

const notFound = () =>
  payPage({
    status: 404,
    title: "Link not found",
    body: "This payment link is not valid.",
  })

export async function GET(request: Request, context: RouteContext) {
  const { limited, retryAfter } = await checkApiRateLimit({
    scope: "invoice-pay-link-rate-limit",
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
  let visit: Awaited<ReturnType<typeof visitCheckout>>
  try {
    visit = await visitCheckout(token, {
      canServe: async (workspaceId) =>
        (await loadServableWorkspace(workspaceId)).servable,
    })
  } catch (error) {
    logger.error(error, `pay link failed for token ${token.slice(0, 4)}...`)
    return payPage({
      status: 503,
      title: "Payment unavailable",
      body: "Payments are not available right now. Please try again in a few minutes.",
    })
  }
  switch (visit.kind) {
    case "notFound":
      return notFound()
    case "frozen":
      return payPage({
        status: 410,
        title: "Link closed",
        body: "This payment link is no longer available.",
      })
    case "redirect":
      return NextResponse.redirect(visit.url, {
        status: 303,
        headers: { "Cache-Control": "private, no-store" },
      })
    case "paid":
      return payPage({
        status: 200,
        title: "Paid",
        body: "This invoice is paid. Thank you!",
        invoice: visit.invoice,
        // A refunded invoice reads "paid" here but has no receipt document.
        link:
          visit.invoice.status === "paid"
            ? { href: `/pay/${token}/pdf`, label: "Download receipt (PDF)" }
            : undefined,
      })
    case "processing":
      return payPage({
        status: 200,
        title: "Payment received",
        body: "Your payment was received and is being confirmed. Thank you!",
        invoice: visit.invoice,
      })
    case "closed":
      return payPage({
        status: 410,
        title: "Invoice closed",
        body: "This invoice is no longer payable.",
        invoice: visit.invoice,
      })
    default:
      return payPage({
        status: 503,
        title: "Payment unavailable",
        body: "Payments are not available right now. Please try again in a few minutes.",
        invoice: visit.invoice,
      })
  }
}
