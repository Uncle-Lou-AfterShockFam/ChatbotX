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

/**
 * `Invoice.providerInvoiceId` of a WooCommerce order: `wc:<site origin>:<id>`,
 * unique across sites and stable across a disconnect + reconnect (the
 * integration id is not).
 */
export const wooCommerceProviderInvoiceId = (
  siteUrl: string,
  orderId: string | number,
): string => `wc:${siteUrl}:${orderId}`

/** The order id of a `wc:` provider id (the origin itself holds colons). */
export const wooCommerceOrderIdOf = (
  providerInvoiceId: string | null,
): string | null => {
  if (!providerInvoiceId?.startsWith("wc:")) {
    return null
  }
  const id = providerInvoiceId.slice(providerInvoiceId.lastIndexOf(":") + 1)
  return ORDER_ID.test(id) ? id : null
}

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

/**
 * The site's order in an answer: a fresh `invoiced` one, or the live order a
 * `hub-invoice-exists` refusal names (the first answer was lost or its key
 * expired). Null when the answer names none.
 */
function orderOf(data: Record<string, unknown> | null) {
  const orderId = String(data?.order_id ?? "")
  const payUrl = typeof data?.pay_url === "string" ? data.pay_url : ""
  return ORDER_ID.test(orderId) && payUrl.startsWith("https://")
    ? { orderId, payUrl }
    : null
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
  const post = async (idempotencyKey: string) => {
    try {
      return await postSiteAction({
        siteUrl: credentials.siteUrl,
        token: credentials.auth.actionToken,
        action: "order.invoice",
        body,
        idempotencyKey,
      })
    } catch (error) {
      if (error instanceof SiteUnreachableError) {
        throw new InvoiceProviderError(error.message, true)
      }
      throw error
    }
  }
  const key = wooCommerceIdempotencyKey(invoice.id)
  let answer = await post(key)
  if (
    answer.status === 409 &&
    siteErrorCode(answer) === "idempotency-mismatch"
  ) {
    // The body changed since the first attempt (the contact's phone or
    // email): a fresh key reaches the order check, which names the live
    // order of this invoice if the first attempt created one.
    answer = await post(`${key}:2`)
  }
  const data = answer.body
  const adopted =
    answer.status === 409 && siteErrorCode(answer) === "hub-invoice-exists"
  if (!(adopted || (answer.status === 200 && data?.ok === true))) {
    throw refusal(answer)
  }
  const order = orderOf(data)
  if (!(order && data)) {
    throw new InvoiceProviderError(
      `WooCommerce answered without an order id or an https pay link (${siteErrorMessage(answer)})`,
      false,
    )
  }
  const { orderId, payUrl } = order
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

/** The site-side Idempotency-Key of an invoice's `order.cancel` (0.7.0). */
export const wooCommerceCancelKey = (invoiceId: string): string =>
  `${wooCommerceIdempotencyKey(invoiceId)}:cancel`

export type WooCommerceCancelOutcome =
  /** The order is cancelled on the site (now, or already). */
  | { kind: "cancelled" }
  /** The site holds a payment for it: the hub must not void. */
  | { kind: "paid"; orderStatus: string }
  /** No verdict (site down, a pre-0.7.0 plugin, a revoked token, ...). */
  | { kind: "failed"; reason: string }

/**
 * Ask the site to cancel the pending order of a voided hub invoice
 * (hub-connector `order.cancel`). Never throws: every answer but `cancelled`
 * and `order-paid` is a `failed` the caller reports for a human.
 */
export async function cancelWooCommerceOrder(props: {
  credentials: WooCommerceCredentials
  invoice: Pick<InvoiceModel, "id" | "number">
  orderId: string
}): Promise<WooCommerceCancelOutcome> {
  const { credentials, invoice, orderId } = props
  let answer: SiteAnswer
  try {
    answer = await postSiteAction({
      siteUrl: credentials.siteUrl,
      token: credentials.auth.actionToken,
      action: "order.cancel",
      body: {
        subject: { type: "order", id: orderId },
        args: {
          hub_invoice_id: invoice.id,
          reason: `Hub invoice #${invoice.number} voided`,
        },
      },
      idempotencyKey: wooCommerceCancelKey(invoice.id),
    })
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "request failed",
    }
  }
  if (answer.status === 200 && answer.body?.ok === true) {
    return { kind: "cancelled" }
  }
  if (answer.status === 409 && siteErrorCode(answer) === "order-paid") {
    return {
      kind: "paid",
      orderStatus: String(answer.body?.order_status ?? "paid"),
    }
  }
  return { kind: "failed", reason: siteErrorMessage(answer) }
}
