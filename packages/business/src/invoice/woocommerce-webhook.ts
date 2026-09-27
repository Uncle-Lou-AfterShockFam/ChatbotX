import { createHmac, timingSafeEqual } from "node:crypto"
import { and, db, eq, isNull, or } from "@chatbotx.io/database/client"
import type { InvoiceStatus } from "@chatbotx.io/database/partials"
import { invoiceEventModel, invoiceModel } from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { emitInvoicePaid } from "@chatbotx.io/events"
import { integrationWooCommerceService } from "../integration-woocommerce/service"
import { logger } from "../logger"
import { markInvoiceOnContact } from "./contact-marks"
import { invoiceEventMetadata, invoiceService } from "./service"
import { wooCommerceProviderInvoiceId } from "./woocommerce-provider"

/** hub-connector signs with a fresh timestamp per attempt (Standard Webhooks). */
export const WOOCOMMERCE_WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * The answer, in hub-connector's `reason` vocabulary (Worker::classify):
 * `applied` / `duplicate` / `captured` end the outbox row, `hub-error` makes
 * the site retry the SAME event id, `unverified` / `invalid:*` dead-letter it.
 */
export type WooCommerceWebhookReason =
  | "applied"
  | "duplicate"
  | "captured"
  | "hub-error"
  | "unverified"
  | "invalid:envelope"

export type WooCommerceWebhookResult = {
  reason: WooCommerceWebhookReason
  detail: string
}

const TARGET: Record<string, InvoiceStatus> = {
  "order.paid": "paid",
  "order.refunded": "refunded",
}

const ID = /^[1-9]\d{0,19}$/
const EVENT_ID = /^[A-Za-z0-9_-]{1,120}$/
const TIMESTAMP = /^\d{1,12}$/

/**
 * Standard Webhooks: `v1,<base64 HMAC-SHA256(key, "{id}.{ts}.{body}")>`,
 * several space-separated signatures allowed, key = the base64 after `whsec_`.
 */
export function verifyStandardWebhook(props: {
  secret: string
  id: string | null
  timestamp: string | null
  signature: string | null
  rawBody: Buffer
  nowSeconds: number
}): boolean {
  const { id, timestamp, signature } = props
  if (!(id && timestamp && signature && TIMESTAMP.test(timestamp))) {
    return false
  }
  if (
    Math.abs(props.nowSeconds - Number(timestamp)) >
    WOOCOMMERCE_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false
  }
  const key = Buffer.from(props.secret.slice("whsec_".length), "base64")
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(props.rawBody)
    .digest()
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",", 2)
    if (version !== "v1" || !value) {
      return false
    }
    const given = Buffer.from(value, "base64")
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

type OrderEnvelope = {
  id: string
  event: string
  orderId: string
  hubInvoiceId: string
}

/** The fields the hub reads from a hub-connector/1 order envelope, or null. */
export function parseOrderEnvelope(rawBody: Buffer): OrderEnvelope | null {
  let data: unknown
  try {
    data = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null
  }
  const envelope = data as Record<string, unknown>
  const subject = envelope.subject as Record<string, unknown> | undefined
  const fields = envelope.fields as Record<string, unknown> | undefined
  if (
    envelope.spec !== "hub-connector/1" ||
    typeof envelope.id !== "string" ||
    !EVENT_ID.test(envelope.id) ||
    typeof envelope.event !== "string"
  ) {
    return null
  }
  return {
    id: envelope.id,
    event: envelope.event,
    orderId:
      subject?.type === "order" && typeof subject.id === "string"
        ? subject.id
        : "",
    hubInvoiceId:
      typeof fields?.hub_invoice_id === "string" ? fields.hub_invoice_id : "",
  }
}

/**
 * The invoice this order collects: named by the envelope AND bound to this
 * site's order (or still a draft of this site whose finalize never recorded
 * the order id: a crash between the site's answer and the draft CAS).
 */
async function findInvoice(props: {
  workspaceId: string
  integrationId: string
  hubInvoiceId: string
  orderId: string
}): Promise<InvoiceModel | null> {
  const [row] = await db
    .select()
    .from(invoiceModel)
    .where(
      and(
        eq(invoiceModel.id, props.hubInvoiceId),
        eq(invoiceModel.workspaceId, props.workspaceId),
        eq(invoiceModel.integrationId, props.integrationId),
        eq(invoiceModel.method, "woocommerce"),
        or(
          eq(
            invoiceModel.providerInvoiceId,
            wooCommerceProviderInvoiceId(props.integrationId, props.orderId),
          ),
          and(
            isNull(invoiceModel.providerInvoiceId),
            eq(invoiceModel.status, "draft"),
          ),
        ),
      ),
    )
    .limit(1)
  return row ?? null
}

async function dropDedupRow(integrationId: string, eventId: string) {
  try {
    await db
      .delete(invoiceEventModel)
      .where(
        and(
          eq(invoiceEventModel.integrationId, integrationId),
          eq(invoiceEventModel.providerEventId, eventId),
        ),
      )
  } catch (error) {
    logger.error(
      { err: error, eventId },
      "woocommerce webhook: dedup row not removed; this event's redelivery will be skipped",
    )
  }
}

