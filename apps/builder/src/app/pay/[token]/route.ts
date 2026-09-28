import { escapeHtml } from "@chatbotx.io/business/documents"
import {
  amountDueMinor,
  formatInvoiceMinor,
  formatInvoiceMoney,
  visitCheckout,
} from "@chatbotx.io/business/invoice"
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
 *
 * Deposits (s216b): an invoice offering one first shows a choice page. The
 * pick is a POST (`kind=deposit|full`): a GET never picks, so a mail scanner
 * or link preview following links cannot switch (and so expire) the session
 * someone is paying on. After a deposit the same link collects the balance.
 */
type RouteContext = { params: Promise<{ token: string }> }

/** Per proxy-hop IP per 10 s window: each miss can cost Stripe calls. */
export const PAY_LINK_RATE_LIMIT = 60

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
}

const money = (invoice: InvoiceModel, minor: bigint) =>
  formatInvoiceMinor(minor, invoice.currency)

const invoiceLabel = (invoice: InvoiceModel) =>
  `Invoice #${invoice.number} (${formatInvoiceMoney(invoice.total, invoice.currency)})`

export const payPage = (props: {
  status: number
  title: string
  body: string
  invoice?: InvoiceModel
  /** A same-site path shown as a link under the text (the receipt PDF). */
  link?: { href: string; label: string }
  /** Buttons: a link (GET) or, with `kind`, a form POSTing that pick. */
  buttons?: { href: string; label: string; kind?: string }[]
}) => {
  const heading = props.invoice ? invoiceLabel(props.invoice) : props.title
  const link = props.link
    ? `<p class="link"><a href="${escapeHtml(props.link.href)}">${escapeHtml(props.link.label)}</a></p>`
    : ""
  const buttons = (props.buttons ?? [])
    .map((button) =>
      button.kind
        ? `<form method="post" action="${escapeHtml(button.href)}"><input type="hidden" name="kind" value="${escapeHtml(button.kind)}"><button class="btn" type="submit">${escapeHtml(button.label)}</button></form>`
        : `<a class="btn" href="${escapeHtml(button.href)}">${escapeHtml(button.label)}</a>`,
    )
    .join("")
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(props.title)}</title><style>body{font-family:system-ui,-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:48px 16px;background:#f6f7f9;color:#111}main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{margin:0;line-height:1.5;color:#444}.link{margin-top:16px}a{color:#1d4ed8}.btns{margin-top:20px;display:flex;flex-direction:column;gap:10px}form{margin:0}.btn{display:block;box-sizing:border-box;width:100%;text-align:center;padding:12px 16px;border-radius:8px;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;text-decoration:none;font:600 15px system-ui,-apple-system,Helvetica,Arial,sans-serif;cursor:pointer}form+form .btn{background:#fff;color:#1d4ed8}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(props.body)}</p>${buttons ? `<div class="btns">${buttons}</div>` : ""}${link}</main></body></html>`
  return new NextResponse(html, { status: props.status, headers: PAGE_HEADERS })
}

const notFound = () =>
  payPage({
    status: 404,
    title: "Link not found",
    body: "This payment link is not valid.",
  })

export async function GET(request: Request, context: RouteContext) {
  return await visit(request, context, undefined)
}

/** The deposit choice (s216b): a form POST with `kind=deposit|full`. */
export async function POST(request: Request, context: RouteContext) {
  let kind: unknown
  try {
    kind = (await request.formData()).get("kind")
  } catch {
    kind = undefined
  }
  return await visit(request, context, kind)
}

async function visit(
  request: Request,
  context: RouteContext,
  requestedKind: unknown,
) {
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
  const query = new URL(request.url).searchParams
  let visit: Awaited<ReturnType<typeof visitCheckout>>
  try {
    visit = await visitCheckout(token, {
      canServe: async (workspaceId) =>
        (await loadServableWorkspace(workspaceId)).servable,
      requestedKind,
      justPaid: query.get("done") === "1",
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
    case "choose":
      return payPage({
        status: 200,
        title: "Pay invoice",
        body: `Pay a deposit of ${money(visit.invoice, visit.depositMinor)} now and the rest later, or pay the full ${money(visit.invoice, visit.totalMinor)} today.`,
        invoice: visit.invoice,
        buttons: [
          {
            href: `/pay/${token}`,
            kind: "deposit",
            label: `Pay deposit (${money(visit.invoice, visit.depositMinor)})`,
          },
          {
            href: `/pay/${token}`,
            kind: "full",
            label: `Pay in full (${money(visit.invoice, visit.totalMinor)})`,
          },
        ],
        link: { href: `/pay/${token}/pdf`, label: "View invoice (PDF)" },
      })
    case "depositPaid":
      return payPage({
        status: 200,
        title: "Deposit received",
        body: `Thank you! Your deposit was received. The balance of ${money(visit.invoice, amountDueMinor(visit.invoice))} is due; pay it any time from this link.`,
        invoice: visit.invoice,
        buttons: [
          {
            href: `/pay/${token}`,
            label: `Pay the balance (${money(visit.invoice, amountDueMinor(visit.invoice))})`,
          },
        ],
        link: {
          href: `/pay/${token}/pdf`,
          label: "Download deposit receipt (PDF)",
        },
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
