import { db, eq } from "@chatbotx.io/database/client"
import { parseMoneyToMinor } from "@chatbotx.io/database/partials"
import { contactModel } from "@chatbotx.io/database/schema"
import type {
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import {
  postSiteAction,
  type SiteAnswer,
  SiteUnreachableError,
  siteErrorCode,
  siteErrorMessage,
} from "../integration-woocommerce/client"
import type { WooCommerceCredentials } from "../integration-woocommerce/service"
import { InvoiceProviderError } from "./stripe-provider"

const ORDER_ID = /^[1-9]\d{0,19}$/

/** hub-connector's per-line and per-description limits (0.6.0). */
export const WOOCOMMERCE_MAX_LINE_AMOUNT = 10_000
export const WOOCOMMERCE_MAX_DESCRIPTION = 200

/** `Invoice.providerInvoiceId` of a WooCommerce order: unique across sites. */
export const wooCommerceProviderInvoiceId = (
  integrationId: string,
  orderId: string | number,
): string => `wc:${integrationId}:${orderId}`

/** The site-side Idempotency-Key: a finalize retry replays the same order. */
export const wooCommerceIdempotencyKey = (invoiceId: string): string =>
  `hub-invoice:${invoiceId}`

export type OrderInvoiceRequest = {
  contact: { phone?: string; email?: string }
  args: {
    lines: {
      type: "fee"
      description: string
      amount: string
      quantity: number
    }[]
    currency: string
    total: string
    hub_invoice_id: string
    note: string
  }
}

/**
 * The `order.invoice` body for a hub invoice: every hub line is an untaxed
 * fee (the hub has no product catalog), `total` makes the site cancel an order
 * whose total it would compute differently (tax), `currency` makes it refuse
 * another store currency. Throws a non-retryable provider error for a shape
 * the site would refuse anyway.
 */
export function orderInvoiceRequest(props: {
  invoice: InvoiceModel
  lines: InvoiceLineItemModel[]
  contact: { phoneNumber: string | null; email: string | null }
}): OrderInvoiceRequest {
  const { invoice, contact } = props
  if (!(contact.phoneNumber || contact.email)) {
    throw new InvoiceProviderError(
      "The contact has no phone number or email: WooCommerce bills the order to one",
      false,
    )
  }
  const limit = parseMoneyToMinor(
    String(WOOCOMMERCE_MAX_LINE_AMOUNT),
    invoice.currency,
  )
  const lines = [...props.lines]
    .sort((a, b) => a.position - b.position)
    .map((line, index) => {
      const amount = parseMoneyToMinor(line.amount, invoice.currency)
      if (limit === null || amount === null || amount > limit) {
        throw new InvoiceProviderError(
          `Line ${index + 1}: WooCommerce takes at most ${WOOCOMMERCE_MAX_LINE_AMOUNT} per line`,
          false,
        )
      }
      return {
        type: "fee" as const,
        description:
          line.description.length > WOOCOMMERCE_MAX_DESCRIPTION
            ? `${line.description.slice(0, WOOCOMMERCE_MAX_DESCRIPTION - 1)}…`
            : line.description,
        amount: line.unitAmount,
        quantity: line.quantity,
      }
    })
  return {
    contact: {
      ...(contact.phoneNumber ? { phone: contact.phoneNumber } : {}),
      ...(contact.email ? { email: contact.email } : {}),
    },
    args: {
      lines,
      currency: invoice.currency,
      total: invoice.total,
      hub_invoice_id: invoice.id,
      note: `Hub invoice #${invoice.number}`,
    },
  }
}

export type OpenedWooCommerceOrder = {
  orderId: string
  payUrl: string
}

/** Refusals a retry of the SAME request can cure. */
const RETRYABLE_CODES = new Set(["in-progress", "rate-limited", "error"])

function refusal(answer: SiteAnswer): InvoiceProviderError {
  const retryable =
    answer.status >= 500 ||
    answer.status === 429 ||
    RETRYABLE_CODES.has(siteErrorCode(answer))
  return new InvoiceProviderError(
    `WooCommerce refused the order: ${siteErrorMessage(answer)}`,
    retryable,
  )
}

/**
 * Create (or, on a retry, replay) the site's pending order for a hub invoice.
 * The answer must name the invoice, its currency and its total: an order the
 * hub did not agree to is reported with its id so it can be cancelled there.
 */
export async function createWooCommerceOrder(props: {
  credentials: WooCommerceCredentials
  invoice: InvoiceModel & { lineItems: InvoiceLineItemModel[] }
}): Promise<OpenedWooCommerceOrder> {
  const { credentials, invoice } = props
  const [contact] = await db
    .select({
      phoneNumber: contactModel.phoneNumber,
      email: contactModel.email,
    })
    .from(contactModel)
    .where(eq(contactModel.id, invoice.contactId))
    .limit(1)
  const body = orderInvoiceRequest({
    invoice,
    lines: invoice.lineItems,
    contact: contact ?? { phoneNumber: null, email: null },
  })
  let answer: SiteAnswer
  try {
    answer = await postSiteAction({
      siteUrl: credentials.siteUrl,
      token: credentials.auth.actionToken,
      action: "order.invoice",
      body,
      idempotencyKey: wooCommerceIdempotencyKey(invoice.id),
    })
  } catch (error) {
    if (error instanceof SiteUnreachableError) {
      throw new InvoiceProviderError(error.message, true)
    }
    throw error
  }
  const data = answer.body
  if (answer.status !== 200 || data?.ok !== true) {
    throw refusal(answer)
  }
  const orderId = String(data.order_id ?? "")
  const payUrl = typeof data.pay_url === "string" ? data.pay_url : ""
  if (!(ORDER_ID.test(orderId) && payUrl.startsWith("https://"))) {
    throw new InvoiceProviderError(
      `WooCommerce answered without an order id or an https pay link (${siteErrorMessage(answer)})`,
      false,
    )
  }
  const currency = String(data.currency ?? "").toUpperCase()
  const total = parseMoneyToMinor(String(data.total ?? ""), invoice.currency)
  if (
    currency !== invoice.currency ||
    total === null ||
    total !== parseMoneyToMinor(invoice.total, invoice.currency) ||
    String(data.hub_invoice_id ?? "") !== invoice.id
  ) {
    throw new InvoiceProviderError(
      `WooCommerce order ${orderId} does not match this invoice (${String(data.total)} ${currency}): cancel it on ${credentials.siteSlug}`,
      false,
    )
  }
  return { orderId, payUrl }
}