/**
 * A linked site's `order.paid` / `order.refunded` (hub-connector >= 0.6.0,
 * HUBC_HUB_URL). Verified with THAT site's hub-generated secret before
 * anything is parsed; one InvoiceEvent per (site, envelope id) is the dedup,
 * written in the transaction that moves the invoice. A payment of an invoice
 * voided here is recorded and flagged, never applied.
 */
export async function handleWooCommerceWebhook(props: {
  integrationId: string
  rawBody: Buffer
  headers: {
    id: string | null
    timestamp: string | null
    signature: string | null
  }
  nowSeconds?: number
}): Promise<WooCommerceWebhookResult> {
  const credentials =
    await integrationWooCommerceService.credentialsByIntegrationId(
      props.integrationId,
    )
  // An unknown site and a bad signature answer the same: no id oracle.
  if (
    !(
      credentials &&
      verifyStandardWebhook({
        secret: credentials.auth.webhookSecret,
        ...props.headers,
        rawBody: props.rawBody,
        nowSeconds: props.nowSeconds ?? Math.floor(Date.now() / 1000),
      })
    )
  ) {
    return { reason: "unverified", detail: "signature" }
  }
  const envelope = parseOrderEnvelope(props.rawBody)
  if (!envelope || envelope.id !== props.headers.id) {
    return {
      reason: "invalid:envelope",
      detail: "not a hub-connector/1 envelope",
    }
  }
  const target = TARGET[envelope.event]
  if (!target) {
    return { reason: "captured", detail: `ignored ${envelope.event}` }
  }
  if (!(ID.test(envelope.orderId) && ID.test(envelope.hubInvoiceId))) {
    return { reason: "captured", detail: "not a hub invoice's order" }
  }

  const invoice = await findInvoice({
    workspaceId: credentials.workspaceId,
    integrationId: credentials.integrationId,
    hubInvoiceId: envelope.hubInvoiceId,
    orderId: envelope.orderId,
  })
  if (!invoice) {
    // No dedup row: this site's event id must stay usable for a delivery
    // that CAN match (the dedup is per site, and the id is per order).
    logger.warn(
      {
        integrationId: credentials.integrationId,
        eventId: envelope.id,
        hubInvoiceId: envelope.hubInvoiceId,
      },
      "woocommerce webhook: no invoice of this site collects this order",
    )
    return { reason: "captured", detail: "no matching invoice" }
  }
  let applied: InvoiceModel | null = null
  let inserted = false
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invoiceEventModel)
        .values({
          workspaceId: credentials.workspaceId,
          integrationId: credentials.integrationId,
          invoiceId: invoice.id,
          providerEventId: envelope.id,
          type: envelope.event,
          outcome: "received",
        })
        .onConflictDoNothing()
        .returning({ id: invoiceEventModel.id })
      inserted = !!row
      if (!row) {
        return
      }
      const orderRef = wooCommerceProviderInvoiceId(
        credentials.integrationId,
        envelope.orderId,
      )
      applied = await invoiceService.transition({
        invoiceId: invoice.id,
        to: target,
        set:
          target === "paid"
            ? { paidAt: new Date(), providerInvoiceId: orderRef }
            : {},
        tx,
      })
      if (!applied && target === "paid" && invoice.status === "void") {
        await tx
          .update(invoiceEventModel)
          .set({ outcome: "paid-after-void", updatedAt: new Date() })
          .where(eq(invoiceEventModel.id, row.id))
        await tx
          .update(invoiceModel)
          .set({
            lastError: `Paid on ${credentials.siteSlug} (order ${envelope.orderId}) after it was voided here: refund it in WooCommerce`,
            updatedAt: new Date(),
          })
          .where(eq(invoiceModel.id, invoice.id))
      }
    })
  } catch (error) {
    logger.error(
      { err: error, eventId: envelope.id },
      "woocommerce webhook: write failed",
    )
    return { reason: "hub-error", detail: "database" }
  }
  if (!inserted) {
    return { reason: "duplicate", detail: envelope.id }
  }

  // A fresh event whose target the invoice already holds re-runs the marks:
  // the only way there is a redelivery after a failed mark attempt.
  const current: InvoiceModel = applied ?? invoice
  if (applied || invoice.status === target) {
    try {
      await markInvoiceOnContact({ invoice: current, status: target })
      if (target === "paid") {
        await emitInvoicePaid(
          current.workspaceId,
          current.contactId,
          invoiceEventMetadata(current),
        )
      }
    } catch (error) {
      await dropDedupRow(credentials.integrationId, envelope.id)
      logger.warn(
        { err: error, eventId: envelope.id, invoiceId: invoice.id },
        "woocommerce webhook: contact marks failed, asking the site to redeliver",
      )
      return { reason: "hub-error", detail: "contact marks" }
    }
  }
  return {
    reason: applied ? "applied" : "captured",
    detail: `${envelope.event} invoice ${invoice.id}`,
  }
}
